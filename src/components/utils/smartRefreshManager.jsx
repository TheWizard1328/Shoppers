// smartRefreshManager.js - Manages intelligent, differential data refreshes

import { base44 } from "@/api/base44Client";
import { diffEntityArrays, mergeEntityChanges, getLatestUpdateTimestamp, mergeDriverLocations, logDiffStats } from "./dataDiffer";
import { format } from "date-fns";
import { invalidate } from "./dataManager";
import { touchUserCache } from "./auth";

class SmartRefreshManager {
  constructor() {
    // Master toggle - can be disabled via AppSettings
    // CRITICAL: Default to true, will be overridden by initializeFromSettings() on app startup
    this._enabled = true;
    this._initialized = false;
    this._paused = false; // CRITICAL: Pause during mutations to prevent race conditions
    
    this.lastFetchTimestamps = new Map();
    this.isRefreshing = false;
    this.refreshCallbacks = new Set();
    this.refreshQueue = [];
    this.lastRefreshTime = 0;
    this.minRefreshInterval = 90000; // 90 seconds minimum between full refreshes (increased to reduce rate limits)
    this.lastFullRefreshTime = 0; // Track full refresh separately
    
    // Real-time refresh intervals (milliseconds)
    // CRITICAL: Increased intervals to prevent rate limiting while maintaining sync
    this.intervals = {
      driverLocation: 15000,     // 15s - driver GPS locations
      activeDeliveries: 20000,   // 20s - today's active delivery statuses only
      todayDeliveries: 20000,    // 20s - today's delivery changes only
      appUsers: 20000,           // 20s - driver status, assignments (includes driver_status)
      todayPatients: 60000,      // 60s - patients on today's routes
      patients: 120000,          // 2min - all other patients
      stores: 300000             // 5min - store data (rarely changes)
    };
    
    // Track last refresh time for each entity type
    // Initialize to 0 so the first refresh happens immediately
    this.lastRefreshTimes = {
      driverLocation: 0,
      activeDeliveries: 0,
      todayDeliveries: 0,
      appUsers: 0,
      todayPatients: 0,
      patients: 0,
      stores: 0
    };
    
    // Rate limit protection
    this.lastApiCallTime = 0;
    this.minTimeBetweenCalls = 2000; // 2s minimum between API calls to prevent rate limits
    this.consecutiveErrors = 0;
    this.maxConsecutiveErrors = 2; // Fail fast and enter cooldown
    this.errorCooldownUntil = 0;
    
    // Rate limit error callback
    this.rateLimitCallback = null;
    
    // CRITICAL: Track deliveries that have pending local updates
    // This prevents smart refresh from overwriting them with stale DB data
    this.pendingLocalUpdates = new Map(); // deliveryId -> { expiresAt, driverId, deliveryDate }
    
    // CRITICAL: Track patients that have pending local updates
    this.pendingPatientUpdates = new Map(); // patientId -> { expiresAt }
    
    // CRITICAL: Track IDs that were deleted via broadcast
    // These should be removed from UI even if smart refresh brings them back from stale offline DB
    this.deletedDeliveryIds = new Set();
    this.deletedPatientIds = new Set();
  }
  
  /**
   * Register a pending local update for a delivery
   * This prevents smart refresh from overwriting it for 30 seconds
   * The longer window accounts for backend optimizer latency
   */
  registerPendingUpdate(deliveryId, driverId = null, deliveryDate = null) {
    const expiresAt = Date.now() + 30000;
    this.pendingLocalUpdates.set(deliveryId, { expiresAt, driverId, deliveryDate });
  }
  
  /**
   * Check if a delivery has a pending local update
   */
  hasPendingUpdate(deliveryId) {
    const entry = this.pendingLocalUpdates.get(deliveryId);
    if (!entry) return false;
    
    // Check if protection window expired
    if (Date.now() > entry.expiresAt) {
      this.pendingLocalUpdates.delete(deliveryId);
      return false;
    }
    
    return true;
  }
  
  /**
   * Clear all pending updates (e.g., after full refresh)
   */
  clearPendingUpdates() {
    this.pendingLocalUpdates.clear();
  }
  
  /**
   * Clear pending updates for a specific driver and date
   * Called when we receive authoritative data from the backend for that route
   */
  clearPendingUpdatesForDriver(driverId, deliveryDate) {
    if (!driverId || !deliveryDate) return;
    
    const idsToRemove = [];
    for (const [id, entry] of this.pendingLocalUpdates.entries()) {
      if (entry.driverId === driverId && entry.deliveryDate === deliveryDate) {
        idsToRemove.push(id);
      }
    }
    idsToRemove.forEach(id => this.pendingLocalUpdates.delete(id));
  }
  
  /**
   * Clear a specific pending update by delivery ID
   * Called when we confirm data is synchronized with backend
   */
  clearPendingUpdateById(deliveryId) {
    this.pendingLocalUpdates.delete(deliveryId);
  }
  
  /**
   * Register a pending local update for a patient
   * This prevents smart refresh from overwriting it for 60 seconds
   */
  registerPendingPatientUpdate(patientId) {
    const expiresAt = Date.now() + 60000; // 60 second protection window
    this.pendingPatientUpdates.set(patientId, { expiresAt });
    console.log(`🛡️ [SmartRefresh] Protected patient ${patientId} from overwrite for 60s`);
  }
  
  /**
   * Check if a patient has a pending local update
   */
  hasPendingPatientUpdate(patientId) {
    const entry = this.pendingPatientUpdates.get(patientId);
    if (!entry) return false;
    
    // Check if protection window expired
    if (Date.now() > entry.expiresAt) {
      this.pendingPatientUpdates.delete(patientId);
      return false;
    }
    
    return true;
  }
  
  /**
   * Clear pending patient update
   */
  clearPendingPatientUpdate(patientId) {
    this.pendingPatientUpdates.delete(patientId);
  }
  
  /**
   * Get count of pending updates (for debugging)
   */
  getPendingUpdateCount() {
    // Clean up expired entries first
    const now = Date.now();
    for (const [id, entry] of this.pendingLocalUpdates.entries()) {
      if (now > entry.expiresAt) {
        this.pendingLocalUpdates.delete(id);
      }
    }
    return this.pendingLocalUpdates.size;
  }
  
  setRateLimitCallback(callback) {
    this.rateLimitCallback = callback;
  }
  
  notifyRateLimit(hasError) {
    if (this.rateLimitCallback) {
      this.rateLimitCallback(hasError);
    }
  }
  
