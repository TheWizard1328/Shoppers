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
    
    // Real-time refresh intervals (milliseconds) - AGGRESSIVELY INCREASED to prevent rate limits
    this.intervals = {
      driverLocation: 20000,     // 20s - driver GPS locations
      activeDeliveries: 30000,   // 30s - active delivery statuses for map
      todayDeliveries: 60000,    // 60s - today's delivery changes
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
    this.minTimeBetweenCalls = 2000; // 2 seconds minimum between any API call
    
    // Rate limit error callback
    this.rateLimitCallback = null;
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
   * Smart refresh for TODAY + NEXT 7 DAYS deliveries only
   * OPTIMIZED: Never touches past deliveries - they don't change
   * Uses incremental updates based on updated_date timestamp
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
      
      // Filter current deliveries to only those in our refresh window
      const relevantCurrentDeliveries = currentDeliveries.filter(d => 
        d && d.delivery_date && d.delivery_date >= todayStr && d.delivery_date <= futureDateStr
      );
      const pastDeliveries = currentDeliveries.filter(d => 
        d && d.delivery_date && d.delivery_date < todayStr
      );
      
      console.log(`📊 Current State: ${relevantCurrentDeliveries.length} in refresh window, ${pastDeliveries.length} past (untouched)`);
      
      // Get latest timestamp from relevant deliveries only
      const lastTimestamp = getLatestUpdateTimestamp(relevantCurrentDeliveries);
      console.log(`🕐 Last Update: ${lastTimestamp?.toISOString() || 'NONE'}`);
      
      // Build filter for today + next 7 days only
      const dateFilter = {
        ...filters,
        delivery_date: {
          $gte: todayStr,
          $lte: futureDateStr
        }
      };
      
      // If we have existing data, only fetch records updated since last check
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
      
      // Diff against relevant deliveries only
      const diff = diffEntityArrays(relevantCurrentDeliveries, updatedDeliveries);
      console.log(`🔍 Diff: +${diff.toAdd.length} add, ~${diff.toUpdate.length} update, -${diff.toRemove.length} remove`);
      
      if (diff.toUpdate.length === 0 && diff.toAdd.length === 0 && diff.toRemove.length === 0) {
        console.log('✅ No changes after diff');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        this.notifyRateLimit(false);
        return null;
      }
      
      // Merge only relevant date changes, preserve ALL past dates exactly as-is
      const mergedRelevantDeliveries = mergeEntityChanges(relevantCurrentDeliveries, diff);
      const finalDeliveries = [...pastDeliveries, ...mergedRelevantDeliveries];
      
      console.log(`🔀 Merged: ${mergedRelevantDeliveries.length} relevant + ${pastDeliveries.length} past = ${finalDeliveries.length} total`);
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
        this.notifyRateLimit(false);
        return null;
      }
      
      if (error.response?.status === 429 || error.message?.includes('429')) {
        console.error('🚨 RATE LIMIT ERROR');
        this.notifyRateLimit(true);
        return null;
      }
      
      console.error('❌ Error:', error.message);
      this.notifyRateLimit(false);
      return null;
    }
  }

  /**
   * Smart refresh for SELECTED DATE deliveries only (legacy - used for specific date views)
   * OPTIMIZED: Only refreshes the selected date's deliveries - never touches historical data
   * Uses incremental updates based on updated_date timestamp
   */
  async refreshCurrentDayDeliveries(currentDeliveries, selectedDate, filters, stores = [], drivers = [], skipRefresh = false) {
      // CRITICAL: Skip if entity updating is in progress (e.g., Start button clicked)
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

          // Get the latest update timestamp from selected date's deliveries
          const lastTimestamp = getLatestUpdateTimestamp(currentDateDeliveries);
          console.log(`🕐 Last Update Timestamp: ${lastTimestamp?.toISOString() || 'NONE (initial load)'}`);

          // ALWAYS use incremental fetch - never do full reload
          if (!lastTimestamp && currentDateDeliveries.length > 0) {
              console.log('⏭️ SKIP: Have data but no timestamp - already loaded');
              console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
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
              console.log(`🔍 Query Mode: INCREMENTAL (only records updated after ${lastTimestamp.toISOString()})`);
          } else {
              console.log(`🔍 Query Mode: FULL FETCH (initial load for ${dateStr})`);
          }
          
          console.log(`📡 API CALL: base44.entities.Delivery.filter(${JSON.stringify(dateFilter)})`);
      
      const updatedDeliveries = await base44.entities.Delivery.filter(dateFilter);
      console.log(`✅ API Response: ${updatedDeliveries?.length || 0} records returned`);

      // If incremental and no updates, skip processing (most common case)
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
          // Only log full fetch if it actually happens (initial load)
          if (!updatedDeliveries || updatedDeliveries.length === 0) {
              console.log('✅ Result: NO DATA (initial fetch found 0 records)');
              console.log('🎯 Action: SKIP - no deliveries for this date');
              console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
              this.notifyRateLimit(false);
              return null;
          }
          console.log(`✅ Result: ${updatedDeliveries.length} records (initial load)`);
      }

      // Diff and merge
      console.log('');
      console.log('🔍 DIFF COMPUTATION:');
      const diff = diffEntityArrays(currentDateDeliveries, updatedDeliveries);
      console.log(`   Old Data: ${currentDateDeliveries.length} deliveries`);
      console.log(`   New Data: ${updatedDeliveries.length} deliveries`);
      console.log(`   To Add: ${diff.toAdd.length}`);
      console.log(`   To Update: ${diff.toUpdate.length}`);
      console.log(`   To Remove: ${diff.toRemove.length}`);

      // If no real changes, skip state update
      if (diff.toUpdate.length === 0 && diff.toAdd.length === 0 && diff.toRemove.length === 0) {
          console.log('✅ Result: NO CHANGES (data identical after diff)');
          console.log('🎯 Action: SKIP - keeping existing data unchanged');
          console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          this.notifyRateLimit(false);
          return null;
      }

      // Log changes in detail
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

      // CRITICAL: Merge only selected date changes, preserve ALL other dates exactly as-is
      console.log('');
      console.log('🔀 MERGE OPERATION:');
      const mergedDateDeliveries = mergeEntityChanges(currentDateDeliveries, diff);
      const otherDateDeliveries = currentDeliveries.filter(d => d && d.delivery_date !== dateStr);
      const finalDeliveries = [...otherDateDeliveries, ...mergedDateDeliveries];

      console.log(`   Input: ${currentDateDeliveries.length} current + diff (${diff.toAdd.length} add, ${diff.toUpdate.length} update, ${diff.toRemove.length} remove)`);
      console.log(`   Output: ${mergedDateDeliveries.length} merged for ${dateStr}`);
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
      
      // Rate limit detection
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
      if (!this.shouldRefresh('activeDeliveries')) {
        return null;
      }
      
      this.markRefreshed('activeDeliveries');
      await this.waitForRateLimit();
      
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
   * OPTIMIZED: Only refreshes today + next 7 days of deliveries - past deliveries are static
   * @param {Object} currentData - Current state data
   * @param {Object} filters - Query filters
   * @param {boolean} isEntityUpdating - If true, skip refresh (entity update in progress)
   */
  async performSmartRefresh(currentData, filters, isEntityUpdating = false) {
    // CRITICAL: Skip if entity update in progress (e.g., Start button clicked)
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
      // HIGH PRIORITY: Today + next 7 days deliveries only (past deliveries don't change)
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
      
      // HIGH PRIORITY: AppUsers - driver status, assignments (60s interval)
      if (currentData.appUsers && this.shouldRefresh('appUsers')) {
        const appUserUpdate = await this.refreshAppUsers(currentData.appUsers);
        
        if (appUserUpdate?.hasChanges) {
          updates.appUsers = appUserUpdate.appUsers;
        }
        this.markRefreshed('appUsers');
      }
      
      // LOW PRIORITY: Patients (5min interval) - rarely change during operations
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
      
      // VERY LOW PRIORITY: Stores (10min interval) - almost never change
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