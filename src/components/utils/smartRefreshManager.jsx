// lightweightRefreshManager.js - Lightweight refresh manager for WebSocket-driven data
// CRITICAL: AppUser, Delivery, Patient rely on WebSocket subscriptions for real-time updates
// This manager handles: initial loads, offline sync, cache reconciliation, and non-real-time entities

import { base44 } from "@/api/base44Client";
import { diffEntityArrays, mergeEntityChanges, getLatestUpdateTimestamp } from "./dataDiffer";
import { format } from "date-fns";
import { queueEntityRequest } from "./requestQueue";
import { touchUserCache } from "./auth";
import { globalFilters } from "./globalFilters";

const shouldAutoCenterNextDeliveryFromSmartRefresh = (deliveries = [], selectedDriverId = 'all', currentUser = null) => {
  if (!Array.isArray(deliveries) || deliveries.length === 0 || !currentUser) return false;
  if (!selectedDriverId || selectedDriverId === 'all') return false;

  const roles = Array.isArray(currentUser.app_roles) ? currentUser.app_roles : [];
  const isDispatcher = roles.includes('dispatcher');
  const isViewingOwnRoute = selectedDriverId === currentUser.id || selectedDriverId === currentUser.user_id;

  if (!isDispatcher && isViewingOwnRoute) return false;
  if (isViewingOwnRoute) return false;

  return deliveries.some((delivery) => delivery?.driver_id === selectedDriverId && delivery?.isNextDelivery === true);
};

class LightweightRefreshManager {
  constructor() {
    this._enabled = true;
    this._initialized = false;
    this._paused = false;
    this._currentUser = null;

    // Track last WebSocket update timestamp for conditional polling
    this.lastWebSocketAppUserUpdate = 0;
    this.WEBSOCKET_FRESHNESS_THRESHOLD = 30000; // 30 seconds
    // Driver locations fallback/backoff
    this.driverRefreshBackoffMs = 0;
    this.driverNextAllowedAt = 0;

    // Minimal intervals - only for non-WebSocket entities and offline sync
    this.intervals = {
      cities: 1800000,       // 30min - Cities dataset (less frequent to avoid 429)
      stores: 1800000,       // 30min - Stores dataset (less frequent to avoid 429)
      appUsers: 60000,       // 60sec - Backup poll ONLY if no recent WebSocket update
      offlineSync: 0,        // DISABLED - offlineDB reads, not syncs
      cacheRefresh: 600000   // 10min - Cache consistency check
    };

    this.lastRefreshTimes = {
      cities: 0,
      stores: 0,
      appUsers: 0,
      offlineSync: 0,
      cacheRefresh: 0
    };

    // Listen for WebSocket AppUser updates to track freshness
    if (typeof window !== 'undefined') {
      window.addEventListener('realtimeUpdate_AppUser', () => {
        this.lastWebSocketAppUserUpdate = Date.now();
        console.log('📡 [SmartRefresh] WebSocket AppUser update received - timestamp updated');
      });
    }

    // Rate limiting - increased to prevent 429 errors
    this.lastApiCallTime = 0;
    this.minTimeBetweenCalls = 3000;  // 3 seconds between API calls
    this.consecutiveErrors = 0;
    this.maxConsecutiveErrors = 1;
    this.errorCooldownUntil = 0;
    this.rateLimitDetected = false;

    // Pending mutations tracking
    this.pendingLocalUpdates = new Map();
    this.pendingPatientUpdates = new Map();
    this.pendingAppUserUpdates = new Map();

    // Deleted ID tracking
    this.deletedDeliveryIds = new Set();
    this.deletedPatientIds = new Set();

    this.isRefreshing = false;
    this.refreshCallbacks = new Set();
    this.lastTrackedRefreshAt = 0;
  }

  /**
   * Initialize from settings and load ALL AppUsers to offline DB on startup
   */
  async initializeFromSettings() {
    try {
      const settings = await base44.entities.AppSettings.filter({ setting_key: 'refresh_intervals' });
      if (settings && settings.length > 0 && settings[0].setting_value) {
        this._enabled = settings[0].setting_value.smartRefreshEnabled !== false;
      } else {
        this._enabled = true;
      }
      
      // CRITICAL: Load ALL AppUsers to offline DB on app startup
      await this.initializeAllAppUsersToOfflineDB();
      
      this._initialized = true;
      return this._enabled;
    } catch (error) {
      console.warn('⚠️ [LightweightRefresh] Error loading settings:', error);
      this._enabled = true;
      this._initialized = true;
      return true;
    }
  }
  