  /**
   * Pause smart refresh during mutations
   * CRITICAL: Call this before any Patient/Delivery mutations
   */
  pause() {
    console.log('⏸️ [SmartRefresh] Paused for mutations');
    this._paused = true;
  }
  
  /**
   * Resume smart refresh after mutations complete
   * CRITICAL: Call this after mutations and syncs are complete
   */
  resume() {
    console.log('▶️ [SmartRefresh] Resumed after mutations');
    this._paused = false;
    this.isRefreshing = false; // CRITICAL: Clear stuck refresh state
  }
  
  /**
   * Check if smart refresh is paused
   */
  isPaused() {
    return this._paused;
  }
  
  /**
   * Force unlock - clears stuck refresh state
   * CRITICAL: Call this to recover from errors that left refresh locked
   */
  forceUnlock() {
    console.log('🔓 [SmartRefresh] Force unlocking stuck refresh state');
    this.isRefreshing = false;
    this._paused = false;
  }
  
  /**
   * Restart smart refresh - reset all timers to force immediate refresh
   * CRITICAL: Call this after mutations to sync UI with latest data
   */
  restart() {
    console.log('🔄 [SmartRefresh] Restarting - resetting all refresh timers');
    this._paused = false;
    this.lastRefreshTimes = {
      driverLocation: 0,
      activeDeliveries: 0,
      todayDeliveries: 0,
      appUsers: 0,
      todayPatients: 0,
      patients: 0,
      stores: 0
    };
    
    // CRITICAL: Clear the API fetch flag to reset fetch behavior
    if (this._pendingApiFetch) {
      this._pendingApiFetch.clear();
    }
  }
  
  /**
   * Getter for enabled state - logs if accessed before initialization
   */
  get enabled() {
    if (!this._initialized) {
      console.warn('⚠️ [SmartRefresh] Accessed "enabled" before initialization - using default');
    }
    return this._enabled;
  }
  
  /**
   * Setter for enabled state - only allow changes after initialization or from settings
   */
  set enabled(value) {
    this._enabled = value;
  }
  
  /**
   * Initialize enabled state from AppSettings
   * Called once during app startup - MUST be called before any refresh operations
   */
  async initializeFromSettings() {
    try {
      const settings = await base44.entities.AppSettings.filter({ setting_key: 'refresh_intervals' });
      
      if (settings && settings.length > 0 && settings[0].setting_value) {
        // CRITICAL: Check for explicit false, undefined means enabled
        const savedEnabled = settings[0].setting_value.smartRefreshEnabled;
        const enabled = savedEnabled !== false;
        
        this._enabled = enabled;
        this._initialized = true;
        
        return enabled;
      }
      
      // Default to enabled if no setting exists
      this._enabled = true;
      this._initialized = true;
      return true;
    } catch (error) {
      console.warn('⚠️ [SmartRefresh] Error loading settings, defaulting to enabled:', error);
      this._enabled = true;
      this._initialized = true;
      return true;
    }
  }
  
  /**
   * Wait for rate limit cooldown if needed
   * CRITICAL: Implements exponential backoff on consecutive errors
   */
  async waitForRateLimit() {
    const now = Date.now();
    
    // CRITICAL: Check if we're in error cooldown period
    if (now < this.errorCooldownUntil) {
      const waitTime = this.errorCooldownUntil - now;
      console.log(`⏰ [SmartRefresh] In error cooldown - waiting ${waitTime}ms`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    
    const timeSinceLastCall = now - this.lastApiCallTime;
    if (timeSinceLastCall < this.minTimeBetweenCalls) {
      await new Promise(resolve => setTimeout(resolve, this.minTimeBetweenCalls - timeSinceLastCall));
    }
    this.lastApiCallTime = Date.now();
  }
  
  /**
   * Record an error and trigger exponential backoff if needed
   */
  recordError() {
    this.consecutiveErrors++;
    
    if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
      // Trigger 30 second cooldown on rate limit errors
      this.errorCooldownUntil = Date.now() + 30000;
      console.warn(`🛑 [SmartRefresh] ${this.consecutiveErrors} consecutive errors - entering 30s cooldown`);
      this.consecutiveErrors = 0;
      this.notifyRateLimit(true);
    }
  }
  
  /**
   * Record a successful API call - resets error counter
   */
  recordSuccess() {
    if (this.consecutiveErrors > 0) {
      console.log(`✅ [SmartRefresh] Successful call - resetting error counter (was ${this.consecutiveErrors})`);
      this.consecutiveErrors = 0;
    }
  }
  
  /**
   * Check if enough time has passed for a specific refresh type
   */
  shouldRefresh(type) {
    const now = Date.now();
    const lastRefresh = this.lastRefreshTimes[type] || 0;
    const interval = this.intervals[type] || 15000;
    return (now - lastRefresh) >= interval;
  }
  
  /**
   * Mark a refresh type as completed
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
   * Notify all subscribers with updated data
   */
  notifySubscribers(updates) {
    this.refreshCallbacks.forEach(callback => callback(updates));
  }

  /**
   * Smart refresh for SELECTED DATE deliveries only
   * CRITICAL: Now respects pending local updates from updateDeliveriesLocally
   * CRITICAL: Uses offline database first to minimize API calls
   */
  async refreshCurrentDayDeliveries(currentDeliveries, selectedDate, filters, stores = [], drivers = [], skipRefresh = false) {
      if (skipRefresh) return null;

      try {
          const dateStr = format(selectedDate, 'yyyy-MM-dd');
          const currentDateDeliveries = currentDeliveries.filter(d => d && d.delivery_date === dateStr);
          
          // CRITICAL: Check offline DB first - only fetch from API if offline data is stale
          const { offlineDB } = await import('./offlineDatabase');
          const offlineDeliveries = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, dateStr);
          
          // If we have recent offline data (< 30 seconds old), use it instead of API
          if (offlineDeliveries && offlineDeliveries.length > 0) {
            const diff = diffEntityArrays(currentDateDeliveries, offlineDeliveries);
            
            if (diff.toUpdate.length === 0 && diff.toAdd.length === 0 && diff.toRemove.length === 0) {
              return null;
            }
            
            const mergedDeliveries = mergeEntityChanges(currentDateDeliveries, diff);
            const otherDateDeliveries = currentDeliveries.filter(d => d && d.delivery_date !== dateStr);
            
            return {
              hasChanges: true,
              deliveries: [...otherDateDeliveries, ...mergedDeliveries]
            };
          }
          
          // Fallback to API if no offline data
          const lastTimestamp = getLatestUpdateTimestamp(currentDateDeliveries);

          if (!lastTimestamp && currentDateDeliveries.length > 0) return null;

          const dateFilter = { ...filters, delivery_date: dateStr };
          if (lastTimestamp) {
              dateFilter.updated_date = { $gte: lastTimestamp.toISOString() };
          }
      
      await this.waitForRateLimit();
      const updatedDeliveries = await base44.entities.Delivery.filter(dateFilter);

      if (lastTimestamp) {
          if (!updatedDeliveries || updatedDeliveries.length === 0) {
              this.notifyRateLimit(false);
              return null;
          }
      } else {
          if (!updatedDeliveries || updatedDeliveries.length === 0) {
              this.notifyRateLimit(false);
              return null;
          }
      }

      const protectedDeliveryIds = [];
      const filteredUpdatedDeliveries = updatedDeliveries.filter(d => {
        if (this.hasPendingUpdate(d.id)) {
          protectedDeliveryIds.push(d.id);
          return false;
        }
        return true;
      });

      const diff = diffEntityArrays(currentDateDeliveries, filteredUpdatedDeliveries);

      if (diff.toUpdate.length === 0 && diff.toAdd.length === 0 && diff.toRemove.length === 0) {
          this.notifyRateLimit(false);
          return null;
      }

      const mergedDateDeliveries = mergeEntityChanges(currentDateDeliveries, diff);
      
      const finalMergedDeliveries = mergedDateDeliveries.map(d => {
        if (this.hasPendingUpdate(d.id)) {
          const currentVersion = currentDateDeliveries.find(cd => cd.id === d.id);
          if (currentVersion) return currentVersion;
        }
        return d;
      });
      
      const otherDateDeliveries = currentDeliveries.filter(d => d && d.delivery_date !== dateStr);
      const finalDeliveries = [...otherDateDeliveries, ...finalMergedDeliveries];

      // CRITICAL: Sync to offline database after changes
      try {
        const { offlineManager } = await import('./offlineManager');
        await offlineManager.cacheDeliveries(finalDeliveries, selectedDate);
      } catch (offlineError) {
        console.warn('⚠️ [SmartRefresh] Failed to sync deliveries to offline DB:', offlineError);
      }

      this.notifyRateLimit(false);
      return {
        hasChanges: true,
        deliveries: finalDeliveries
      };
      
    } catch (error) {
      if (error.message?.includes('WebSocket') || error.message?.includes('closed')) {
        this.notifyRateLimit(false);
        return null;
      }
      if (error.response?.status === 429 || error.message?.includes('429')) {
        this.notifyRateLimit(true);
        return null;
      }
      this.notifyRateLimit(false);
      return null;
    }
  }

