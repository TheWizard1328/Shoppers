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
    this.minRefreshInterval = 14900; // ~15 seconds minimum between refreshes (with buffer for timing variations)
    this.lastFullRefreshTime = 0; // Track full refresh separately
    this.lastDriverLocationRefresh = 0; // Track driver location refresh separately
    this.driverLocationRefreshInterval = 5000; // 5 seconds for driver locations (more real-time)
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
   * Smart refresh for current day deliveries (high frequency)
   * Uses incremental updates based on updated_date timestamp
   */
  async refreshCurrentDayDeliveries(currentDeliveries, selectedDate, filters, stores = [], drivers = []) {
      try {
          const dateStr = format(selectedDate, 'yyyy-MM-dd');
          
          // Get current day deliveries from state
          const currentTodayDeliveries = currentDeliveries.filter(d => d && d.delivery_date === dateStr);
          const otherDayDeliveries = currentDeliveries.filter(d => d && d.delivery_date !== dateStr);
          
          // Get the latest update timestamp from current day's deliveries
          const lastTimestamp = getLatestUpdateTimestamp(currentTodayDeliveries);

          // Build filter for incremental fetch
          const todayFilter = {
              ...filters,
              delivery_date: dateStr
          };
          
          // If we have existing data, only fetch records updated since last check
          if (lastTimestamp && currentTodayDeliveries.length > 0) {
              todayFilter.updated_date = {
                  $gte: lastTimestamp.toISOString()
              };
              console.log(`🔍 [SmartRefresh] Incremental fetch for ${dateStr} (since ${lastTimestamp.toISOString()})`);
          } else {
              console.log(`🔍 [SmartRefresh] Full fetch for ${dateStr} (no existing data)`);
          }
      
      const updatedDeliveries = await base44.entities.Delivery.filter(todayFilter);
      
      // If incremental and no updates, skip processing
      if (lastTimestamp && currentTodayDeliveries.length > 0) {
          if (!updatedDeliveries || updatedDeliveries.length === 0) {
              return null; // No changes
          }
          console.log(`📦 [SmartRefresh] ${updatedDeliveries.length} deliveries updated since last check`);
      } else {
          console.log(`📦 [SmartRefresh] Fetched ${updatedDeliveries?.length || 0} deliveries for ${dateStr}`);
          if (!updatedDeliveries || updatedDeliveries.length === 0) {
              return null;
          }
      }
      
      // Diff and merge
      const diff = diffEntityArrays(currentTodayDeliveries, updatedDeliveries);
      
      // Only log if there are actual changes
      if (diff.toUpdate.length > 0 || diff.toAdd.length > 0 || diff.toRemove.length > 0) {
          logDiffStats('Delivery (Today)', diff);
      }
      
      // If no real changes, skip state update
      if (diff.toUpdate.length === 0 && diff.toAdd.length === 0 && diff.toRemove.length === 0) {
          return null;
      }
      
      // Merge today's changes with other days
      const mergedTodayDeliveries = mergeEntityChanges(currentTodayDeliveries, diff);
      const finalDeliveries = [...otherDayDeliveries, ...mergedTodayDeliveries];
      
      return {
        hasChanges: true,
        deliveries: finalDeliveries
      };
      
    } catch (error) {
      // Gracefully handle WebSocket and network errors
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
   * Called more frequently (5s) than full smart refresh (15s)
   */
  async refreshDriverLocations(currentAppUsers) {
    try {
      const now = Date.now();
      const timeSinceLastRefresh = now - this.lastDriverLocationRefresh;
      
      // Only refresh if 5 seconds have passed
      if (timeSinceLastRefresh < this.driverLocationRefreshInterval) {
        return null;
      }
      
      this.lastDriverLocationRefresh = now;
      
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
   * Only fetches recently updated patients
   */
  async refreshPatients(currentPatients, filters) {
    try {
      const lastTimestamp = getLatestUpdateTimestamp(currentPatients);
      
      let queryFilter = { ...filters };
      
      if (lastTimestamp) {
        // Only fetch patients updated in the last 24 hours
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        if (lastTimestamp > oneDayAgo) {
          queryFilter.updated_date = {
            $gte: lastTimestamp.toISOString()
          };
        }
      }
      
      const updatedPatients = await base44.entities.Patient.filter(queryFilter);
      
      if (!updatedPatients || updatedPatients.length === 0) {
        return null;
      }
      
      const diff = diffEntityArrays(currentPatients, updatedPatients);
      logDiffStats('Patient', diff);
      
      if (diff.toUpdate.length === 0 && diff.toAdd.length === 0) {
        return null;
      }
      
      const mergedPatients = mergeEntityChanges(currentPatients, diff);
      
      return {
        hasChanges: true,
        patients: mergedPatients
      };
      
    } catch (error) {
      // Gracefully handle WebSocket and network errors
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
   * Full smart refresh - checks all entities and only updates what's changed
   * NOW WITH THROTTLING to prevent rate limits
   */
  async performSmartRefresh(currentData, filters) {
    const now = Date.now();
    const timeSinceLastRefresh = now - this.lastFullRefreshTime;

    // Throttle: if last refresh was less than minRefreshInterval ago, skip
    if (timeSinceLastRefresh < this.minRefreshInterval && this.lastFullRefreshTime > 0) {
      console.log(`⏭️ [SmartRefresh] Throttled - last refresh was ${Math.round(timeSinceLastRefresh / 1000)}s ago (min: ${Math.round(this.minRefreshInterval / 1000)}s)`);
      return null;
    }
    
    if (this.isRefreshing) {
      console.log('⏭️ [SmartRefresh] Already refreshing, skipping...');
      return null;
    }
    
    this.isRefreshing = true;
    this.lastFullRefreshTime = now;
    const updates = {};
    
    try {
      console.log('🔄 [SmartRefresh] Starting refresh cycle...');
      
      // Refresh current day deliveries (high priority)
      if (currentData.deliveries && filters.selectedDate) {
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
      }
      
      // Refresh AppUsers (includes driver_status, location, etc.)
      if (currentData.appUsers) {
        const appUserUpdate = await this.refreshAppUsers(currentData.appUsers);
        
        if (appUserUpdate?.hasChanges) {
          updates.appUsers = appUserUpdate.appUsers;
        }
      }
      
      // Refresh patients (moderate priority)
      if (currentData.patients && filters.patientFilter) {
        const patientUpdate = await this.refreshPatients(
          currentData.patients,
          filters.patientFilter
        );
        
        if (patientUpdate?.hasChanges) {
          updates.patients = patientUpdate.patients;
        }
      }
      
      // Refresh stores (low priority)
      if (currentData.stores) {
        const storeUpdate = await this.refreshStores(currentData.stores);
        
        if (storeUpdate?.hasChanges) {
          updates.stores = storeUpdate.stores;
        }
      }
      
      // Refresh users (low priority) - AppUser only for non-admins
      if (currentData.appUsers) {
        const userUpdate = await this.refreshUsers(
          currentData.users || [],
          currentData.appUsers
        );
        
        if (userUpdate?.hasChanges) {
          if (userUpdate.users) {
            updates.users = userUpdate.users;
          }
          updates.appUsers = userUpdate.appUsers;
          // Invalidate auth cache so getEffectiveUser() fetches fresh data
          console.log('🔄 [SmartRefresh] AppUser changes detected - invalidating user cache');
          invalidate('User');
          invalidate('AppUser');
        }
      }
      
      const hasAnyUpdates = Object.keys(updates).length > 0;

      if (hasAnyUpdates) {
          console.log('✅ [SmartRefresh] Updates found:', Object.keys(updates).join(', '));

          // Detailed change summary
          Object.keys(updates).forEach(key => {
              const oldData = currentData[key] || [];
              const newData = updates[key] || [];

              if (key === 'deliveries') {
                  const changes = newData.filter(newItem => {
                      const oldItem = oldData.find(o => o?.id === newItem?.id);
                      return !oldItem || JSON.stringify(oldItem) !== JSON.stringify(newItem);
                  });
                  if (changes.length > 0) {
                      console.log(`   📦 Deliveries: ${changes.length} changed/new`);
                      changes.slice(0, 3).forEach(d => {
                          console.log(`      - ${d.delivery_id || d.id}: ${d.status}`);
                      });
                  }
              } else if (key === 'patients') {
                  console.log(`   👤 Patients: ${newData.length} total`);
              } else if (key === 'appUsers') {
                  const changes = newData.filter(newItem => {
                      const oldItem = oldData.find(o => o?.user_id === newItem?.user_id);
                      return !oldItem || JSON.stringify(oldItem) !== JSON.stringify(newItem);
                  });
                  if (changes.length > 0) {
                      console.log(`   👥 AppUsers: ${changes.length} changed`);
                      changes.forEach(au => {
                          const old = oldData.find(o => o?.user_id === au?.user_id);
                          const changedFields = [];
                          if (old) {
                              if (JSON.stringify(old.store_ids) !== JSON.stringify(au.store_ids)) {
                                  changedFields.push(`store_ids: ${JSON.stringify(old.store_ids)} → ${JSON.stringify(au.store_ids)}`);
                              }
                              if (old.city_id !== au.city_id) changedFields.push(`city_id`);
                              if (JSON.stringify(old.app_roles) !== JSON.stringify(au.app_roles)) {
                                  changedFields.push(`app_roles`);
                              }
                              if (old.driver_status !== au.driver_status) {
                                  changedFields.push(`driver_status: ${old.driver_status} → ${au.driver_status}`);
                              }
                          }
                          if (changedFields.length > 0) {
                              console.log(`      - ${au.user_name || au.user_id}: ${changedFields.join(', ')}`);
                          }
                      });
                  }
              } else if (key === 'stores') {
                  console.log(`   🏪 Stores: ${newData.length} total`);
              } else if (key === 'users') {
                  console.log(`   👤 Users: ${newData.length} total`);
              }
          });
      } else {
          console.log('✅ [SmartRefresh] No updates needed');
      }
      
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