  /**
   * Initialize current user to offline DB on app startup
   * CRITICAL: AppUser.list() has RLS filtering - WebSocket subscriptions will sync all other users
   */
  async initializeAllAppUsersToOfflineDB() {
    try {
      const { offlineDB } = await import('./offlineDatabase');

      // Fetch current user and save to offline DB
      // AppUser.list() uses RLS so will only return current user on startup
      console.log('📥 [SmartRefresh] Loading current user to offline DB on startup...');
      await this.waitForRateLimit();

      const currentAppUsers = await queueEntityRequest(
        () => base44.entities.AppUser.list(),
        'Current user load'
      );

      if (currentAppUsers && currentAppUsers.length > 0) {
        await offlineDB.bulkSave(offlineDB.STORES.APP_USERS, currentAppUsers);
        await offlineDB.updateSyncMetadata('AppUser', new Date().toISOString());
        console.log(`✅ [SmartRefresh] Synced offline DB with current user. WebSocket will sync other users.`);
        this.recordSuccess();
      } else {
        console.warn('⚠️ [SmartRefresh] No current user AppUser record found');
      }
    } catch (error) {
      console.warn('⚠️ [SmartRefresh] Failed to initialize current user:', error.message);
      this.recordError();
    }
  }

  /**
   * Pause refresh during mutations
   */
  pause() {
    console.log('⏸️ [LightweightRefresh] Paused for mutations');
    this._paused = true;
  }

  /**
   * Resume refresh after mutations
   */
  resume() {
    console.log('▶️ [LightweightRefresh] Resumed after mutations');
    this._paused = false;
    this.isRefreshing = false;
  }

  /**
   * Check if paused
   */
  isPaused() {
    return this._paused;
  }

  /**
   * Restart refresh timers
   */
  restart(specificEntityType = null) {
    if (specificEntityType) {
      console.log(`🔄 [LightweightRefresh] Restarting ${specificEntityType} refresh timer`);
      this.lastRefreshTimes[specificEntityType] = 0;
    } else {
      console.log('🔄 [LightweightRefresh] Restarting all refresh timers');
      this.lastRefreshTimes = {
        cities: 0,
        stores: 0,
        appUsers: 0,
        offlineSync: 0,
        cacheRefresh: 0
      };
      this._paused = false;
    }
  }

  /**
   * Register pending local updates to protect from refresh overwrites
   */
  registerPendingUpdate(deliveryId, driverId = null, deliveryDate = null) {
    const expiresAt = Date.now() + 30000;
    this.pendingLocalUpdates.set(deliveryId, { expiresAt, driverId, deliveryDate });
  }