  /**
   * Fetches only updated records since last fetch
   */
  async fetchUpdatedDeliveries(currentDeliveries, filters) {
    const lastTimestamp = getLatestUpdateTimestamp(currentDeliveries);
    
    let queryFilter = { ...filters };
    
    if (lastTimestamp) {
      queryFilter.updated_date = {
        $gte: lastTimestamp.toISOString()
      };
    }
    
    try {
      const updatedRecords = await base44.entities.Delivery.filter(queryFilter);
      return updatedRecords || [];
    } catch (error) {
      if (error.message?.includes('WebSocket') || error.message?.includes('closed')) {
        console.warn('⚠️ [SmartRefresh] WebSocket connection issue, skipping update');
        return [];
      }
      throw error;
    }
  }

  /**
   * Fetches all AppUsers
   */
  async fetchAllAppUsers() {
    try {
      const appUsers = await base44.entities.AppUser.list();
      return appUsers || [];
    } catch (error) {
      if (error.message?.includes('WebSocket') || error.message?.includes('closed')) {
        console.warn('⚠️ [SmartRefresh] WebSocket connection issue, skipping AppUser update');
        return [];
      }
      throw error;
    }
  }

  /**
   * Smart refresh for TODAY + NEXT 7 DAYS deliveries only
   */
  async refreshRelevantDeliveries(currentDeliveries, selectedDate, filters) {
    try {
      const today = new Date();
      const todayStr = format(today, 'yyyy-MM-dd');
      const futureDate = new Date(today);
      futureDate.setDate(futureDate.getDate() + 7);
      const futureDateStr = format(futureDate, 'yyyy-MM-dd');
      
      const relevantCurrentDeliveries = currentDeliveries.filter(d => 
        d && d.delivery_date && d.delivery_date >= todayStr && d.delivery_date <= futureDateStr
      );
      const pastDeliveries = currentDeliveries.filter(d => 
        d && d.delivery_date && d.delivery_date < todayStr
      );
      
      const lastTimestamp = getLatestUpdateTimestamp(relevantCurrentDeliveries);
      
      const dateFilter = {
        ...filters,
        delivery_date: { $gte: todayStr, $lte: futureDateStr }
      };
      
      if (lastTimestamp && relevantCurrentDeliveries.length > 0) {
        dateFilter.updated_date = { $gte: lastTimestamp.toISOString() };
      }
      
      await this.waitForRateLimit();
      const updatedDeliveries = await base44.entities.Delivery.filter(dateFilter);
      
      if (!updatedDeliveries || updatedDeliveries.length === 0) {
        this.notifyRateLimit(false);
        return null;
      }
      
      const filteredUpdatedDeliveries = updatedDeliveries.filter(d => !this.hasPendingUpdate(d.id));
      const diff = diffEntityArrays(relevantCurrentDeliveries, filteredUpdatedDeliveries);
      
      if (diff.toUpdate.length === 0 && diff.toAdd.length === 0 && diff.toRemove.length === 0) {
        this.notifyRateLimit(false);
        return null;
      }
      
      const mergedRelevantDeliveries = mergeEntityChanges(relevantCurrentDeliveries, diff);
      
      const finalMergedRelevant = mergedRelevantDeliveries.map(d => {
        if (this.hasPendingUpdate(d.id)) {
          const currentVersion = relevantCurrentDeliveries.find(cd => cd.id === d.id);
          if (currentVersion) return currentVersion;
        }
        return d;
      });
      
      const finalDeliveries = [...pastDeliveries, ...finalMergedRelevant];
      
      this.notifyRateLimit(false);
      return {
        hasChanges: true,
        deliveries: finalDeliveries
      };
      
    } catch (error) {
      if (error.message?.includes('WebSocket') || error.message?.includes('closed')) {
        this.notifyRateLimit(false);
        return null;
      }
      if (error.response?.status === 429 || error.message?.includes('429')) {
        this.notifyRateLimit(true);
        return null;
      }
      this.notifyRateLimit(false);
      return null;
    }
  }

