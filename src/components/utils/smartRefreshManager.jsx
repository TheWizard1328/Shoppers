// smartRefreshManager.js - Manages intelligent, differential data refreshes

import { base44 } from "@/api/base44Client";
import { diffEntityArrays, mergeEntityChanges, getLatestUpdateTimestamp, mergeDriverLocations, logDiffStats } from "./dataDiffer";
import { format } from "date-fns";
import { invalidate } from "./dataManager";

class SmartRefreshManager {
  constructor() {
    this.lastFetchTimestamps = new Map();
    this.isRefreshing = false;
    this.refreshCallbacks = new Set();
    this.refreshQueue = [];
    this.lastRefreshTime = 0;
    this.minRefreshInterval = 14900; // ~15 seconds minimum between full refreshes
    this.lastFullRefreshTime = 0; // Track full refresh separately
    
    // Real-time refresh intervals (milliseconds) - INCREASED to prevent rate limits
    this.intervals = {
      driverLocation: 10000,     // 10s - driver GPS locations
      activeDeliveries: 15000,   // 15s - active delivery statuses for map
      todayDeliveries: 30000,    // 30s - today's delivery changes
      appUsers: 30000,           // 30s - driver status, assignments
      patients: 120000,          // 2min - patient data rarely changes
      stores: 300000             // 5min - store data almost never changes
    };
    
    // Track last refresh time for each entity type
    this.lastRefreshTimes = {
      driverLocation: 0,
      activeDeliveries: 0,
      todayDeliveries: 0,
      appUsers: 0,
      patients: 0,
      stores: 0
    };
    
    // Rate limit protection
    this.lastApiCallTime = 0;
    this.minTimeBetweenCalls = 1000; // 1 second minimum between any API call
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
   * Fetches only updated records since last fetch
   */
  async fetchUpdatedDeliveries(currentDeliveries, filters) {
    const lastTimestamp = getLatestUpdateTimestamp(currentDeliveries);
    
    let queryFilter = { ...filters };
    
    // If we have a last timestamp, only fetch records updated after it
    if (lastTimestamp) {
      queryFilter.updated_date = {
        $gte: lastTimestamp.toISOString()
      };
    }
    

    
    try {
      const updatedRecords = await base44.entities.Delivery.filter(queryFilter);
      return updatedRecords || [];
    } catch (error) {
      // Gracefully handle WebSocket and network errors
      if (error.message?.includes('WebSocket') || error.message?.includes('closed')) {
        console.warn('⚠️ [SmartRefresh] WebSocket connection issue, skipping update');
        return [];
      }
      throw error;
    }
  }

  /**
   * Fetches all AppUsers (to detect driver_status changes)
   */
  async fetchAllAppUsers() {
    try {
      const appUsers = await base44.entities.AppUser.list();
      console.log(`🔍 [SmartRefresh] Fetched ${appUsers?.length || 0} AppUsers`);
      return appUsers || [];
    } catch (error) {
      // Gracefully handle WebSocket and network errors
      if (error.message?.includes('WebSocket') || error.message?.includes('closed')) {
        console.warn('⚠️ [SmartRefresh] WebSocket connection issue, skipping AppUser update');
        return [];
      }
      throw error;
    }
  }

  /**
   * Smart refresh for SELECTED DATE deliveries only (high frequency)
   * OPTIMIZED: Only refreshes the selected date's deliveries - never touches historical data
   * Uses incremental updates based on updated_date timestamp
   */
  async refreshCurrentDayDeliveries(currentDeliveries, selectedDate, filters, stores = [], drivers = []) {
      try {
          const dateStr = format(selectedDate, 'yyyy-MM-dd');
          
          // CRITICAL: Only work with selected date deliveries - leave all other dates untouched
          const currentDateDeliveries = currentDeliveries.filter(d => d && d.delivery_date === dateStr);
          
          // Get the latest update timestamp from selected date's deliveries
          const lastTimestamp = getLatestUpdateTimestamp(currentDateDeliveries);

          // ALWAYS use incremental fetch - never do full reload
          if (!lastTimestamp && currentDateDeliveries.length > 0) {
              // Have deliveries but no timestamp - skip refresh, data is already loaded
              return null;
          }

          // Build filter for incremental fetch
          const dateFilter = {
              ...filters,
              delivery_date: dateStr
          };
          
          // If we have existing data, only fetch records updated since last check
          if (lastTimestamp) {
              dateFilter.updated_date = {
                  $gte: lastTimestamp.toISOString()
              };
          }
      
      const updatedDeliveries = await base44.entities.Delivery.filter(dateFilter);
      
      // If incremental and no updates, skip processing (most common case)
      if (lastTimestamp) {
          if (!updatedDeliveries || updatedDeliveries.length === 0) {
              return null; // No changes - this is the expected path most of the time
          }
          console.log(`📦 [SmartRefresh] ${updatedDeliveries.length} deliveries for ${dateStr} updated since last check`);
      } else {
          // Only log full fetch if it actually happens (initial load)
          if (!updatedDeliveries || updatedDeliveries.length === 0) {
              return null;
          }
          console.log(`📦 [SmartRefresh] Initial fetch: ${updatedDeliveries.length} deliveries for ${dateStr}`);
      }
      
      // Diff and merge
      const diff = diffEntityArrays(currentDateDeliveries, updatedDeliveries);
      
      // If no real changes, skip state update
      if (diff.toUpdate.length === 0 && diff.toAdd.length === 0 && diff.toRemove.length === 0) {
          return null;
      }
      
      // Only log if there are actual changes
      logDiffStats(`Delivery (${dateStr})`, diff);
      
      // CRITICAL: Merge only selected date changes, preserve ALL other dates exactly as-is
      const mergedDateDeliveries = mergeEntityChanges(currentDateDeliveries, diff);
      const otherDateDeliveries = currentDeliveries.filter(d => d && d.delivery_date !== dateStr);
      const finalDeliveries = [...otherDateDeliveries, ...mergedDateDeliveries];
      
      return {
        hasChanges: true,
        deliveries: finalDeliveries
      };
      
    } catch (error) {
      if (error.message?.includes('WebSocket') || error.message?.includes('closed')) {
        console.warn('⚠️ [SmartRefresh] WebSocket connection issue, skipping delivery refresh');
        return null;
      }
      console.error('❌ [SmartRefresh] Error refreshing current day deliveries:', error);
      return null;
    }
  }

  /**
   * Smart refresh for AppUsers (includes driver_status, location, etc.)
   * Now with faster driver location polling (5s) vs full data (15s)
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
          
          // Track location refresh time
          if (shouldRefreshLocations) {
              this.lastDriverLocationRefresh = now;
          }

          const diff = diffEntityArrays(currentAppUsers, updatedAppUsers);
          
          if (diff.toUpdate.length === 0 && diff.toAdd.length === 0) {
              return null;
          }
          
          // Only log if significant changes (not just location updates during frequent polling)
          const hasSignificantChanges = diff.toUpdate.some(update => {
              const current = currentAppUsers.find(u => u.user_id === update.user_id);
              if (!current) return true;
              return current.driver_status !== update.driver_status ||
                     current.location_tracking_enabled !== update.location_tracking_enabled ||
                     JSON.stringify(current.store_ids) !== JSON.stringify(update.store_ids);
          });
          
          if (hasSignificantChanges) {
              logDiffStats('AppUser', diff);

              // Log specific changes
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
                      console.log(`   • ${update.user_name || update.user_id}: ${changedFields.join(', ')}`);
                  }
              });
          }
      
      const mergedAppUsers = mergeEntityChanges(currentAppUsers, diff);
      
      return {
        hasChanges: true,
        appUsers: mergedAppUsers
      };
      
    } catch (error) {
      console.error('❌ [SmartRefresh] Error refreshing AppUsers:', error);
      return null;
    }
  }
  
  /**
   * Fast driver location refresh - polls AppUsers for location changes only
   */
  async refreshDriverLocations(currentAppUsers) {
    try {
      if (!this.shouldRefresh('driverLocation')) {
        return null;
      }
      
      this.markRefreshed('driverLocation');
      await this.waitForRateLimit();
      
      // Only fetch AppUsers with location tracking enabled and on_duty status
      const locationFilter = {
        location_tracking_enabled: true,
        driver_status: 'on_duty'
      };
      
      const activeDrivers = await base44.entities.AppUser.filter(locationFilter);
      
      if (!activeDrivers || activeDrivers.length === 0) {
        return null;
      }
      
      // Check for location changes
      let hasLocationChanges = false;
      const updatedAppUsers = currentAppUsers.map(au => {
        const activeDriver = activeDrivers.find(ad => ad.user_id === au.user_id);
        if (activeDriver) {
          // Check if location actually changed
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
      
      console.log(`📍 [SmartRefresh] Driver locations updated (${activeDrivers.length} active drivers)`);
      
      return {
        hasChanges: true,
        appUsers: updatedAppUsers
      };
      
    } catch (error) {
      if (error.message?.includes('WebSocket') || error.message?.includes('closed')) {
        console.warn('⚠️ [SmartRefresh] WebSocket issue during location refresh');
        return null;
      }
      console.error('❌ [SmartRefresh] Error refreshing driver locations:', error);
      return null;
    }
  }

  /**
   * Smart refresh for patients (moderate frequency)
   * OPTIMIZED: Only fetches patients updated since last check - no full reloads
   * Patient data rarely changes during active delivery operations
   */
  async refreshPatients(currentPatients, filters) {
    try {
      // CRITICAL: Always require a timestamp to avoid full reloads
      // Patient data is loaded during initial load - only fetch incremental updates
      const lastTimestamp = getLatestUpdateTimestamp(currentPatients);
      
      if (!lastTimestamp) {
        // No existing patients means initial load hasn't completed - skip refresh
        console.log('⏭️ [SmartRefresh] Skipping patient refresh - no existing data (wait for initial load)');
        return null;
      }
      
      // Only fetch patients updated since last check (incremental only)
      const queryFilter = {
        ...filters,
        updated_date: {
          $gte: lastTimestamp.toISOString()
        }
      };
      
      const updatedPatients = await base44.entities.Patient.filter(queryFilter);
      
      if (!updatedPatients || updatedPatients.length === 0) {
        return null; // No changes - most common case
      }
      
      // Only log and process if there are actual updates
      console.log(`📋 [SmartRefresh] ${updatedPatients.length} patients updated since last check`);
      
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
   * Smart refresh for stores (low frequency)
   * Only fetches recently updated stores
   */
  async refreshStores(currentStores) {
    try {
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
      logDiffStats('Store', diff);
      
      if (diff.toUpdate.length === 0 && diff.toAdd.length === 0) {
        return null;
      }
      
      const mergedStores = mergeEntityChanges(currentStores, diff);
      
      return {
        hasChanges: true,
        stores: mergedStores
      };
      
    } catch (error) {
      // Gracefully handle WebSocket and network errors
      if (error.message?.includes('WebSocket') || error.message?.includes('closed')) {
        console.warn('⚠️ [SmartRefresh] WebSocket connection issue, skipping store refresh');
        return null;
      }
      console.error('❌ [SmartRefresh] Error refreshing stores:', error);
      return null;
    }
  }

  /**
   * Smart refresh for users (low frequency)
   * Fetches all User and AppUser data when AppUser changes are detected
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
      
      // If AppUser changed, we need to merge with User data
      // CRITICAL: Only fetch User.list() if user has admin permissions (others get 403)
      let authUsers = currentUsers || [];
      try {
        authUsers = await base44.entities.User.list();
        console.log('✅ [SmartRefresh] Fetched updated User list (admin access)');
      } catch (userError) {
        if (userError.response?.status === 403 || userError.message?.includes('403')) {
          console.log('🔒 [SmartRefresh] Cannot fetch User.list() - using current users (non-admin)');
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
      // Gracefully handle WebSocket and network errors
      if (error.message?.includes('WebSocket') || error.message?.includes('closed')) {
        console.warn('⚠️ [SmartRefresh] WebSocket connection issue, skipping user refresh');
        return null;
      }
      // Handle 403 gracefully for non-admins
      if (error.response?.status === 403 || error.message?.includes('403')) {
        console.log('🔒 [SmartRefresh] Access forbidden for User entity - skipping user refresh');
        return null;
      }
      console.error('❌ [SmartRefresh] Error refreshing users:', error);
      return null;
    }
  }

  /**
   * Fast delivery status refresh - polls for status changes on active deliveries
   * Called more frequently for real-time map updates
   */
  async refreshActiveDeliveryStatuses(currentDeliveries, selectedDate) {
    try {
      const dateStr = format(selectedDate, 'yyyy-MM-dd');
      
      // Only fetch today's active deliveries (in_transit, en_route)
      const activeFilter = {
        delivery_date: dateStr,
        status: { $in: ['in_transit', 'en_route', 'Ready For Pickup'] }
      };
      
      const activeDeliveries = await base44.entities.Delivery.filter(activeFilter);
      
      if (!activeDeliveries || activeDeliveries.length === 0) {
        return null;
      }
      
      // Check for status/ETA changes
      let hasChanges = false;
      const updatedDeliveries = currentDeliveries.map(d => {
        if (!d || d.delivery_date !== dateStr) return d;
        
        const activeVersion = activeDeliveries.find(ad => ad.id === d.id);
        if (activeVersion) {
          // Check if anything changed
          if (d.status !== activeVersion.status ||
              d.delivery_time_eta !== activeVersion.delivery_time_eta ||
              d.isNextDelivery !== activeVersion.isNextDelivery ||
              d.stop_order !== activeVersion.stop_order) {
            hasChanges = true;
            return activeVersion;
          }
        }
        return d;
      });
      
      // Also add any new active deliveries not in current state
      activeDeliveries.forEach(ad => {
        if (!updatedDeliveries.find(d => d?.id === ad.id)) {
          hasChanges = true;
          updatedDeliveries.push(ad);
        }
      });
      
      if (!hasChanges) {
        return null;
      }
      
      console.log(`📦 [SmartRefresh] Active delivery statuses updated (${activeDeliveries.length} active)`);
      
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
   * Full smart refresh - checks all entities based on their individual intervals
   * Uses staggered refresh to prevent rate limits while keeping data fresh
   */
  async performSmartRefresh(currentData, filters) {
    if (this.isRefreshing) {
      return null;
    }
    
    this.isRefreshing = true;
    const updates = {};
    
    try {
      // HIGH PRIORITY: Today's deliveries (10s interval)
      if (currentData.deliveries && filters.selectedDate && this.shouldRefresh('todayDeliveries')) {
        const deliveryUpdate = await this.refreshCurrentDayDeliveries(
          currentData.deliveries,
          filters.selectedDate,
          filters.deliveryFilter,
          filters.stores || [],
          filters.drivers || []
        );
        
        if (deliveryUpdate?.hasChanges) {
          updates.deliveries = deliveryUpdate.deliveries;
        }
        this.markRefreshed('todayDeliveries');
      }
      
      // HIGH PRIORITY: AppUsers - driver status, assignments (10s interval)
      if (currentData.appUsers && this.shouldRefresh('appUsers')) {
        const appUserUpdate = await this.refreshAppUsers(currentData.appUsers);
        
        if (appUserUpdate?.hasChanges) {
          updates.appUsers = appUserUpdate.appUsers;
        }
        this.markRefreshed('appUsers');
      }
      
      // LOW PRIORITY: Patients (30s interval)
      if (currentData.patients && currentData.patients.length > 0 && this.shouldRefresh('patients')) {
        const patientUpdate = await this.refreshPatients(
          currentData.patients,
          filters.patientFilter || {}
        );
        
        if (patientUpdate?.hasChanges) {
          updates.patients = patientUpdate.patients;
        }
        this.markRefreshed('patients');
      }
      
      // VERY LOW PRIORITY: Stores (60s interval)
      if (currentData.stores && currentData.stores.length > 0 && this.shouldRefresh('stores')) {
        const storeUpdate = await this.refreshStores(currentData.stores);
        
        if (storeUpdate?.hasChanges) {
          updates.stores = storeUpdate.stores;
        }
        this.markRefreshed('stores');
      }
      
      const hasAnyUpdates = Object.keys(updates).length > 0;

      if (hasAnyUpdates) {
          console.log('✅ [SmartRefresh] Updates found:', Object.keys(updates).join(', '));

          // Concise change summary - only log actual changes, not totals
          Object.keys(updates).forEach(key => {
              const oldData = currentData[key] || [];
              const newData = updates[key] || [];

              if (key === 'deliveries') {
                  const changes = newData.filter(newItem => {
                      const oldItem = oldData.find(o => o?.id === newItem?.id);
                      return !oldItem || JSON.stringify(oldItem) !== JSON.stringify(newItem);
                  });
                  if (changes.length > 0) {
                      console.log(`   📦 ${changes.length} delivery changes`);
                  }
              } else if (key === 'patients') {
                  const changes = newData.filter(newItem => {
                      const oldItem = oldData.find(o => o?.id === newItem?.id);
                      return !oldItem || JSON.stringify(oldItem) !== JSON.stringify(newItem);
                  });
                  if (changes.length > 0) {
                      console.log(`   👤 ${changes.length} patient changes`);
                  }
              } else if (key === 'appUsers') {
                  const changes = newData.filter(newItem => {
                      const oldItem = oldData.find(o => o?.user_id === newItem?.user_id);
                      return !oldItem || JSON.stringify(oldItem) !== JSON.stringify(newItem);
                  });
                  if (changes.length > 0) {
                      console.log(`   👥 ${changes.length} appUser changes`);
                  }
              }
          });
      }
      // Skip logging "no updates needed" - too noisy
      
      return hasAnyUpdates ? updates : null;
      
    } catch (error) {
      console.error('❌ [SmartRefresh] Error during smart refresh:', error);
      return null;
    } finally {
      this.isRefreshing = false;
    }
  }
}

export const smartRefreshManager = new SmartRefreshManager();