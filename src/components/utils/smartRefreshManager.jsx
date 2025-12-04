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
    this.minRefreshInterval = 14900; // ~15 seconds minimum between full refreshes
    this.lastFullRefreshTime = 0; // Track full refresh separately
    
    // Real-time refresh intervals (milliseconds) - OPTIMIZED for rate limits
    // PRIORITY: Today's data is critical, historical/future data is background
    this.intervals = {
      driverLocation: 30000,     // 30s - driver GPS locations (HIGH PRIORITY)
      activeDeliveries: 30000,   // 30s - today's active delivery statuses (HIGH PRIORITY)
      todayDeliveries: 45000,    // 45s - today's delivery changes only (HIGH PRIORITY)
      appUsers: 60000,           // 60s - driver status, assignments (HIGH PRIORITY)
      todayPatients: 120000,     // 2min - patients on today's routes only (MEDIUM)
      patients: 900000,          // 15min - all other patients (LOW PRIORITY - background)
      stores: 1800000            // 30min - store data almost never changes (VERY LOW)
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
    
    // Rate limit protection - INCREASED significantly to prevent 429 errors
    this.lastApiCallTime = 0;
    this.minTimeBetweenCalls = 5000; // 5 seconds minimum between any API call (increased from 3s)
    
    // Rate limit error callback
    this.rateLimitCallback = null;
    
    // CRITICAL: Track deliveries that have pending local updates
    // This prevents smart refresh from overwriting them with stale DB data
    this.pendingLocalUpdates = new Map(); // deliveryId -> { expiresAt, driverId, deliveryDate }
  }
  
  /**
   * Register a pending local update for a delivery
   * This prevents smart refresh from overwriting it for 15 seconds (extended from 5s)
   * The longer window accounts for backend optimizer latency
   */
  registerPendingUpdate(deliveryId, driverId = null, deliveryDate = null) {
    const expiresAt = Date.now() + 15000; // 15 second protection window
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
    console.log(`⚙️ [SmartRefresh] Setting enabled = ${value} (initialized: ${this._initialized})`);
    this._enabled = value;
  }
  
  /**
   * Initialize enabled state from AppSettings
   * Called once during app startup - MUST be called before any refresh operations
   */
  async initializeFromSettings() {
    try {
      console.log('⚙️ [SmartRefresh] Loading settings from AppSettings...');
      const settings = await base44.entities.AppSettings.filter({ setting_key: 'refresh_intervals' });
      
      if (settings && settings.length > 0 && settings[0].setting_value) {
        // CRITICAL: Check for explicit false, undefined means enabled
        const savedEnabled = settings[0].setting_value.smartRefreshEnabled;
        const enabled = savedEnabled !== false;
        
        console.log(`⚙️ [SmartRefresh] Found setting: smartRefreshEnabled = ${savedEnabled} (interpreted as ${enabled})`);
        
        this._enabled = enabled;
        this._initialized = true;
        
        console.log(`✅ [SmartRefresh] Initialized from settings: ${enabled ? 'ENABLED' : 'DISABLED'}`);
        return enabled;
      }
      
      // Default to enabled if no setting exists
      console.log('⚙️ [SmartRefresh] No settings found, defaulting to ENABLED');
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
      
      // Only preserve deliveries with pending local updates - let backend be source of truth for isNextDelivery
      const finalMergedDeliveries = mergedDateDeliveries.map(d => {
        // If delivery has pending update, keep local version entirely
        if (this.hasPendingUpdate(d.id)) {
          const currentVersion = currentDateDeliveries.find(cd => cd.id === d.id);
          if (currentVersion) {
            console.log(`   🔒 Preserving local update for: ${d.patient_name || 'Pickup'}`);
            return currentVersion;
          }
        }
        
        // Backend is source of truth for isNextDelivery - don't override
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
      
      // Only preserve deliveries with pending local updates - let backend be source of truth for isNextDelivery
      const finalMergedRelevant = mergedRelevantDeliveries.map(d => {
        // If delivery has pending update, keep local version entirely
        if (this.hasPendingUpdate(d.id)) {
          const currentVersion = relevantCurrentDeliveries.find(cd => cd.id === d.id);
          if (currentVersion) {
            console.log(`   🔒 Preserving local update for: ${d.patient_name || 'Pickup'}`);
            return currentVersion;
          }
        }
        
        // Backend is source of truth for isNextDelivery - don't override
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
      // Check if disabled - silently skip automatic polling
      if (!this._enabled) {
        return null;
      }
      
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
      
      console.log(`📋 [SmartRefresh] ${updatedPatients.length} today's patients updated`);
      
      // Merge updates into full patient list
      const mergedPatients = currentPatients.map(p => {
        const updated = updatedPatients.find(u => u.id === p.id);
        return updated || p;
      });
      
      // Add any new patients
      updatedPatients.forEach(up => {
        if (!mergedPatients.find(p => p.id === up.id)) {
          mergedPatients.push(up);
        }
      });
      
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
        console.log('⏭️ [SmartRefresh] Skipping patient refresh - no existing data (wait for initial load)');
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
      
      console.log(`📋 [SmartRefresh] ${updatedPatients.length} patients updated since last check (background)`);
      
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
      
      // CRITICAL: Fetch ALL deliveries for the date, not just active ones
      // This ensures we catch status changes (e.g., pending -> in_transit, in_transit -> completed)
      const activeFilter = {
        delivery_date: dateStr
      };
      
      const fetchedDeliveries = await base44.entities.Delivery.filter(activeFilter);
      
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
          // Check for ANY changes, not just status
          if (d.status !== fetchedVersion.status ||
              d.delivery_time_eta !== fetchedVersion.delivery_time_eta ||
              d.isNextDelivery !== fetchedVersion.isNextDelivery ||
              d.stop_order !== fetchedVersion.stop_order ||
              d.driver_id !== fetchedVersion.driver_id ||
              d.driver_name !== fetchedVersion.driver_name ||
              d.delivery_notes !== fetchedVersion.delivery_notes ||
              d.actual_delivery_time !== fetchedVersion.actual_delivery_time) {
            hasChanges = true;
            changedDeliveries.push({
              name: fetchedVersion.patient_name || 'Pickup',
              oldStatus: d.status,
              newStatus: fetchedVersion.status,
              oldDriver: d.driver_name,
              newDriver: fetchedVersion.driver_name
            });
            
            // Backend is source of truth for isNextDelivery - use fetched version directly
            return fetchedVersion;
          }
        }
        return d;
      });
      
      // Add any new deliveries that weren't in current list
      fetchedDeliveries.forEach(fd => {
        if (!updatedCurrentDateDeliveries.find(d => d?.id === fd.id) && !this.hasPendingUpdate(fd.id)) {
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
      
      console.log(`📦 [SmartRefresh] Delivery changes detected (${changedDeliveries.length} changes):`);
      changedDeliveries.slice(0, 5).forEach(c => {
        if (c.type === 'NEW') {
          console.log(`   + NEW: ${c.name} (${c.status})`);
        } else if (c.oldStatus !== c.newStatus) {
          console.log(`   • ${c.name}: ${c.oldStatus} → ${c.newStatus}`);
        } else if (c.oldDriver !== c.newDriver) {
          console.log(`   • ${c.name}: driver ${c.oldDriver} → ${c.newDriver}`);
        } else {
          console.log(`   • ${c.name}: updated`);
        }
      });
      if (changedDeliveries.length > 5) {
        console.log(`   ... and ${changedDeliveries.length - 5} more`);
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
    // CRITICAL: When disabled, skip background polling but still allow manual refreshes
    // The toggle only affects automatic background data fetching
    if (!this._enabled) {
      // Silently skip automatic background polling
      return null;
    }
    
    if (isEntityUpdating) {
      console.log('🔄 [Smart Refresh] ⏸️ PAUSED - Entity update in progress');
      return null;
    }
    
    if (this.isRefreshing) {
      return null;
    }
    
    // CRITICAL: Touch user cache on every refresh cycle to prevent session timeout
    // This extends the auth cache TTL while the app is actively being used
    try {
      touchUserCache();
    } catch (e) {
      // Ignore errors from touchUserCache
    }
    
    this.isRefreshing = true;
    const updates = {};
    
    try {
      // HIGH PRIORITY: Today's deliveries ONLY (not future dates)
      if (currentData.deliveries && filters.selectedDate && this.shouldRefresh('todayDeliveries')) {
        // Only refresh today's date, not the full range
        const today = new Date();
        const todayStr = format(today, 'yyyy-MM-dd');
        
        const deliveryUpdate = await this.refreshCurrentDayDeliveries(
          currentData.deliveries,
          today, // Always refresh TODAY, not selectedDate
          filters.deliveryFilter
        );
        
        if (deliveryUpdate?.hasChanges) {
          updates.deliveries = deliveryUpdate.deliveries;
        }
        this.markRefreshed('todayDeliveries');
      }
      
      // HIGH PRIORITY: AppUsers (driver locations and status)
      if (currentData.appUsers && this.shouldRefresh('appUsers')) {
        const appUserUpdate = await this.refreshAppUsers(currentData.appUsers);
        
        if (appUserUpdate?.hasChanges) {
          updates.appUsers = appUserUpdate.appUsers;
        }
        this.markRefreshed('appUsers');
      }
      
      // MEDIUM PRIORITY: Today's route patients only
      if (currentData.patients && currentData.patients.length > 0 && 
          currentData.deliveries && this.shouldRefresh('todayPatients')) {
        
        const today = new Date();
        const todayStr = format(today, 'yyyy-MM-dd');
        const todayDeliveries = currentData.deliveries.filter(d => 
          d && d.delivery_date === todayStr
        );
        
        const patientUpdate = await this.refreshTodayPatients(
          currentData.patients,
          todayDeliveries
        );
        
        if (patientUpdate?.hasChanges) {
          updates.patients = patientUpdate.patients;
        }
        this.markRefreshed('todayPatients');
      }
      
      // LOW PRIORITY: All other patients (background - 15 min interval)
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
      
      // VERY LOW PRIORITY: Stores (30 min interval)
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
      // CRITICAL: Handle auth errors gracefully - don't crash the app
      if (error.response?.status === 401 || error.response?.status === 403) {
        console.warn('🔐 [SmartRefresh] Auth error during refresh - session may have expired');
        // Don't throw - let the app continue and handle auth at the next user action
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