  /**
   * Check if delivery has pending update
   */
  hasPendingUpdate(deliveryId) {
    const entry = this.pendingLocalUpdates.get(deliveryId);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      this.pendingLocalUpdates.delete(deliveryId);
      return false;
    }
    return true;
  }

  /**
   * Clear pending updates
   */
  clearPendingUpdates() {
    this.pendingLocalUpdates.clear();
  }

  /**
   * Register pending patient update
   */
  registerPendingPatientUpdate(patientId) {
    const expiresAt = Date.now() + 60000;
    this.pendingPatientUpdates.set(patientId, { expiresAt });
  }

  /**
   * Check if patient has pending update
   */
  hasPendingPatientUpdate(patientId) {
    const entry = this.pendingPatientUpdates.get(patientId);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      this.pendingPatientUpdates.delete(patientId);
      return false;
    }
    return true;
  }

  /**
   * Register pending AppUser update
   */
  registerPendingAppUserUpdate(appUserId, field = 'driver_status') {
    const expiresAt = Date.now() + 10000;
    this.pendingAppUserUpdates.set(appUserId, { expiresAt, field });
  }

  /**
   * Check if AppUser has pending update
   */
  hasPendingAppUserUpdate(appUserId) {
    const entry = this.pendingAppUserUpdates.get(appUserId);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      this.pendingAppUserUpdates.delete(appUserId);
      return false;
    }
    return true;
  }

  /**
   * Wait for rate limit - non-blocking with dynamic check
   */
  async waitForRateLimit() {
    const now = Date.now();
    let waitTime = 0;

    // Check error cooldown
    if (now < this.errorCooldownUntil) {
      waitTime = Math.max(waitTime, this.errorCooldownUntil - now);
    }

    // Check API call spacing
    const timeSinceLastCall = now - this.lastApiCallTime;
    if (timeSinceLastCall < this.minTimeBetweenCalls) {
      waitTime = Math.max(waitTime, this.minTimeBetweenCalls - timeSinceLastCall);
    }

    // Non-blocking wait with small timeout chunks (100ms max)
    if (waitTime > 0) {
      const chunkSize = Math.min(100, waitTime);
      await new Promise(resolve => setTimeout(resolve, chunkSize));
    }

    this.lastApiCallTime = Date.now();
  }

  /**
   * Record error for backoff
   */
  recordError(error) {
    // Check for rate limit
    if (error?.message?.includes('429') || error?.status === 429) {
      this.rateLimitDetected = true;
      this.errorCooldownUntil = Date.now() + 120000; // 2 minute pause on 429
      console.warn(`🛑 [LightweightRefresh] Rate limit detected - pausing all refreshes for 2 minutes`);
      this.consecutiveErrors = 0;
    } else {
      this.consecutiveErrors++;
      if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
        this.errorCooldownUntil = Date.now() + 60000;
        console.warn(`🛑 [LightweightRefresh] ${this.consecutiveErrors} errors - cooldown 60s`);
        this.consecutiveErrors = 0;
      }
    }
  }

  /**
   * Record successful call
   */
  recordSuccess() {
    if (this.consecutiveErrors > 0) {
      console.log(`✅ [LightweightRefresh] Success - resetting error counter`);
      this.consecutiveErrors = 0;
    }
  }

  /**
   * Check if enough time has passed for refresh
   */
  shouldRefresh(type) {
    const now = Date.now();
    const lastRefresh = this.lastRefreshTimes[type] || 0;
    const interval = this.intervals[type] || 300000;
    return (now - lastRefresh) >= interval;
  }

  /**
   * Mark refresh as completed
   */
  markRefreshed(type) {
    this.lastRefreshTimes[type] = Date.now();
  }

  /**
   * Subscribe to refresh events
   */
  subscribe(callback) {
    this.refreshCallbacks.add(callback);
    return () => this.refreshCallbacks.delete(callback);
  }

  /**
   * Notify subscribers
   */
  notifySubscribers(updates) {
    this.refreshCallbacks.forEach(callback => callback(updates));
    if (typeof window !== 'undefined' && updates) {
      window.dispatchEvent(new CustomEvent('lightweightRefreshComplete', {
        detail: { updates }
      }));
    }
  }

  /**
   * Set current user
   */
  setCurrentUser(user) {
    this._currentUser = user;
  }

  /**
   * Handle broadcast refresh - reset timer only, no polling
   */
  async handleBroadcastRefresh(entityName, operation, metadata = {}) {
    console.log(`📡 [LightweightRefresh] Broadcast: ${entityName} ${operation}`);

    // Track deletions
    if (operation === 'delete' && metadata?.id) {
      if (entityName === 'Delivery') {
        this.deletedDeliveryIds.add(metadata.id);
      } else if (entityName === 'Patient') {
        this.deletedPatientIds.add(metadata.id);
      }
    }

    // Reset timer for offline sync to reconcile quickly
    this.lastRefreshTimes.offlineSync = 0;
  }

  /**
   * Check if entity was deleted
   */
  isDeliveryDeleted(deliveryId) {
    return this.deletedDeliveryIds.has(deliveryId);
  }

  /**
   * Check if patient was deleted
   */
  isPatientDeleted(patientId) {
    return this.deletedPatientIds.has(patientId);
  }

  /**
   * LIGHTWEIGHT: Sync Cities + Stores every 5 minutes
   * AppUser syncs every 15 seconds as backup for WebSocket
   * These don't have real-time subscriptions, so periodic refresh is needed
   */
  async performLightweightRefresh(currentData) {
    if (!this._enabled || this._paused || this.isRefreshing) {
      return null;
    }

    try {
      touchUserCache();
    } catch (e) {
      // Ignore
    }

    // Global cooldown guard: if we're within error cooldown window, skip this cycle entirely
    const __now = Date.now();
    if (__now < (this.errorCooldownUntil || 0)) {
      return null;
    }

    this.isRefreshing = true;
    const updates = {};

    try {
      // Refresh Cities every 5 minutes
      if (this.shouldRefresh('cities') && currentData.cities) {
        try {
          console.log('🏙️ [LightweightRefresh] Syncing Cities (every 5min)');
          await this.waitForRateLimit();
          const allCities = await queueEntityRequest(
            () => base44.entities.City.list(),
            'City list'
          );

          this.recordSuccess();

          if (allCities && allCities.length > 0) {
            const diff = diffEntityArrays(currentData.cities, allCities);
            if (diff.toUpdate.length > 0 || diff.toAdd.length > 0) {
              updates.cities = mergeEntityChanges(currentData.cities, diff);
              console.log(`✅ [LightweightRefresh] Cities updated: +${diff.toAdd.length} ~${diff.toUpdate.length}`);
            }
          }
          this.markRefreshed('cities');
        } catch (e) {
          this.recordError(e);
          console.warn('⚠️ [LightweightRefresh] Cities refresh failed:', e.message);
        }
      }

      // Refresh Stores every 5 minutes
      if (this.shouldRefresh('stores') && currentData.stores) {
        try {
          console.log('🏪 [LightweightRefresh] Syncing Stores (every 5min)');
          await this.waitForRateLimit();
          const allStores = await queueEntityRequest(
            () => base44.entities.Store.list(),
            'Store list'
          );

          this.recordSuccess();

          if (allStores && allStores.length > 0) {
            const diff = diffEntityArrays(currentData.stores, allStores);
            if (diff.toUpdate.length > 0 || diff.toAdd.length > 0) {
              updates.stores = mergeEntityChanges(currentData.stores, diff);
              console.log(`✅ [LightweightRefresh] Stores updated: +${diff.toAdd.length} ~${diff.toUpdate.length}`);
            }
          }
          this.markRefreshed('stores');
        } catch (e) {
          this.recordError(e);
          console.warn('⚠️ [LightweightRefresh] Stores refresh failed:', e.message);
        }
      }

      // CRITICAL: Skip AppUser polling entirely - AppUser.list() has RLS rules and returns only current user
      // ONLY rely on WebSocket real-time subscriptions for cross-device AppUser syncing
      if (this.shouldRefresh('appUsers')) {
        console.log(`👥 [LightweightRefresh] Skipping AppUser API poll - WebSocket subscriptions handle all cross-device sync`);
        this.markRefreshed('appUsers');
      }

      // Offline sync reconciliation every 1 minute
      if (this.shouldRefresh('offlineSync')) {
        try {
          console.log('💾 [LightweightRefresh] Offline sync reconciliation');
          const { offlineDB } = await import('./offlineDatabase');
          
          // Verify offline DB consistency
          const offlineDeliveries = await offlineDB.getAll(offlineDB.STORES.DELIVERIES);
          const offlinePatients = await offlineDB.getAll(offlineDB.STORES.PATIENTS);
          const offlineAppUsers = await offlineDB.getAll(offlineDB.STORES.APP_USERS);

          console.log(`💾 [LightweightRefresh] Offline DB: ${offlineDeliveries?.length || 0} deliveries, ${offlinePatients?.length || 0} patients, ${offlineAppUsers?.length || 0} users`);
          
          this.markRefreshed('offlineSync');
        } catch (e) {
          console.warn('⚠️ [LightweightRefresh] Offline sync failed:', e.message);
        }
      }

      return Object.keys(updates).length > 0 ? updates : null;

    } catch (error) {
      console.warn('⚠️ [LightweightRefresh] Error during refresh:', error.message);
      return null;
    } finally {
      this.isRefreshing = false;
    }
  }

  /**
   * Clear pending updates for specific driver/date
   */
  clearPendingUpdatesForDriver(driverId, deliveryDate) {
    const keysToDelete = [];
    this.pendingLocalUpdates.forEach((value, key) => {
      if (value.driverId === driverId && value.deliveryDate === deliveryDate) {
        keysToDelete.push(key);
      }
    });
    keysToDelete.forEach(key => this.pendingLocalUpdates.delete(key));
    console.log(`🗑️ [SmartRefresh] Cleared ${keysToDelete.length} pending updates for driver ${driverId}`);
  }

  /**
   * Reset timers (called after status updates to prevent duplicate location polls)
   */
  resetTimers() {
    this.lastRefreshTimes.appUsers = Date.now();
    console.log('⏱️ [SmartRefresh] Reset appUsers timer to prevent immediate duplicate poll');
  }

  /**
   * Refresh driver locations - simplified for Dashboard usage
   */
  async refreshDriverLocations(currentAppUsers, forceNotify = false, currentPageName = null, selectedDate = null, immediate = false) {
    try {
      // Skip if paused
      if (this._paused && !immediate) {
        console.log('⏸️ [SmartRefresh] Paused - skipping location refresh');
        return { hasChanges: false, appUsers: currentAppUsers };
      }

      const now = Date.now();
      // WebSocket-first: if we've seen a realtime AppUser update in the last 60s, skip API poll
      if (!immediate && (now - this.lastWebSocketAppUserUpdate) < 60000) {
        console.log('🛰️ [SmartRefresh] WS fresh (<60s) — skipping AppUser API poll');
        return { hasChanges: false, appUsers: currentAppUsers };
      }

      // Enforce per-feature backoff window
      if (!immediate && now < (this.driverNextAllowedAt || 0)) {
        const waitMs = (this.driverNextAllowedAt || 0) - now;
        console.log(`⏳ [SmartRefresh] Driver refresh backoff ${Math.ceil(waitMs/1000)}s remaining`);
        return { hasChanges: false, appUsers: currentAppUsers };
      }

      console.log('📍 [SmartRefresh] Skipping fallback AppUser API poll - using offline/WebSocket data only');
      return { hasChanges: false, appUsers: currentAppUsers };
    } catch (error) {
     base44.analytics.track({
       eventName: "driver_location_refresh_run",
       properties: {
         success: false,
         force_notify: Boolean(forceNotify),
         immediate: Boolean(immediate)
       }
     });
     this.recordError(error);
     // Exponential backoff: 1m → 2m → 5m, reset on success
     const next = this.driverRefreshBackoffMs === 0 ? 60000 : (this.driverRefreshBackoffMs === 60000 ? 120000 : 300000);
     this.driverRefreshBackoffMs = next;
     this.driverNextAllowedAt = Date.now() + next;
     console.warn(`⚠️ [SmartRefresh] Location refresh failed (${error.message}). Backing off ${Math.round(next/1000)}s`);
     return { hasChanges: false, appUsers: currentAppUsers };
    }
  }

  /**
   * Perform smart refresh - main method called by Dashboard
   * CRITICAL: Reads from offline DB, NOT API - WebSocket subscriptions keep offline DB in sync
   */
  async performSmartRefresh(currentData, filters, isEntityUpdating, showAllDrivers, currentPage, selectedDate) {
    // CRITICAL: Guard against undefined parameters
    if (!currentData || !filters || !currentPage) {
      console.warn('⚠️ [SmartRefresh] Missing required parameters - skipping refresh');
      return null;
    }
    
    // CRITICAL: Skip if paused
    if (this._paused) {
      return null;
    }
    
    const updates = {};
    
    try {
      const { offlineDB } = await import('./offlineDatabase');
      
      // STEP 1: Read deliveries from offline DB for selected date
      // TEMPORARILY DISABLED - Testing WebSocket real-time sync
      /*
          if (filters.deliveryFilter?.delivery_date) {
            const deliveryDate = filters.deliveryFilter.delivery_date;
            console.log(`📦 [SmartRefresh] Reading deliveries for ${deliveryDate} from offline DB...`);

            const offlineDeliveries = await offlineDB.getAll(offlineDB.STORES.DELIVERIES);
            const dateDeliveries = (offlineDeliveries || []).filter(d => d.delivery_date === deliveryDate);

            if (dateDeliveries.length > 0) {
              console.log(`✅ [SmartRefresh] Found ${dateDeliveries.length} deliveries in offline DB`);
              // CRITICAL: Full replacement to remove stale/deleted polylines and elements
              updates.deliveries = dateDeliveries;
              updates.isFullReplacementDeliveries = true;
            }
          }
      */
      
      // STEP 2: Read AppUsers from offline DB (WebSocket subscriptions keep this in sync)
      // TEMPORARILY DISABLED - Testing WebSocket real-time sync
      /*
      if (currentData.appUsers) {
        console.log(`👥 [SmartRefresh] Reading AppUsers from offline DB...`);
        
        const offlineAppUsers = await offlineDB.getAll(offlineDB.STORES.APP_USERS);
        
        if (offlineAppUsers && offlineAppUsers.length > 0) {
          console.log(`✅ [SmartRefresh] Found ${offlineAppUsers.length} AppUsers in offline DB`);
          updates.appUsers = offlineAppUsers;
        }
      }
      */
      
      // STEP 3: Perform lightweight refresh for other entities (Cities, Stores)
      const lightweightUpdates = await this.performLightweightRefresh(currentData);
      if (lightweightUpdates) {
        Object.assign(updates, lightweightUpdates);
      }

      // STEP 4: Refresh polyline rendering from offline DB during smart refresh
      await this.updatePolylines(currentData.appUsers || []);

      // STEP 5: Dashboard smart refresh must stay offline/WebSocket-first.
      // Do not pull server reconcile data here because it can reintroduce older route state
      // over the current offline route for the selected day.
      
      // CRITICAL: Never let partial/empty delivery refreshes clear a populated dashboard
      if (Array.isArray(updates.deliveries) && Array.isArray(currentData?.deliveries) && currentData.deliveries.length > 0 && updates.deliveries.length === 0) {
        delete updates.deliveries;
        delete updates.isFullReplacementDeliveries;
      }

      // STEP 5: Notify subscribers if we have updates
      if (Object.keys(updates).length > 0) {
        this.notifySubscribers(updates);

        // Dispatch smartRefreshComplete event with full replacement flags
        if (typeof window !== 'undefined') {
          // CRITICAL: Filter junk AppUser records before dispatching
          if (updates.appUsers) {
            updates.appUsers = updates.appUsers.filter(u => u?.user_id && u.user_id !== 'undefined');
          }
          window.dispatchEvent(new CustomEvent('smartRefreshComplete', {
            detail: { 
              updates,
              isFullReplacementDeliveries: updates.isFullReplacementDeliveries || false,
              preserveLocalState: true
            }
          }));

          const selectedDriverId = globalFilters.getSelectedDriverId();
          const deliveriesForCenterCheck = updates.deliveries || currentData.deliveries || [];
          if (shouldAutoCenterNextDeliveryFromSmartRefresh(deliveriesForCenterCheck, selectedDriverId, this._currentUser)) {
            console.log('🎯 [SmartRefresh] Auto-centering next delivery after smart refresh');
            window.dispatchEvent(new CustomEvent('collapseAllStopCards'));
            setTimeout(() => {
              window.dispatchEvent(new CustomEvent('centerNextDeliveryCard', {
                detail: {
                  source: 'smartRefreshManager',
                  selectedDriverId,
                  remoteOnly: false
                }
              }));
            }, 100);
          }
        }
      }
      
      return Object.keys(updates).length > 0 ? updates : null;
      
    } catch (error) {
      console.warn('⚠️ [SmartRefresh] Error during refresh:', error.message);
      return null;
    }
  }

  /**
   * Update polylines with fresh driver coordinates
   * Grabs current on-duty driver locations and sends them to render Type 1 polylines
   */
  async updatePolylines(currentAppUsers = []) {
    try {
      console.log('🗺️ [SmartRefresh] Updating polylines with fresh driver coordinates...');
      
      // Use offline DB only to avoid AppUser rate-limit polling
      const { offlineDB } = await import('./offlineDatabase');
      const [freshAppUsers, offlineType1Polylines] = await Promise.all([
        offlineDB.getAll(offlineDB.STORES.APP_USERS),
        offlineDB.getAll(offlineDB.STORES.DRIVER_ROUTE_POLYLINES)
      ]);
      
      if (!freshAppUsers || freshAppUsers.length === 0) {
        console.warn('⚠️ [SmartRefresh] No offline AppUsers found for polyline update');
        return null;
      }

      // Filter for on-duty drivers
      const onDutyDrivers = freshAppUsers.filter(user => 
        user.driver_status === 'on_duty' && user.current_latitude && user.current_longitude
      );

      console.log(`📍 [SmartRefresh] Found ${onDutyDrivers.length} on-duty drivers with valid coordinates`);
      console.log(`🛣️ [SmartRefresh] Found ${offlineType1Polylines?.length || 0} offline Type 1 polylines`);

      if (onDutyDrivers.length === 0 && (!offlineType1Polylines || offlineType1Polylines.length === 0)) {
        return null;
      }

      // Save to offline DB
      await offlineDB.bulkSave(offlineDB.STORES.APP_USERS, freshAppUsers);

      // Dispatch event with fresh coordinates and offline type 1 polylines for rendering
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('polylineUpdateTriggered', {
          detail: { 
            onDutyDrivers,
            freshAppUsers,
            offlineType1Polylines: offlineType1Polylines || [],
            timestamp: Date.now()
          }
        }));
        window.dispatchEvent(new CustomEvent('driverRoutePolylinesUpdated', {
          detail: {
            polylines: offlineType1Polylines || [],
            source: 'smartRefreshOfflineDB'
          }
        }));
      }

      console.log(`✅ [SmartRefresh] Polyline update dispatched with offline Type 1 polylines`);
      
      return { onDutyDrivers, freshAppUsers, offlineType1Polylines: offlineType1Polylines || [] };
    } catch (error) {
       this.recordError(error);
       console.warn('⚠️ [SmartRefresh] Polyline update failed:', error.message);
       return null;
     }
  }

  /**
   * Check if user's heartbeat is older than 1 minute and trigger pull-to-sync if needed
   */
  async checkHeartbeatAndSync() {
    try {
      // CRITICAL: Check if user activity monitor shows staleness
      const { userActivityMonitor } = await import('./userActivityMonitor');
      const idleDuration = userActivityMonitor.getIdleDuration();
      const oneMinute = 60 * 1000;
      
      if (idleDuration > oneMinute) {
        console.log(`⏱️ [HeartbeatCheck] User idle for ${Math.floor(idleDuration / 1000)}s - triggering pull-to-sync`);
        
        // Dispatch event to trigger pull-to-sync
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('triggerPullToSync', {
            detail: { 
              reason: 'heartbeat_stale',
              idleDuration: Math.floor(idleDuration / 1000)
            }
          }));
        }
        
        return true;
      } else {
        console.log(`✅ [HeartbeatCheck] User active within last ${Math.floor(idleDuration / 1000)}s - no sync needed`);
        return false;
      }
    } catch (error) {
      console.warn('⚠️ [HeartbeatCheck] Failed:', error.message);
      return false;
    }
  }

  /**
   * Get manager status
   */
  getStatus() {
    return {
      enabled: this._enabled,
      isRefreshing: this.isRefreshing,
      lastRefreshTimes: this.lastRefreshTimes,
      pendingUpdatesCount: this.pendingLocalUpdates.size
    };
  }

  // Receive realtime notifications from other modules
  notifyRealtimeUpdate(entityName) {
    if (entityName === 'AppUser') {
      this.lastWebSocketAppUserUpdate = Date.now();
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('realtimeUpdate_AppUser'));
      }
      console.log('📡 [SmartRefresh] Noted realtime AppUser update');
    }
  }

  notifyRealtimeDeliveryUpdate() {
    this._lastDeliveryWsUpdate = Date.now();
  }
}

export const smartRefreshManager = new LightweightRefreshManager();

// Export helper to make global instance accessible
if (typeof window !== 'undefined') {
  window.smartRefreshManager = smartRefreshManager;
}