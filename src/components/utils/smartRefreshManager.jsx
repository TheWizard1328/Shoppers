// lightweightRefreshManager.js - Lightweight refresh manager for WebSocket-driven data
// CRITICAL: AppUser, Delivery, Patient rely on WebSocket subscriptions for real-time updates
// This manager handles: initial loads, offline sync, cache reconciliation, and non-real-time entities

import { base44 } from "@/api/base44Client";
import { diffEntityArrays, mergeEntityChanges, getLatestUpdateTimestamp } from "./dataDiffer";
import { format } from "date-fns";
import { queueEntityRequest } from "./requestQueue";
import { touchUserCache } from "./auth";
import { globalFilters } from "./globalFilters";

class LightweightRefreshManager {
  constructor() {
    this._enabled = true;
    this._initialized = false;
    this._paused = false;
    this._currentUser = null;

    // Track last WebSocket update timestamp for conditional polling
    this.lastWebSocketAppUserUpdate = 0;
    this.WEBSOCKET_FRESHNESS_THRESHOLD = 30000; // 30 seconds

    // Minimal intervals - only for non-WebSocket entities and offline sync
    this.intervals = {
      cities: 300000,        // 5min - Full Cities dataset
      stores: 300000,        // 5min - Full Stores dataset
      appUsers: 15000,       // 15sec - Backup poll ONLY if no recent WebSocket update
      offlineSync: 0,        // DISABLED - offlineDB reads, not syncs
      cacheRefresh: 300000   // 5min - Cache consistency check
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

    // Rate limiting - relaxed for better perf
    this.lastApiCallTime = 0;
    this.minTimeBetweenCalls = 500;  // Reduced from 5000ms for faster cycles
    this.consecutiveErrors = 0;
    this.maxConsecutiveErrors = 2;
    this.errorCooldownUntil = 0;

    // Pending mutations tracking
    this.pendingLocalUpdates = new Map();
    this.pendingPatientUpdates = new Map();
    this.pendingAppUserUpdates = new Map();

    // Deleted ID tracking
    this.deletedDeliveryIds = new Set();
    this.deletedPatientIds = new Set();

    this.isRefreshing = false;
    this.refreshCallbacks = new Set();
  }

  /**
   * Initialize from settings
   */
  async initializeFromSettings() {
    try {
      const settings = await base44.entities.AppSettings.filter({ setting_key: 'refresh_intervals' });
      if (settings && settings.length > 0 && settings[0].setting_value) {
        this._enabled = settings[0].setting_value.smartRefreshEnabled !== false;
      } else {
        this._enabled = true;
      }
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
   * Wait for rate limit
   */
  async waitForRateLimit() {
    const now = Date.now();
    if (now < this.errorCooldownUntil) {
      const waitTime = this.errorCooldownUntil - now;
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    const timeSinceLastCall = now - this.lastApiCallTime;
    if (timeSinceLastCall < this.minTimeBetweenCalls) {
      await new Promise(resolve => setTimeout(resolve, this.minTimeBetweenCalls - timeSinceLastCall));
    }
    this.lastApiCallTime = Date.now();
  }

  /**
   * Record error for backoff
   */
  recordError() {
    this.consecutiveErrors++;
    if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
      this.errorCooldownUntil = Date.now() + 60000;
      console.warn(`🛑 [LightweightRefresh] ${this.consecutiveErrors} errors - cooldown 60s`);
      this.consecutiveErrors = 0;
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
          this.recordError();
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
          this.recordError();
          console.warn('⚠️ [LightweightRefresh] Stores refresh failed:', e.message);
        }
      }

      // CRITICAL: Smart AppUser refresh - only poll API if WebSocket hasn't updated recently
      if (this.shouldRefresh('appUsers') && currentData.appUsers) {
        try {
          const timeSinceWebSocket = Date.now() - this.lastWebSocketAppUserUpdate;
          const hasRecentWebSocketUpdate = timeSinceWebSocket < this.WEBSOCKET_FRESHNESS_THRESHOLD;

          if (hasRecentWebSocketUpdate) {
            // WebSocket is fresh - read from offline DB instead of API
            console.log(`👥 [LightweightRefresh] WebSocket fresh (${Math.round(timeSinceWebSocket / 1000)}s ago) - reading AppUsers from offline DB`);

            const { offlineDB } = await import('./offlineDatabase');
            const offlineAppUsers = await offlineDB.getAll(offlineDB.STORES.APP_USERS);

            if (offlineAppUsers && offlineAppUsers.length > 0) {
              const diff = diffEntityArrays(currentData.appUsers, offlineAppUsers);
              if (diff.toUpdate.length > 0 || diff.toAdd.length > 0) {
                updates.appUsers = mergeEntityChanges(currentData.appUsers, diff);
                console.log(`✅ [LightweightRefresh] AppUsers from offline DB: +${diff.toAdd.length} ~${diff.toUpdate.length}`);

                // CRITICAL: Only broadcast if we have actual appUsers data
                if (updates.appUsers && updates.appUsers.length > 0) {
                  window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
                    detail: { appUsers: updates.appUsers, fromSmartRefresh: true, fromOfflineDB: true }
                  }));
                }
              }
            }
          } else {
            // WebSocket stale or no updates - poll API as backup
            console.log(`👥 [LightweightRefresh] WebSocket stale (${Math.round(timeSinceWebSocket / 1000)}s) - polling API for AppUsers`);
            await this.waitForRateLimit();
            const allAppUsers = await queueEntityRequest(
              () => base44.entities.AppUser.list(),
              'AppUser list'
            );

            this.recordSuccess();

            if (allAppUsers && allAppUsers.length > 0) {
              const diff = diffEntityArrays(currentData.appUsers, allAppUsers);
              if (diff.toUpdate.length > 0 || diff.toAdd.length > 0) {
                updates.appUsers = mergeEntityChanges(currentData.appUsers, diff);
                console.log(`✅ [LightweightRefresh] AppUsers from API: +${diff.toAdd.length} ~${diff.toUpdate.length}`);

                // CRITICAL: Save to offline DB immediately
                const { offlineDB } = await import('./offlineDatabase');
                await offlineDB.bulkSave(offlineDB.STORES.APP_USERS, updates.appUsers);

                // CRITICAL: Only broadcast if we have actual appUsers data
                if (updates.appUsers && updates.appUsers.length > 0) {
                  window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
                    detail: { appUsers: updates.appUsers, fromSmartRefresh: true }
                  }));
                }
              }
            }
          }

          this.markRefreshed('appUsers');
        } catch (e) {
          this.recordError();
          console.warn('⚠️ [LightweightRefresh] AppUsers refresh failed:', e.message);
        }
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

      console.log('📍 [SmartRefresh] Refreshing driver locations...');
      await this.waitForRateLimit();
      
      const freshAppUsers = await base44.entities.AppUser.list();
      
      this.recordSuccess();
      
      if (freshAppUsers && freshAppUsers.length > 0) {
        // Save to offline DB
        const { offlineDB } = await import('./offlineDatabase');
        await offlineDB.bulkSave(offlineDB.STORES.APP_USERS, freshAppUsers);
        
        console.log(`✅ [SmartRefresh] Refreshed ${freshAppUsers.length} driver locations`);
        
        return { hasChanges: true, appUsers: freshAppUsers };
      }
      
      return { hasChanges: false, appUsers: currentAppUsers };
    } catch (error) {
      this.recordError();
      console.warn('⚠️ [SmartRefresh] Location refresh failed:', error.message);
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
      
      // STEP 4: Notify subscribers if we have updates
      if (Object.keys(updates).length > 0) {
        this.notifySubscribers(updates);

        // Dispatch smartRefreshComplete event with full replacement flags
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('smartRefreshComplete', {
            detail: { 
              updates,
              isFullReplacementDeliveries: updates.isFullReplacementDeliveries || false
            }
          }));
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
      
      // Get fresh AppUser data for all on-duty drivers
      const freshAppUsers = await queueEntityRequest(
        () => base44.entities.AppUser.list(),
        'AppUser list for polylines'
      );
      
      if (!freshAppUsers || freshAppUsers.length === 0) {
        console.warn('⚠️ [SmartRefresh] No drivers found for polyline update');
        return null;
      }

      // Filter for on-duty drivers
      const onDutyDrivers = freshAppUsers.filter(user => 
        user.driver_status === 'on_duty' && user.current_latitude && user.current_longitude
      );

      console.log(`📍 [SmartRefresh] Found ${onDutyDrivers.length} on-duty drivers with valid coordinates`);

      if (onDutyDrivers.length === 0) {
        return null;
      }

      // Save to offline DB
      const { offlineDB } = await import('./offlineDatabase');
      await offlineDB.bulkSave(offlineDB.STORES.APP_USERS, freshAppUsers);

      // Dispatch event with fresh coordinates for polyline rendering
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('polylineUpdateTriggered', {
          detail: { 
            onDutyDrivers,
            freshAppUsers,
            timestamp: Date.now()
          }
        }));
      }

      console.log(`✅ [SmartRefresh] Polyline update dispatched for ${onDutyDrivers.length} drivers`);
      
      return { onDutyDrivers, freshAppUsers };
    } catch (error) {
      this.recordError();
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
}

export const smartRefreshManager = new LightweightRefreshManager();

// Export helper to make global instance accessible
if (typeof window !== 'undefined') {
  window.smartRefreshManager = smartRefreshManager;
}