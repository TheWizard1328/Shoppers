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
    
    this.lastFetchTimestamps = new Map();
    this.isRefreshing = false;
    this.refreshCallbacks = new Set();
    this.refreshQueue = [];
    this.lastRefreshTime = 0;
    this.minRefreshInterval = 90000; // 90 seconds minimum between full refreshes (increased to reduce rate limits)
    this.lastFullRefreshTime = 0; // Track full refresh separately
    
    // Real-time refresh intervals (milliseconds) - ALL SET TO 15 SECONDS
    this.intervals = {
      driverLocation: 15000,     // 15s - driver GPS locations
      activeDeliveries: 15000,   // 15s - today's active delivery statuses
      todayDeliveries: 15000,    // 15s - today's delivery changes only
      appUsers: 15000,           // 15s - driver status, assignments
      todayPatients: 15000,      // 15s - patients on today's routes only
      patients: 15000,           // 15s - all other patients
      stores: 15000              // 15s - store data
    };
    
    // Track last refresh time for each entity type
    // Initialize to NOW so the first refresh waits for the full interval
    const now = Date.now();
    this.lastRefreshTimes = {
      driverLocation: now,
      activeDeliveries: now,
      todayDeliveries: now,
      appUsers: now,
      todayPatients: now,
      patients: now,
      stores: now
    };
    
    // Rate limit protection - CRITICAL: Extended delays to prevent backend crashes
    this.lastApiCallTime = 0;
    this.minTimeBetweenCalls = 500; // 0.5 seconds minimum between API calls (reduced - rate limiting handled by backend)
    
    // Rate limit error callback
    this.rateLimitCallback = null;
    
    // CRITICAL: Track deliveries that have pending local updates
    // This prevents smart refresh from overwriting them with stale DB data
    this.pendingLocalUpdates = new Map(); // deliveryId -> { expiresAt, driverId, deliveryDate }
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
   */
  async waitForRateLimit() {
    const now = Date.now();
    const timeSinceLastCall = now - this.lastApiCallTime;
    if (timeSinceLastCall < this.minTimeBetweenCalls) {
      await new Promise(resolve => setTimeout(resolve, this.minTimeBetweenCalls - timeSinceLastCall));
    }
    this.lastApiCallTime = Date.now();
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
   */
  async refreshCurrentDayDeliveries(currentDeliveries, selectedDate, filters, stores = [], drivers = [], skipRefresh = false) {
      if (skipRefresh) return null;

      try {
          const dateStr = format(selectedDate, 'yyyy-MM-dd');
          const currentDateDeliveries = currentDeliveries.filter(d => d && d.delivery_date === dateStr);
          const lastTimestamp = getLatestUpdateTimestamp(currentDateDeliveries);

          if (!lastTimestamp && currentDateDeliveries.length > 0) return null;

          const dateFilter = { ...filters, delivery_date: dateStr };
          if (lastTimestamp) {
              dateFilter.updated_date = { $gte: lastTimestamp.toISOString() };
          }
      
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
   */
  async refreshAppUsers(currentAppUsers, forceLocationRefresh = false) {
      try {
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

          const diff = diffEntityArrays(currentAppUsers, updatedAppUsers);
          
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
   */
  async refreshDriverLocations(currentAppUsers, forceRefresh = false) {
    try {
      // Check if disabled - silently skip automatic polling (unless forced)
      if (!this._enabled && !forceRefresh) {
        return null;
      }
      
      // Skip interval check if force refresh (initial load)
      if (!forceRefresh && !this.shouldRefresh('driverLocation')) {
        return null;
      }
      
      this.markRefreshed('driverLocation');
      await this.waitForRateLimit();
      
      const locationFilter = {
        location_tracking_enabled: true,
        driver_status: 'on_duty'
      };
      
      const activeDrivers = await base44.entities.AppUser.filter(locationFilter);
      
      if (!activeDrivers || activeDrivers.length === 0) {
        return null;
      }
      
      let hasLocationChanges = false;
      const updatedAppUsers = currentAppUsers.map(au => {
        const activeDriver = activeDrivers.find(ad => ad.user_id === au.user_id);
        if (activeDriver) {
          if (au.current_latitude !== activeDriver.current_latitude ||
              au.current_longitude !== activeDriver.current_longitude ||
              au.driver_status !== activeDriver.driver_status) {
            hasLocationChanges = true;
            return { ...au, ...activeDriver };
          }
        }
        return au;
      });
      
      if (!hasLocationChanges) {
        return null;
      }
      
      console.log('📍 [SmartRefresh] Driver location changes detected - dispatching event for map update');
      
      // Dispatch custom event for DeliveryMap to listen to
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
          detail: { appUsers: updatedAppUsers }
        }));
      }
      
      // CRITICAL: Sync to offline database after changes
      try {
        const { offlineManager } = await import('./offlineManager');
        await offlineManager.cacheEntities('AppUser', updatedAppUsers);
      } catch (offlineError) {
        console.warn('⚠️ [SmartRefresh] Failed to sync AppUsers to offline DB:', offlineError);
      }
      
      return {
        hasChanges: true,
        appUsers: updatedAppUsers
      };
      
    } catch (error) {
      if (error.message?.includes('WebSocket') || error.message?.includes('closed')) {
        return null;
      }
      console.error('❌ [SmartRefresh] Error refreshing driver locations:', error);
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
      
      // Filter current patients to only those on today's routes
      const todayCurrentPatients = currentPatients.filter(p => 
        p && todayPatientIds.includes(p.id)
      );
      
      const lastTimestamp = getLatestUpdateTimestamp(todayCurrentPatients);
      
      if (!lastTimestamp) {
        return null;
      }
      
      // Only fetch patients that are on today's routes AND updated recently
      const queryFilter = {
        id: { $in: todayPatientIds },
        updated_date: { $gte: lastTimestamp.toISOString() }
      };
      
      await this.waitForRateLimit();
      const updatedPatients = await base44.entities.Patient.filter(queryFilter);
      
      if (!updatedPatients || updatedPatients.length === 0) {
        return null;
      }
      

      
      // BIDIRECTIONAL: Merge updates into full patient list (keep local if newer)
      const mergedPatients = currentPatients.map(p => {
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
      

      
      const diff = diffEntityArrays(currentPatients, updatedPatients);
      
      if (diff.toUpdate.length === 0 && diff.toAdd.length === 0) {
        return null;
      }
      
      logDiffStats('Patient', diff);
      const mergedPatients = mergeEntityChanges(currentPatients, diff);
      
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
      
      if (!updatedStores || updatedStores.length === 0) {
        return null;
      }
      
      const diff = diffEntityArrays(currentStores, updatedStores);
      
      if (diff.toUpdate.length === 0 && diff.toAdd.length === 0) {
        return null;
      }
      
      logDiffStats('Store', diff);
      const mergedStores = mergeEntityChanges(currentStores, diff);
      
      return {
        hasChanges: true,
        stores: mergedStores
      };
      
    } catch (error) {
      if (error.message?.includes('WebSocket') || error.message?.includes('closed')) {
        console.warn('⚠️ [SmartRefresh] WebSocket connection issue, skipping store refresh');
        return null;
      }
      console.error('❌ [SmartRefresh] Error refreshing stores:', error);
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
   */
  async refreshActiveDeliveryStatuses(currentDeliveries, selectedDate, filters = {}) {
    try {
      // Check if disabled - silently skip automatic polling
      if (!this._enabled) {
        return null;
      }
      
      if (!this.shouldRefresh('activeDeliveries')) {
        return null;
      }
      
      this.markRefreshed('activeDeliveries');
      await this.waitForRateLimit();
      
      const dateStr = format(selectedDate, 'yyyy-MM-dd');
      
      // CRITICAL: Fetch ALL drivers for selected city (not just selected driver)
      // Build city-only filter (remove driver_id to get all drivers)
      const cityOnlyFilter = { delivery_date: dateStr };
      
      // Copy store filter but exclude driver filter
      if (filters.deliveryFilter && filters.deliveryFilter.store_id) {
        cityOnlyFilter.store_id = filters.deliveryFilter.store_id;
      }
      
      const fetchedDeliveries = await base44.entities.Delivery.filter(cityOnlyFilter);
      
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
        
        // CRITICAL: Skip if delivery has pending local update
        if (this.hasPendingUpdate(d.id)) {
          return d;
        }
        
        const fetchedVersion = fetchedDeliveries.find(fd => fd.id === d.id);
        if (fetchedVersion) {
          // BIDIRECTIONAL: Compare timestamps - only use server data if newer
          const localTime = new Date(d.updated_date || 0).getTime();
          const serverTime = new Date(fetchedVersion.updated_date || 0).getTime();
          
          if (serverTime > localTime) {
            // Server is newer - use server data
            hasChanges = true;
            changedDeliveries.push({
              name: fetchedVersion.patient_name || 'Pickup',
              oldStatus: d.status,
              newStatus: fetchedVersion.status,
              oldDriver: d.driver_name,
              newDriver: fetchedVersion.driver_name
            });
            return fetchedVersion;
          } else {
            // Local is newer or equal - keep local data
            return d;
          }
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
      
      // CRITICAL: Merge back with other dates
      const updatedDeliveries = [...otherDateDeliveries, ...updatedCurrentDateDeliveries];
      
      if (!hasChanges) {
        return null;
      }
      

      
      return {
        hasChanges: true,
        deliveries: updatedDeliveries
      };
      
    } catch (error) {
      if (error.message?.includes('WebSocket') || error.message?.includes('closed')) {
        return null;
      }
      console.error('❌ [SmartRefresh] Error refreshing active delivery statuses:', error);
      return null;
    }
  }

  /**
   * PRIORITY smart refresh - selected date deliveries + patients FIRST, then UI update
   * Focuses on dashboard data only (other pages handle their own fetching)
   */
  async performSmartRefresh(currentData, filters, isEntityUpdating = false) {
    // CRITICAL: When disabled, skip background polling
    if (!this._enabled) {
      return null;
    }
    
    if (isEntityUpdating) {
      return null;
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
    const updates = {};
    
    try {
      // PRIORITY 1: Refresh selected date deliveries FIRST
      if (this.shouldRefresh('todayDeliveries')) {
        this.markRefreshed('todayDeliveries');
        
        const deliveryUpdate = await this.refreshCurrentDayDeliveries(
          currentData.deliveries || [],
          filters.selectedDate,
          filters.deliveryFilter || {},
          currentData.stores || [],
          currentData.drivers || [],
          false
        );
        
        if (deliveryUpdate?.hasChanges) {
          updates.deliveries = deliveryUpdate.deliveries;
        }
      }
      
      // PRIORITY 2: Refresh patients on selected date route SECOND
      if (this.shouldRefresh('todayPatients') && updates.deliveries) {
        this.markRefreshed('todayPatients');
        
        const dateStr = format(filters.selectedDate, 'yyyy-MM-dd');
        const todayDeliveries = updates.deliveries.filter(d => d && d.delivery_date === dateStr);
        
        const patientUpdate = await this.refreshTodayPatients(
          currentData.patients || [],
          todayDeliveries
        );
        
        if (patientUpdate?.hasChanges) {
          updates.patients = patientUpdate.patients;
        }
      }
      
      // PRIORITY 3: AppUsers (driver status, locations) - still handled by separate methods
      
      const hasAnyUpdates = Object.keys(updates).length > 0;
      if (hasAnyUpdates) {
      }
      return hasAnyUpdates ? updates : null;
      
    } catch (error) {
      if (error.response?.status === 401 || error.response?.status === 403) {
        console.warn('🔐 [SmartRefresh] Auth error during refresh - session may have expired');
        return null;
      }
      console.error('❌ [SmartRefresh] Error during smart refresh:', error);
      return null;
    } finally {
      this.isRefreshing = false;
    }
  }
}

export const smartRefreshManager = new SmartRefreshManager();