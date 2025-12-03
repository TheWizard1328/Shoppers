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
    
    // Real-time refresh intervals (milliseconds) - BALANCED for responsiveness vs rate limits
    this.intervals = {
      driverLocation: 30000,     // 30s - driver GPS locations
      activeDeliveries: 15000,   // 15s - active delivery statuses for map (CRITICAL for real-time)
      todayDeliveries: 30000,    // 30s - today's delivery changes (CRITICAL for cross-device sync)
      appUsers: 60000,           // 60s - driver status, assignments
      patients: 300000,          // 5min - patient data rarely changes
      stores: 600000             // 10min - store data almost never changes
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
    
    // Rate limit protection - INCREASED to prevent 429 errors
    this.lastApiCallTime = 0;
    this.minTimeBetweenCalls = 3000; // 3 seconds minimum between any API call (increased from 2s)
    
    // Rate limit error callback
    this.rateLimitCallback = null;
    
    // CRITICAL: Track deliveries that have pending local updates
    // This prevents smart refresh from overwriting them with stale DB data
    this.pendingLocalUpdates = new Map(); // deliveryId -> timestamp
  }
  
  /**
   * Register a pending local update for a delivery
   * This prevents smart refresh from overwriting it for 5 seconds
   */
  registerPendingUpdate(deliveryId) {
    const expiresAt = Date.now() + 5000; // 5 second protection window
    this.pendingLocalUpdates.set(deliveryId, expiresAt);
    console.log(`🔒 [SmartRefresh] Protected delivery ${deliveryId} from overwrite (5s window)`);
  }
  
  /**
   * Check if a delivery has a pending local update
   */
  hasPendingUpdate(deliveryId) {
    const expiresAt = this.pendingLocalUpdates.get(deliveryId);
    if (!expiresAt) return false;
    
    // Check if protection window expired
    if (Date.now() > expiresAt) {
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
  
  setRateLimitCallback(callback) {
    this.rateLimitCallback = callback;
  }
  
  notifyRateLimit(hasError) {
    if (this.rateLimitCallback) {
      this.rateLimitCallback(hasError);
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
      if (skipRefresh) {
          console.log('🔄 [Smart Refresh] ⏸️ SKIPPED - Entity update in progress');
          return null;
      }

      try {
          console.log('');
          console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          console.log('🔄 [DELIVERY REFRESH] DETAILED EXECUTION LOG');
          console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          const dateStr = format(selectedDate, 'yyyy-MM-dd');
          console.log(`📅 Target Date: ${dateStr}`);

          // CRITICAL: Only work with selected date deliveries - leave all other dates untouched
          const currentDateDeliveries = currentDeliveries.filter(d => d && d.delivery_date === dateStr);
          console.log(`📊 Current State: ${currentDateDeliveries.length} deliveries in memory for ${dateStr}`);
          console.log(`📊 Total Deliveries: ${currentDeliveries.length} (all dates)`);

          const lastTimestamp = getLatestUpdateTimestamp(currentDateDeliveries);
          console.log(`🕐 Last Update Timestamp: ${lastTimestamp?.toISOString() || 'NONE (initial load)'}`);

          if (!lastTimestamp && currentDateDeliveries.length > 0) {
              console.log('⏭️ SKIP: Have data but no timestamp - already loaded');
              console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
              return null;
          }

          const dateFilter = {
              ...filters,
              delivery_date: dateStr
          };
          
          if (lastTimestamp) {
              dateFilter.updated_date = {
                  $gte: lastTimestamp.toISOString()
              };
              console.log(`🔍 Query Mode: INCREMENTAL (only records updated after ${lastTimestamp.toISOString()})`);
          } else {
              console.log(`🔍 Query Mode: FULL FETCH (initial load for ${dateStr})`);
          }
          
          console.log(`📡 API CALL: base44.entities.Delivery.filter(${JSON.stringify(dateFilter)})`);
      
      const updatedDeliveries = await base44.entities.Delivery.filter(dateFilter);
      console.log(`✅ API Response: ${updatedDeliveries?.length || 0} records returned`);

      if (lastTimestamp) {
          if (!updatedDeliveries || updatedDeliveries.length === 0) {
              console.log('✅ Result: NO CHANGES (incremental check found 0 updated records)');
              console.log('🎯 Action: SKIP - keeping existing data unchanged');
              console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
              this.notifyRateLimit(false);
              return null;
          }
          console.log(`✅ Result: ${updatedDeliveries.length} records updated since last check`);
      } else {
          if (!updatedDeliveries || updatedDeliveries.length === 0) {
              console.log('✅ Result: NO DATA (initial fetch found 0 records)');
              console.log('🎯 Action: SKIP - no deliveries for this date');
              console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
              this.notifyRateLimit(false);
              return null;
          }
          console.log(`✅ Result: ${updatedDeliveries.length} records (initial load)`);
      }

      // CRITICAL: Filter out deliveries with pending local updates
      const protectedDeliveryIds = [];
      const filteredUpdatedDeliveries = updatedDeliveries.filter(d => {
        if (this.hasPendingUpdate(d.id)) {
          protectedDeliveryIds.push(d.id);
          return false;
        }
        return true;
      });
      
      if (protectedDeliveryIds.length > 0) {
        console.log(`🔒 Protected ${protectedDeliveryIds.length} deliveries with pending local updates`);
      }

      console.log('');
      console.log('🔍 DIFF COMPUTATION:');
      const diff = diffEntityArrays(currentDateDeliveries, filteredUpdatedDeliveries);
      console.log(`   Old Data: ${currentDateDeliveries.length} deliveries`);
      console.log(`   New Data: ${filteredUpdatedDeliveries.length} deliveries (${protectedDeliveryIds.length} protected)`);
      console.log(`   To Add: ${diff.toAdd.length}`);
      console.log(`   To Update: ${diff.toUpdate.length}`);
      console.log(`   To Remove: ${diff.toRemove.length}`);

      if (diff.toUpdate.length === 0 && diff.toAdd.length === 0 && diff.toRemove.length === 0) {
          console.log('✅ Result: NO CHANGES (data identical after diff)');
          console.log('🎯 Action: SKIP - keeping existing data unchanged');
          console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          this.notifyRateLimit(false);
          return null;
      }

      if (diff.toUpdate.length > 0) {
          console.log('');
          console.log('📝 UPDATES DETECTED:');
          diff.toUpdate.forEach(d => {
              const old = currentDateDeliveries.find(cd => cd.id === d.id);
              console.log(`   • ${d.patient_name || 'Pickup'}:`);
              if (old?.stop_order !== d.stop_order) {
                  console.log(`      - stop_order: ${old?.stop_order} → ${d.stop_order}`);
              }
              if (old?.status !== d.status) {
                  console.log(`      - status: ${old?.status} → ${d.status}`);
              }
              if (old?.delivery_time_eta !== d.delivery_time_eta) {
                  console.log(`      - ETA: ${old?.delivery_time_eta} → ${d.delivery_time_eta}`);
              }
              if (old?.isNextDelivery !== d.isNextDelivery) {
                  console.log(`      - isNext: ${old?.isNextDelivery} → ${d.isNextDelivery}`);
              }
          });
      }
      
      if (diff.toAdd.length > 0) {
          console.log('');
          console.log('➕ ADDITIONS:');
          diff.toAdd.forEach(d => {
              console.log(`   • ${d.patient_name || 'Pickup'} (Stop #${d.stop_order})`);
          });
      }
      
      if (diff.toRemove.length > 0) {
          console.log('');
          console.log('➖ REMOVALS:');
          diff.toRemove.forEach(id => {
              const removed = currentDateDeliveries.find(d => d.id === id);
              console.log(`   • ${removed?.patient_name || 'Unknown'} (ID: ${id})`);
          });
      }

      // Merge changes and preserve protected deliveries
      console.log('');
      console.log('🔀 MERGE OPERATION:');
      const mergedDateDeliveries = mergeEntityChanges(currentDateDeliveries, diff);
      
      // CRITICAL: Re-apply protected deliveries from currentDeliveries (keep local updates)
      const finalMergedDeliveries = mergedDateDeliveries.map(d => {
        if (this.hasPendingUpdate(d.id)) {
          const localVersion = currentDateDeliveries.find(cd => cd.id === d.id);
          if (localVersion) {
            console.log(`   🔒 Preserving local update for: ${d.patient_name || 'Pickup'}`);
            return localVersion;
          }
        }
        return d;
      });
      
      const otherDateDeliveries = currentDeliveries.filter(d => d && d.delivery_date !== dateStr);
      const finalDeliveries = [...otherDateDeliveries, ...finalMergedDeliveries];

      console.log(`   Input: ${currentDateDeliveries.length} current + diff (${diff.toAdd.length} add, ${diff.toUpdate.length} update, ${diff.toRemove.length} remove)`);
      console.log(`   Output: ${finalMergedDeliveries.length} merged for ${dateStr}`);
      console.log(`   Preserved: ${otherDateDeliveries.length} deliveries from other dates`);
      console.log(`   Final Total: ${finalDeliveries.length} deliveries (all dates)`);
      console.log('');
      console.log('🎯 Action: APPLY CHANGES - updating state');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

      this.notifyRateLimit(false);
      return {
        hasChanges: true,
        deliveries: finalDeliveries
      };
      
    } catch (error) {
      if (error.message?.includes('WebSocket') || error.message?.includes('closed')) {
        console.warn('⚠️ [SmartRefresh] WebSocket connection issue, skipping delivery refresh');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        this.notifyRateLimit(false);
        return null;
      }
      
      if (error.response?.status === 429 || error.message?.includes('429') || error.message?.includes('rate limit')) {
        console.error('🚨 [RATE LIMIT] 429 Error detected!');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        this.notifyRateLimit(true);
        return null;
      }
      
      console.error('❌ [SmartRefresh] Error refreshing current day deliveries:', error);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
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
      console.log(`🔍 [SmartRefresh] Fetched ${appUsers?.length || 0} AppUsers`);
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
      console.log('');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('🔄 [DELIVERY REFRESH] TODAY + 7 DAYS ONLY');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      
      const today = new Date();
      const todayStr = format(today, 'yyyy-MM-dd');
      const futureDate = new Date(today);
      futureDate.setDate(futureDate.getDate() + 7);
      const futureDateStr = format(futureDate, 'yyyy-MM-dd');
      
      console.log(`📅 Refresh Range: ${todayStr} to ${futureDateStr} (today + 7 days)`);
      
      const relevantCurrentDeliveries = currentDeliveries.filter(d => 
        d && d.delivery_date && d.delivery_date >= todayStr && d.delivery_date <= futureDateStr
      );
      const pastDeliveries = currentDeliveries.filter(d => 
        d && d.delivery_date && d.delivery_date < todayStr
      );
      
      console.log(`📊 Current State: ${relevantCurrentDeliveries.length} in refresh window, ${pastDeliveries.length} past (untouched)`);
      
      const lastTimestamp = getLatestUpdateTimestamp(relevantCurrentDeliveries);
      console.log(`🕐 Last Update: ${lastTimestamp?.toISOString() || 'NONE'}`);
      
      const dateFilter = {
        ...filters,
        delivery_date: {
          $gte: todayStr,
          $lte: futureDateStr
        }
      };
      
      if (lastTimestamp && relevantCurrentDeliveries.length > 0) {
        dateFilter.updated_date = {
          $gte: lastTimestamp.toISOString()
        };
        console.log(`🔍 Mode: INCREMENTAL (updates since ${lastTimestamp.toISOString()})`);
      } else {
        console.log(`🔍 Mode: FULL (initial load for date range)`);
      }
      
      await this.waitForRateLimit();
      console.log(`📡 API: Delivery.filter for ${todayStr} to ${futureDateStr}`);
      
      const updatedDeliveries = await base44.entities.Delivery.filter(dateFilter);
      console.log(`✅ Response: ${updatedDeliveries?.length || 0} records`);
      
      if (!updatedDeliveries || updatedDeliveries.length === 0) {
        if (lastTimestamp) {
          console.log('✅ No changes in date range');
        } else {
          console.log('✅ No deliveries in date range');
        }
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        this.notifyRateLimit(false);
        return null;
      }
      
      // CRITICAL: Filter out protected deliveries
      const protectedDeliveryIds = [];
      const filteredUpdatedDeliveries = updatedDeliveries.filter(d => {
        if (this.hasPendingUpdate(d.id)) {
          protectedDeliveryIds.push(d.id);
          return false;
        }
        return true;
      });
      
      if (protectedDeliveryIds.length > 0) {
        console.log(`🔒 Protected ${protectedDeliveryIds.length} deliveries with pending local updates`);
      }
      
      const diff = diffEntityArrays(relevantCurrentDeliveries, filteredUpdatedDeliveries);
      console.log(`🔍 Diff: +${diff.toAdd.length} add, ~${diff.toUpdate.length} update, -${diff.toRemove.length} remove`);
      
      if (diff.toUpdate.length === 0 && diff.toAdd.length === 0 && diff.toRemove.length === 0) {
        console.log('✅ No changes after diff');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        this.notifyRateLimit(false);
        return null;
      }
      
      const mergedRelevantDeliveries = mergeEntityChanges(relevantCurrentDeliveries, diff);
      
      // CRITICAL: Re-apply protected deliveries from currentDeliveries
      const finalMergedRelevant = mergedRelevantDeliveries.map(d => {
        if (this.hasPendingUpdate(d.id)) {
          const localVersion = relevantCurrentDeliveries.find(cd => cd.id === d.id);
          if (localVersion) {
            console.log(`   🔒 Preserving local update for: ${d.patient_name || 'Pickup'}`);
            return localVersion;
          }
        }
        return d;
      });
      
      const finalDeliveries = [...pastDeliveries, ...finalMergedRelevant];
      
      console.log(`🔀 Merged: ${finalMergedRelevant.length} relevant + ${pastDeliveries.length} past = ${finalDeliveries.length} total`);
      console.log('🎯 Action: APPLY CHANGES');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      
      this.notifyRateLimit(false);
      return {
        hasChanges: true,
        deliveries: finalDeliveries
      };
      
    } catch (error) {
      if (error.message?.includes('WebSocket') || error.message?.includes('closed')) {
        console.warn('⚠️ WebSocket issue, skipping');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        this.notifyRateLimit(false);
        return null;
      }
      
      if (error.response?.status === 429 || error.message?.includes('429')) {
        console.error('🚨 RATE LIMIT ERROR');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        this.notifyRateLimit(true);
        return null;
      }
      
      console.error('❌ Error:', error.message);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
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
   */
  async refreshDriverLocations(currentAppUsers) {
    try {
      if (!this.shouldRefresh('driverLocation')) {
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
      
      console.log(`📍 [SmartRefresh] Driver locations updated (${activeDrivers.length} active drivers)`);
      
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
   * Smart refresh for patients
   */
  async refreshPatients(currentPatients, filters) {
    try {
      const lastTimestamp = getLatestUpdateTimestamp(currentPatients);
      
      if (!lastTimestamp) {
        console.log('⏭️ [SmartRefresh] Skipping patient refresh - no existing data (wait for initial load)');
        return null;
      }
      
      const queryFilter = {
        ...filters,
        updated_date: {
          $gte: lastTimestamp.toISOString()
        }
      };
      
      const updatedPatients = await base44.entities.Patient.filter(queryFilter);
      
      if (!updatedPatients || updatedPatients.length === 0) {
        return null;
      }
      
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
   * Smart refresh for stores
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
      if (error.message?.includes('WebSocket') || error.message?.includes('closed')) {
        console.warn('⚠️ [SmartRefresh] WebSocket connection issue, skipping user refresh');
        return null;
      }
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
   */
  async refreshActiveDeliveryStatuses(currentDeliveries, selectedDate) {
    try {
      if (!this.shouldRefresh('activeDeliveries')) {
        return null;
      }
      
      this.markRefreshed('activeDeliveries');
      await this.waitForRateLimit();
      
      const dateStr = format(selectedDate, 'yyyy-MM-dd');
      
      const activeFilter = {
        delivery_date: dateStr,
        status: { $in: ['in_transit', 'en_route', 'Ready For Pickup'] }
      };
      
      const activeDeliveries = await base44.entities.Delivery.filter(activeFilter);
      
      if (!activeDeliveries || activeDeliveries.length === 0) {
        return null;
      }
      
      // CRITICAL: Filter out protected deliveries
      const protectedCount = activeDeliveries.filter(d => this.hasPendingUpdate(d.id)).length;
      
      let hasChanges = false;
      const updatedDeliveries = currentDeliveries.map(d => {
        if (!d || d.delivery_date !== dateStr) return d;
        
        // CRITICAL: Skip if delivery has pending local update
        if (this.hasPendingUpdate(d.id)) {
          return d;
        }
        
        const activeVersion = activeDeliveries.find(ad => ad.id === d.id);
        if (activeVersion) {
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
      
      activeDeliveries.forEach(ad => {
        if (!updatedDeliveries.find(d => d?.id === ad.id) && !this.hasPendingUpdate(ad.id)) {
          hasChanges = true;
          updatedDeliveries.push(ad);
        }
      });
      
      if (!hasChanges) {
        return null;
      }
      
      if (protectedCount > 0) {
        console.log(`📦 [SmartRefresh] Active delivery statuses updated (${activeDeliveries.length} active, ${protectedCount} protected)`);
      } else {
        console.log(`📦 [SmartRefresh] Active delivery statuses updated (${activeDeliveries.length} active)`);
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
   * Full smart refresh - checks all entities based on their individual intervals
   */
  async performSmartRefresh(currentData, filters, isEntityUpdating = false) {
    if (isEntityUpdating) {
      console.log('🔄 [Smart Refresh] ⏸️ PAUSED - Entity update in progress');
      return null;
    }
    
    if (this.isRefreshing) {
      return null;
    }
    
    this.isRefreshing = true;
    const updates = {};
    
    try {
      // HIGH PRIORITY: Today + next 7 days deliveries only
      if (currentData.deliveries && filters.selectedDate && this.shouldRefresh('todayDeliveries')) {
        const deliveryUpdate = await this.refreshRelevantDeliveries(
          currentData.deliveries,
          filters.selectedDate,
          filters.deliveryFilter
        );
        
        if (deliveryUpdate?.hasChanges) {
          updates.deliveries = deliveryUpdate.deliveries;
        }
        this.markRefreshed('todayDeliveries');
      }
      
      // HIGH PRIORITY: AppUsers
      if (currentData.appUsers && this.shouldRefresh('appUsers')) {
        const appUserUpdate = await this.refreshAppUsers(currentData.appUsers);
        
        if (appUserUpdate?.hasChanges) {
          updates.appUsers = appUserUpdate.appUsers;
        }
        this.markRefreshed('appUsers');
      }
      
      // LOW PRIORITY: Patients
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
      
      // VERY LOW PRIORITY: Stores
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