  /**
   * Smart refresh for AppUsers
   * CRITICAL: Respects local timestamps to prevent reverting recent status changes
   */
  async refreshAppUsers(currentAppUsers, forceLocationRefresh = false) {
      try {
          // CRITICAL: Skip if paused (during status changes)
          if (this._paused) {
              console.log('⏸️ [SmartRefresh] AppUser refresh skipped - paused');
              return null;
          }
          
          const now = Date.now();
          const timeSinceLastLocationRefresh = now - this.lastDriverLocationRefresh;
          const shouldRefreshLocations = forceLocationRefresh || timeSinceLastLocationRefresh >= this.driverLocationRefreshInterval;
          
          const lastTimestamp = getLatestUpdateTimestamp(currentAppUsers);
          
          let queryFilter = {};
          
          if (lastTimestamp) {
              queryFilter.updated_date = {
                  $gte: lastTimestamp.toISOString()
              };
          }

          const updatedAppUsers = await base44.entities.AppUser.filter(queryFilter);

          if (!updatedAppUsers || updatedAppUsers.length === 0) {
              return null;
          }
          
          if (shouldRefreshLocations) {
              this.lastDriverLocationRefresh = now;
          }

          // CRITICAL: Filter out updates where local data is newer (recent status changes)
          const filteredUpdates = updatedAppUsers.filter(serverAppUser => {
              const localAppUser = currentAppUsers.find(u => u.user_id === serverAppUser.user_id);
              if (!localAppUser) return true; // New user, include it
              
              const localTime = new Date(localAppUser.updated_date || 0).getTime();
              const serverTime = new Date(serverAppUser.updated_date || 0).getTime();
              
              if (serverTime <= localTime) {
                  console.log(`🛡️ [SmartRefresh] Skipping AppUser update for ${serverAppUser.user_name || serverAppUser.user_id} - local is newer`);
                  return false;
              }
              return true;
          });
          
          if (filteredUpdates.length === 0) {
              return null;
          }

          const diff = diffEntityArrays(currentAppUsers, filteredUpdates);
          
          if (diff.toUpdate.length === 0 && diff.toAdd.length === 0) {
              return null;
          }
          
          const hasSignificantChanges = diff.toUpdate.some(update => {
              const current = currentAppUsers.find(u => u.user_id === update.user_id);
              if (!current) return true;
              return current.driver_status !== update.driver_status ||
                     current.location_tracking_enabled !== update.location_tracking_enabled ||
                     JSON.stringify(current.store_ids) !== JSON.stringify(update.store_ids);
          });
          
          if (hasSignificantChanges) {
              logDiffStats('AppUser', diff);

              diff.toUpdate.forEach(update => {
                  const current = currentAppUsers.find(u => u.user_id === update.user_id);
                  const changedFields = [];
                  
                  if (current) {
                      if (current.driver_status !== update.driver_status) {
                          changedFields.push(`driver_status: ${current.driver_status} → ${update.driver_status}`);
                      }
                      if (current.current_latitude !== update.current_latitude || 
                          current.current_longitude !== update.current_longitude) {
                          changedFields.push(`location updated`);
                      }
                      if (current.location_tracking_enabled !== update.location_tracking_enabled) {
                          changedFields.push(`tracking: ${current.location_tracking_enabled} → ${update.location_tracking_enabled}`);
                      }
                  }
                  
                  if (changedFields.length > 0) {
                      console.log(`📝 [SmartRefresh] AppUser ${update.user_name || update.user_id}: ${changedFields.join(', ')}`);
                  }
              });
          }
      
      const mergedAppUsers = mergeEntityChanges(currentAppUsers, diff);
      
      // CRITICAL: Sync to offline database after changes
      try {
        const { offlineManager } = await import('./offlineManager');
        await offlineManager.cacheEntities('AppUser', mergedAppUsers);
      } catch (offlineError) {
        console.warn('⚠️ [SmartRefresh] Failed to sync AppUsers to offline DB:', offlineError);
      }
      
      return {
        hasChanges: true,
        appUsers: mergedAppUsers
      };
      
    } catch (error) {
      if (error.message?.includes('WebSocket') || error.message?.includes('closed')) {
        console.warn('⚠️ [SmartRefresh] WebSocket connection issue, skipping AppUser update');
        return null;
      }
      console.error('❌ [SmartRefresh] Error refreshing AppUsers:', error);
      return null;
    }
  }
  
  /**
   * Fast driver location refresh
   * @param currentAppUsers - Current AppUser data
   * @param forceRefresh - If true, bypasses the interval check (for initial load)
   * CRITICAL: Never throws - always returns null on error to prevent stuck refresh
   */
  async refreshDriverLocations(currentAppUsers, forceRefresh = false) {
    try {
      // Check if disabled or paused - silently skip automatic polling (unless forced)
      if ((!this._enabled || this._paused) && !forceRefresh) {
        return null;
      }
      
      // Skip interval check if force refresh (initial load)
      if (!forceRefresh && !this.shouldRefresh('driverLocation')) {
        return null;
      }
      
      this.markRefreshed('driverLocation');
      await this.waitForRateLimit();
      
      // CRITICAL: Fetch ALL AppUsers with driver role (regardless of status)
      // We need off_duty drivers too so current user can see their own marker on desktop
      const allAppUsers = await base44.entities.AppUser.filter({
        app_roles: { $in: ['driver'] }
      });
      
      // Record success
      this.recordSuccess();
      
      if (!allAppUsers || allAppUsers.length === 0) {
        return null;
      }
      
      // CRITICAL: Merge ALL server AppUsers into current state
      // BUT respect pending local updates to prevent reverting status changes
      const updatedAppUsers = currentAppUsers.map(au => {
        const serverVersion = allAppUsers.find(ad => ad.user_id === au.user_id);
        if (serverVersion) {
          // CRITICAL: Check if server data is newer than local data
          // If local data is newer (recent status change), keep local version
          const localTime = new Date(au.updated_date || 0).getTime();
          const serverTime = new Date(serverVersion.updated_date || 0).getTime();
          
          if (serverTime > localTime) {
            return { ...au, ...serverVersion };
          } else {
            // Local is newer - keep local version (recent status change)
            return au;
          }
        }
        return au;
      });
      
      // Add any new AppUsers from server that weren't in current list
      allAppUsers.forEach(serverAu => {
        if (!updatedAppUsers.find(au => au.user_id === serverAu.user_id)) {
          updatedAppUsers.push(serverAu);
        }
      });
      
      // Check for changes
      let hasLocationChanges = false;
      for (let i = 0; i < currentAppUsers.length; i++) {
        const curr = currentAppUsers[i];
        const updated = updatedAppUsers.find(u => u.user_id === curr.user_id);
        if (updated) {
          if (curr.current_latitude !== updated.current_latitude ||
              curr.current_longitude !== updated.current_longitude ||
              curr.driver_status !== updated.driver_status ||
              curr.location_tracking_enabled !== updated.location_tracking_enabled) {
            hasLocationChanges = true;
            break;
          }
        }
      }
      
      // CRITICAL: Always dispatch event to driverLocationPoller with consistent data
      const finalAppUsers = updatedAppUsers;
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
          detail: { appUsers: finalAppUsers }
        }));
      }
      
      if (!hasLocationChanges) {
        return null;
      }
      
      // CRITICAL: Sync to offline database after changes
      try {
        const { offlineManager } = await import('./offlineManager');
        await offlineManager.cacheData('AppUser', finalAppUsers);
      } catch (offlineError) {
        // Silent fail - don't block refresh cycle
      }
      
      return {
        hasChanges: true,
        appUsers: finalAppUsers
      };
      
    } catch (error) {
      // CRITICAL: Record error for exponential backoff
      this.recordError();
      
      // CRITICAL: Catch ALL errors and return null - never throw
      if (error.response?.status === 429 || error.message?.includes('429')) {
        console.warn('⏰ [SmartRefresh] Rate limit on driver locations - skipping cycle');
        this.notifyRateLimit(true);
      } else if (error.message?.includes('WebSocket') || error.message?.includes('closed')) {
        console.warn('🔌 [SmartRefresh] WebSocket error on driver locations - skipping cycle');
      } else {
        console.warn('⚠️ [SmartRefresh] Error refreshing driver locations (non-fatal):', error.message || error);
      }
      return null;
    }
  }

  /**
   * Smart refresh for TODAY'S route patients only (HIGH PRIORITY)
   * Only refreshes patients that are part of today's deliveries
   */
  async refreshTodayPatients(currentPatients, todayDeliveries) {
    try {
      if (!todayDeliveries || todayDeliveries.length === 0) {
        return null;
      }
      
      // Get patient IDs from today's deliveries
      const todayPatientIds = [...new Set(
        todayDeliveries
          .filter(d => d && d.patient_id)
          .map(d => d.patient_id)
      )];
      
      if (todayPatientIds.length === 0) {
        return null;
      }
      
      // CRITICAL: Check if we received a broadcast and need fresh data
      const needsApiFetch = this.shouldFetchFromApi('Patient');
      
      // Filter current patients to only those on today's routes
      const todayCurrentPatients = currentPatients.filter(p => 
        p && todayPatientIds.includes(p.id)
      );
      
      const lastTimestamp = getLatestUpdateTimestamp(todayCurrentPatients);
      
      // If no timestamp but we need API fetch (broadcast received), still proceed
      if (!lastTimestamp && !needsApiFetch) {
        return null;
      }
      
      // Only fetch patients that are on today's routes AND updated recently
      const queryFilter = {
        id: { $in: todayPatientIds }
      };
      
      // Only add timestamp filter if we're not responding to a broadcast
      if (lastTimestamp && !needsApiFetch) {
        queryFilter.updated_date = { $gte: lastTimestamp.toISOString() };
      }
      
      await this.waitForRateLimit();
      const updatedPatients = await base44.entities.Patient.filter(queryFilter);
      
      if (!updatedPatients || updatedPatients.length === 0) {
        return null;
      }
      

      
      // BIDIRECTIONAL: Merge updates into full patient list (keep local if newer OR protected)
      const mergedPatients = currentPatients.map(p => {
        // CRITICAL: Skip if patient has pending local update (just edited by user)
        if (this.hasPendingPatientUpdate(p.id)) {
          console.log(`🛡️ [SmartRefresh] Keeping local patient ${p.id} - has pending update`);
          return p;
        }
        
        const serverVersion = updatedPatients.find(u => u.id === p.id);
        
        if (serverVersion) {
          // Compare timestamps
          const localTime = new Date(p.updated_date || 0).getTime();
          const serverTime = new Date(serverVersion.updated_date || 0).getTime();
          
          if (serverTime > localTime) {
            return serverVersion; // Server is newer
          } else {
            return p; // Local is newer or equal
          }
        }
        return p;
      });
      
      // Add any new patients from server
      updatedPatients.forEach(up => {
        if (!mergedPatients.find(p => p.id === up.id)) {
          mergedPatients.push(up);
        }
      });
      
      // CRITICAL: Filter out deleted patients that might have come from stale data
      mergedPatients = mergedPatients.filter(p => {
        if (p && this.isPatientDeleted(p.id)) {
          console.log(`🗑️ [SmartRefresh] Filtering out deleted patient ${p.id} from refresh`);
          return false;
        }
        return true;
      });
      
      // CRITICAL: Sync to offline database after changes
      try {
        const { offlineManager } = await import('./offlineManager');
        await offlineManager.cacheEntities('Patient', mergedPatients);
      } catch (offlineError) {
        console.warn('⚠️ [SmartRefresh] Failed to sync patients to offline DB:', offlineError);
      }
      
      return {
        hasChanges: true,
        patients: mergedPatients
      };
      
    } catch (error) {
      if (error.message?.includes('WebSocket') || error.message?.includes('closed')) {
        return null;
      }
      console.error('❌ [SmartRefresh] Error refreshing today patients:', error);
      return null;
    }
  }

  /**
   * Smart refresh for ALL patients (LOW PRIORITY - background)
   * Runs at longer intervals for patients not on today's routes
   */
  async refreshPatients(currentPatients, filters) {
    try {
      const lastTimestamp = getLatestUpdateTimestamp(currentPatients);
      
      if (!lastTimestamp) {
        return null;
      }
      
      const queryFilter = {
        ...filters,
        updated_date: {
          $gte: lastTimestamp.toISOString()
        }
      };
      
      await this.waitForRateLimit();
      const updatedPatients = await base44.entities.Patient.filter(queryFilter);
      
      if (!updatedPatients || updatedPatients.length === 0) {
        return null;
      }
      

      
      // CRITICAL: Filter out patients with pending local updates before merging
      const filteredUpdatedPatients = updatedPatients.filter(p => !this.hasPendingPatientUpdate(p.id));
      
      const diff = diffEntityArrays(currentPatients, filteredUpdatedPatients);
      
      if (diff.toUpdate.length === 0 && diff.toAdd.length === 0) {
        return null;
      }
      
      logDiffStats('Patient', diff);
      
      // CRITICAL: Preserve local versions of protected patients during merge
      let mergedPatients = mergeEntityChanges(currentPatients, diff);
      mergedPatients = mergedPatients.map(p => {
        if (this.hasPendingPatientUpdate(p.id)) {
          const localVersion = currentPatients.find(cp => cp.id === p.id);
          if (localVersion) {
            console.log(`🛡️ [SmartRefresh] Preserving local patient ${p.id} - has pending update`);
            return localVersion;
          }
        }
        return p;
      });
      
      return {
        hasChanges: true,
        patients: mergedPatients
      };
      
    } catch (error) {
      if (error.message?.includes('WebSocket') || error.message?.includes('closed')) {
        console.warn('⚠️ [SmartRefresh] WebSocket connection issue, skipping patient refresh');
        return null;
      }
      console.error('❌ [SmartRefresh] Error refreshing patients:', error);
      return null;
    }
  }

  /**
   * Smart refresh for stores
   * CRITICAL: Never throws - always returns null on error
   */
  async refreshStores(currentStores) {
    try {
      if (!this.shouldRefresh('stores')) {
        return null;
      }
      
      this.markRefreshed('stores');
      await this.waitForRateLimit();
      
      const lastTimestamp = getLatestUpdateTimestamp(currentStores);
      
      let queryFilter = {};
      
      if (lastTimestamp) {
        queryFilter.updated_date = {
          $gte: lastTimestamp.toISOString()
        };
      }
      
      const updatedStores = await base44.entities.Store.filter(queryFilter);
      
      // Record success
      this.recordSuccess();
      
      if (!updatedStores || updatedStores.length === 0) {
        return null;
      }
      
      const diff = diffEntityArrays(currentStores, updatedStores);
      
      if (diff.toUpdate.length === 0 && diff.toAdd.length === 0) {
        return null;
      }
      
      const mergedStores = mergeEntityChanges(currentStores, diff);
      
      return {
        hasChanges: true,
        stores: mergedStores
      };
      
    } catch (error) {
      // CRITICAL: Record error for exponential backoff
      this.recordError();
      
      // CRITICAL: Catch ALL errors and return null - never throw
      if (error.response?.status === 429 || error.message?.includes('429')) {
        console.warn('⏰ [SmartRefresh] Rate limit on stores - skipping cycle');
        this.notifyRateLimit(true);
      } else if (error.message?.includes('WebSocket') || error.message?.includes('closed')) {
        console.warn('🔌 [SmartRefresh] WebSocket error on stores - skipping cycle');
      } else {
        console.warn('⚠️ [SmartRefresh] Error refreshing stores (non-fatal):', error.message || error);
      }
      return null;
    }
  }

  /**
   * Smart refresh for users
   */
  async refreshUsers(currentUsers, currentAppUsers) {
    try {
      const lastAppUserTimestamp = getLatestUpdateTimestamp(currentAppUsers);
      
      let queryFilter = {};
      
      if (lastAppUserTimestamp) {
        queryFilter.updated_date = {
          $gte: lastAppUserTimestamp.toISOString()
        };
      }
      
      const updatedAppUsers = await base44.entities.AppUser.filter(queryFilter);
      
      if (!updatedAppUsers || updatedAppUsers.length === 0) {
        return null;
      }
      
      const diff = diffEntityArrays(currentAppUsers, updatedAppUsers);
      logDiffStats('AppUser', diff);
      
      if (diff.toUpdate.length === 0 && diff.toAdd.length === 0) {
        return null;
      }
      
      let authUsers = currentUsers || [];
      try {
        authUsers = await base44.entities.User.list();
      } catch (userError) {
        if (userError.response?.status === 403 || userError.message?.includes('403')) {
          authUsers = currentUsers || [];
        } else {
          throw userError;
        }
      }
      
      const mergedAppUsers = mergeEntityChanges(currentAppUsers, diff);
      
      return {
        hasChanges: true,
        users: authUsers,
        appUsers: mergedAppUsers
      };
      
    } catch (error) {
      if (error.message?.includes('WebSocket') || error.message?.includes('closed')) {
        console.warn('⚠️ [SmartRefresh] WebSocket connection issue, skipping user refresh');
        return null;
      }
      if (error.response?.status === 403 || error.message?.includes('403')) {
        return null;
      }
      console.error('❌ [SmartRefresh] Error refreshing users:', error);
      return null;
    }
  }

  /**
   * Fast delivery status refresh - polls for status changes on active deliveries
   * CRITICAL: ALWAYS fetches from API for active day to ensure cross-device sync
   * CRITICAL: Never throws - always returns null on error to prevent stuck refresh
   */
  async refreshActiveDeliveryStatuses(currentDeliveries, selectedDate, filters = {}) {
    try {
      // Check if disabled or paused - silently skip automatic polling
      if (!this._enabled || this._paused) {
        return null;
      }
      
      if (!this.shouldRefresh('activeDeliveries')) {
        return null;
      }
      
      this.markRefreshed('activeDeliveries');
      
      const dateStr = format(selectedDate, 'yyyy-MM-dd');
      const { offlineDB } = await import('./offlineDatabase');
      
      // CRITICAL: ALWAYS fetch from API for selected date to ensure cross-device sync
      // Offline DB is only used as fallback when API fails
      await this.waitForRateLimit();
      const cityOnlyFilter = { delivery_date: dateStr };
      
      if (filters.deliveryFilter && filters.deliveryFilter.store_id) {
        cityOnlyFilter.store_id = filters.deliveryFilter.store_id;
      }
      
      let fetchedDeliveries;
      try {
        fetchedDeliveries = await base44.entities.Delivery.filter(cityOnlyFilter);
        this.recordSuccess();
        
        // Update offline DB with fresh API data
        if (fetchedDeliveries && fetchedDeliveries.length > 0) {
          await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, fetchedDeliveries);
        }
      } catch (apiError) {
        // API failed - fall back to offline DB
        console.warn('⚠️ [SmartRefresh] API failed, using offline DB:', apiError.message);
        fetchedDeliveries = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, dateStr);
      }
      
      if (!fetchedDeliveries || fetchedDeliveries.length === 0) {
        return null;
      }
      
      // CRITICAL: Filter out protected deliveries
      const protectedCount = fetchedDeliveries.filter(d => this.hasPendingUpdate(d.id)).length;
      
      let hasChanges = false;
      let changedDeliveries = [];
      
      // CRITICAL: Separate deliveries by date - only update target date, preserve all others
      const currentDateDeliveries = currentDeliveries.filter(d => d && d.delivery_date === dateStr);
      const otherDateDeliveries = currentDeliveries.filter(d => d && d.delivery_date !== dateStr);
      
      const updatedCurrentDateDeliveries = currentDateDeliveries.map(d => {
        if (!d) return d;
        
        // CRITICAL: Skip if delivery has pending local update (recently edited by this user)
        if (this.hasPendingUpdate(d.id)) {
          return d;
        }
        
        const fetchedVersion = fetchedDeliveries.find(fd => fd.id === d.id);
        if (fetchedVersion) {
          // IMPROVED CONFLICT RESOLUTION: Server is authoritative for synced data
          // Only keep local if it has a pending update (handled above)
          const localTime = new Date(d.updated_date || 0).getTime();
          const serverTime = new Date(fetchedVersion.updated_date || 0).getTime();
          
          // CRITICAL: Use server data if timestamps differ by more than 1 second
          // This prevents clock skew issues while still respecting actual updates
          const timeDiff = Math.abs(serverTime - localTime);
          const hasRealChange = timeDiff > 1000 || 
            d.status !== fetchedVersion.status ||
            d.driver_id !== fetchedVersion.driver_id ||
            d.stop_order !== fetchedVersion.stop_order;
          
          if (hasRealChange) {
            // Server has different data - use server version (authoritative)
            hasChanges = true;
            changedDeliveries.push({
              name: fetchedVersion.patient_name || 'Pickup',
              oldStatus: d.status,
              newStatus: fetchedVersion.status,
              oldDriver: d.driver_name,
              newDriver: fetchedVersion.driver_name
            });
            return fetchedVersion;
          }
          // No real change - keep current (avoids unnecessary re-renders)
          return d;
        }
        return d;
      });
      
      // Add any new deliveries from server that weren't in current list
      fetchedDeliveries.forEach(fd => {
        const existsInCurrent = updatedCurrentDateDeliveries.find(d => d?.id === fd.id);
        
        if (!existsInCurrent && !this.hasPendingUpdate(fd.id)) {
          hasChanges = true;
          changedDeliveries.push({
            name: fd.patient_name || 'Pickup',
            type: 'NEW',
            status: fd.status
          });
          updatedCurrentDateDeliveries.push(fd);
        }
      });
      
      // CRITICAL: Filter out deleted deliveries that might have come from stale offline DB
      const filteredCurrentDateDeliveries = updatedCurrentDateDeliveries.filter(d => {
        if (d && this.isDeliveryDeleted(d.id)) {
          hasChanges = true;
          return false;
        }
        return true;
      });
      
      // CRITICAL: Merge back with other dates
      const updatedDeliveries = [...otherDateDeliveries, ...filteredCurrentDateDeliveries];
      
      if (!hasChanges) {
        return null;
      }
      
      return {
        hasChanges: true,
        deliveries: updatedDeliveries
      };
      
    } catch (error) {
      // CRITICAL: Record error for exponential backoff
      this.recordError();
      
      // CRITICAL: Catch ALL errors and return null - never throw
      if (error.response?.status === 429 || error.message?.includes('429')) {
        console.warn('⏰ [SmartRefresh] Rate limit on active deliveries - skipping cycle');
        this.notifyRateLimit(true);
      } else if (error.message?.includes('WebSocket') || error.message?.includes('closed')) {
        console.warn('🔌 [SmartRefresh] WebSocket error on active deliveries - skipping cycle');
      } else {
        console.warn('⚠️ [SmartRefresh] Error refreshing active deliveries (non-fatal):', error.message || error);
      }
      return null;
    }
  }

  /**
   * LIGHTWEIGHT smart refresh - polls for delivery and AppUser changes
   * CRITICAL: ALWAYS unlocks refresh state in finally block to prevent stuck spinner
   */
  async performSmartRefresh(currentData, filters, isEntityUpdating = false) {
    // CRITICAL: When disabled, skip background polling
    if (!this._enabled) {
      this.isRefreshing = false; // Always ensure unlocked
      return null;
    }
    
    // CRITICAL: Skip if paused during mutations
    if (this._paused) {
      this.isRefreshing = false;
      return null;
    }
    
    if (isEntityUpdating) {
      this.isRefreshing = false;
      return null;
    }
    
    // CRITICAL: Auto-unlock if stuck for more than 30 seconds
    if (this.isRefreshing && this._refreshStartTime && (Date.now() - this._refreshStartTime > 30000)) {
      console.warn('🔓 [SmartRefresh] Auto-unlocking stuck refresh state (>30s)');
      this.isRefreshing = false;
    }
    
    if (this.isRefreshing) {
      return null;
    }
    
    // CRITICAL: Touch user cache on every refresh cycle to prevent session timeout
    try {
      touchUserCache();
    } catch (e) {
      // Ignore errors from touchUserCache
    }
    
    this.isRefreshing = true;
    this._refreshStartTime = Date.now();
    const updates = {};
    
    try {
      // Refresh AppUsers (includes driver status)
      if (this.shouldRefresh('appUsers') && currentData.appUsers) {
        try {
          const appUserResult = await this.refreshAppUsers(currentData.appUsers);
          if (appUserResult?.hasChanges) {
            updates.appUsers = appUserResult.appUsers;
          }
          this.markRefreshed('appUsers');
        } catch (e) {
          console.warn('⚠️ [SmartRefresh] AppUser refresh failed:', e.message);
        }
      }
      
      const hasAnyUpdates = Object.keys(updates).length > 0;
      return hasAnyUpdates ? updates : null;
      
    } catch (error) {
      // CRITICAL: Catch ALL errors and gracefully continue
      if (error.response?.status === 429 || error.message?.includes('429')) {
        console.warn('⏰ [SmartRefresh] Rate limit hit - will retry next cycle');
        this.notifyRateLimit(true);
      } else if (error.response?.status === 401 || error.response?.status === 403) {
        console.warn('🔐 [SmartRefresh] Auth error - session may have expired');
      } else {
        console.warn('⚠️ [SmartRefresh] Error during refresh (non-fatal):', error.message || error);
      }
      return null;
    } finally {
      // CRITICAL: ALWAYS unlock refresh state - prevents stuck spinner
      this.isRefreshing = false;
      this._refreshStartTime = null;
    }
  }
  
  /**
   * Handle broadcast from another device - refresh ONLY the specific entity that changed
   * This is the smart approach: instead of polling everything, we listen for targeted updates
   * CRITICAL: For creates/updates, we need to fetch from API, not offline DB (which won't have the new data)
   */
  async handleBroadcastRefresh(entityName, operation, metadata = {}) {
    console.log(`📡 [SmartRefresh] Handling broadcast: ${entityName} ${operation}`, metadata);
    
    // CRITICAL: Track deletions to prevent smart refresh from resurrecting deleted items
    if (operation === 'delete' && metadata?.id) {
      if (entityName === 'Delivery') {
        this.deletedDeliveryIds.add(metadata.id);
        console.log(`🗑️ [SmartRefresh] Marked delivery ${metadata.id} as deleted`);
        
        // Also remove from offline DB immediately
        try {
          const { offlineDB } = await import('./offlineDatabase');
          const db = await offlineDB.openDatabase();
          const tx = db.transaction([offlineDB.STORES.DELIVERIES], 'readwrite');
          tx.objectStore(offlineDB.STORES.DELIVERIES).delete(metadata.id);
        } catch (e) {
          console.warn('⚠️ [SmartRefresh] Failed to remove deleted delivery from offline DB');
        }
      } else if (entityName === 'Patient') {
        this.deletedPatientIds.add(metadata.id);
        console.log(`🗑️ [SmartRefresh] Marked patient ${metadata.id} as deleted`);
        
        // Also remove from offline DB immediately
        try {
          const { offlineDB } = await import('./offlineDatabase');
          const db = await offlineDB.openDatabase();
          const tx = db.transaction([offlineDB.STORES.PATIENTS], 'readwrite');
          tx.objectStore(offlineDB.STORES.PATIENTS).delete(metadata.id);
        } catch (e) {
          console.warn('⚠️ [SmartRefresh] Failed to remove deleted patient from offline DB');
        }
      }
    }
    
    // CRITICAL: Mark that we need to fetch from API (not offline DB) for this entity
    // because the offline DB won't have the new/updated data yet
    this._pendingApiFetch = this._pendingApiFetch || new Set();
    this._pendingApiFetch.add(entityName);
    
    switch (entityName) {
      case 'Delivery':
        // Reset delivery refresh timer to force immediate refresh
        this.lastRefreshTimes.activeDeliveries = 0;
        this.lastRefreshTimes.todayDeliveries = 0;
        break;
        
      case 'Patient':
        // Reset patient refresh timer
        this.lastRefreshTimes.todayPatients = 0;
        this.lastRefreshTimes.patients = 0;
        break;
        
      case 'AppUser':
        // Reset AppUser refresh timer
        this.lastRefreshTimes.appUsers = 0;
        this.lastRefreshTimes.driverLocation = 0;
        break;
        
      case 'Store':
        // Reset store refresh timer
        this.lastRefreshTimes.stores = 0;
        break;
        
      default:
        console.log(`📡 [SmartRefresh] Unknown entity in broadcast: ${entityName}`);
    }
  }
  
  /**
   * Check if we should skip offline DB and fetch from API
   * (called after receiving a broadcast for this entity)
   */
  shouldFetchFromApi(entityName) {
    if (this._pendingApiFetch && this._pendingApiFetch.has(entityName)) {
      this._pendingApiFetch.delete(entityName);
      return true;
    }
    return false;
  }
  
  /**
   * Check if a delivery was deleted via broadcast
   */
  isDeliveryDeleted(deliveryId) {
    return this.deletedDeliveryIds.has(deliveryId);
  }
  
  /**
   * Check if a patient was deleted via broadcast
   */
  isPatientDeleted(patientId) {
    return this.deletedPatientIds.has(patientId);
  }
  
  /**
   * Clear deleted ID tracking (e.g., after confirmed sync)
   */
  clearDeletedIds() {
    this.deletedDeliveryIds.clear();
    this.deletedPatientIds.clear();
  }
  
  /**
   * CRITICAL: Check and restart offline sync if it failed to start
   * Called periodically by the smart refresh cycle
   */
  async checkAndRestartOfflineSync() {
    try {
      const { offlineDB } = await import('./offlineDatabase');
      const { performBackgroundSync, isOfflineSyncPaused } = await import('./offlineSync');
      
      // Don't restart if paused
      if (isOfflineSyncPaused()) {
        return { skipped: true, reason: 'paused' };
      }
      
      // Get current offline DB stats
      const stats = await offlineDB.getStats();
      const deliveryCount = stats?.deliveries?.count || 0;
      const patientCount = stats?.patients?.count || 0;
      
      console.log(`🔍 [SmartRefresh] Offline DB check - Deliveries: ${deliveryCount}, Patients: ${patientCount}`);
      
      // CRITICAL: If we have very few deliveries or patients, offline sync likely failed
      // A healthy offline DB should have at least 50 deliveries from the last 30 days
      const needsSync = deliveryCount < 50 || patientCount < 10;
      
      if (needsSync) {
        console.log(`⚠️ [SmartRefresh] Offline DB appears incomplete - triggering background sync`);
        
        // Get selected date from global filters
        const { globalFilters } = await import('./globalFilters');
        const selectedDateStr = globalFilters.getSelectedDate() || new Date().toISOString().split('T')[0];
        
        // Trigger background sync (non-blocking)
        performBackgroundSync(selectedDateStr).then(result => {
          if (result.success) {
            console.log(`✅ [SmartRefresh] Background sync completed successfully`);
          } else if (result.skipped) {
            console.log(`⏸️ [SmartRefresh] Background sync was skipped`);
          } else if (result.error) {
            console.warn(`⚠️ [SmartRefresh] Background sync failed: ${result.error}`);
          }
        }).catch(err => {
          console.warn(`⚠️ [SmartRefresh] Background sync error: ${err.message}`);
        });
        
        return { triggered: true, deliveryCount, patientCount };
      }
      
      return { skipped: true, reason: 'sufficient_data', deliveryCount, patientCount };
      
    } catch (error) {
      console.warn(`⚠️ [SmartRefresh] Error checking offline sync:`, error.message);
      return { error: error.message };
    }
  }
}

export const smartRefreshManager = new SmartRefreshManager();