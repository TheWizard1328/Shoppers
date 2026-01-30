// smartRefreshManager.js - Manages intelligent, differential data refreshes

import { base44 } from "@/api/base44Client";
import { diffEntityArrays, mergeEntityChanges, getLatestUpdateTimestamp, mergeDriverLocations, logDiffStats } from "./dataDiffer";
import { format } from "date-fns";
import { invalidate } from "./dataManager";
import { touchUserCache } from "./auth";
import { queueEntityRequest } from "./requestQueue";

// Module-level cache for isOfflineDBLoadComplete (imported dynamically)
let _isOfflineDBLoadComplete = null;

// Initialize offline DB check function asynchronously
(async () => {
  try {
    const mod = await import('./dataManager');
    _isOfflineDBLoadComplete = mod.isOfflineDBLoadComplete;
  } catch (e) {
    console.warn('⚠️ [SmartRefresh] Failed to import dataManager - offline DB checks disabled');
    _isOfflineDBLoadComplete = () => true; // Fallback - assume DB is loaded
  }
})();

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
    // OPTIMIZED: Batch entire entity syncs to reduce API calls
    this.intervals = {
      activeRoute: 15000,            // 15s - TODAY's deliveries + driver locations (priority)
      appUsers: 15000,               // 15s - ENTIRE AppUser dataset in one hit (all drivers)
      cities: 300000,                // 5min - ENTIRE Cities dataset in one hit
      stores: 300000,                // 5min - ENTIRE Stores dataset in one hit
      patients: 86400000,            // Once a day - ENTIRE Patient dataset + last 90 days deliveries
      deliveries: 86400000,          // Once a day - Last 90 days of deliveries
      squareTransactions: 600000,    // 10min - Square transaction updates
      payroll: 300000                // 5min - payroll records
    };
    
    // Track historical date refresh queue
    this.historicalDatesQueue = [];
    this.currentHistoricalIndex = 0;
    this.lastHistoricalCheck = 0;
    
    // Adaptive driver location refresh
    this._lastUserInteraction = Date.now();
    this._minDriverLocationInterval = 120000;  // 2min when active (rely on offline DB)
    this._maxDriverLocationInterval = 600000;  // 10min when inactive (rely on offline DB)
    this._adaptiveCoefficient = 1.0;          // Multiplier for current interval
    
    // Track last refresh time for each entity type
    // Initialize to 0 so the first refresh happens immediately
    this.lastRefreshTimes = {
      activeRoute: 0,            // Combined: today's deliveries + driver locations
      historicalDate: 0,         // Opportunistic historical sync
      appUsers: 0,
      squareTransactions: 0,
      todayPatients: 0,
      patients: 0,
      stores: 0,
      payroll: 0
    };
    
    // Rate limit protection - OPTIMIZED for batch syncs
    this.lastApiCallTime = 0;
    this.minTimeBetweenCalls = 5000;  // 5s minimum between API calls (batch syncs are less frequent)
    this.consecutiveErrors = 0;
    this.maxConsecutiveErrors = 2;    // Enter cooldown after 2 errors (more tolerant)
    this.errorCooldownUntil = 0;
    
    // Rate limit error callback
    this.rateLimitCallback = null;
    
    // AUTO-RECOVERY: Track connection/error state for automatic retry
    this._connectionErrorCount = 0;
    this._lastSuccessfulRefresh = Date.now();
    this._autoRecoveryTimer = null;
    this._isInRecoveryMode = false;
    this._recoveryAttempts = 0;
    this._maxRecoveryAttempts = 3; // Reduced from 5
    this._recoveryBackoffMs = 30000; // Start with 30 seconds (was 10s)
    
    // CRITICAL: Track deliveries that have pending local updates
    // This prevents smart refresh from overwriting them with stale DB data
    this.pendingLocalUpdates = new Map(); // deliveryId -> { expiresAt, driverId, deliveryDate }

    // CRITICAL: Track patients that have pending local updates
    this.pendingPatientUpdates = new Map(); // patientId -> { expiresAt }

    // Setup user interaction tracking for adaptive refresh
    this._setupInteractionTracking();
    
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
   * @param {string} specificEntityType - If provided, only restart this entity's refresh timer
   */
  restart(specificEntityType = null) {
    if (specificEntityType) {
      console.log(`🔄 [SmartRefresh] Restarting ${specificEntityType} refresh timer only`);
      this.lastRefreshTimes[specificEntityType] = 0;
    } else {
      console.log('🔄 [SmartRefresh] Restarting - resetting all refresh timers');
      this._paused = false;
      this.lastRefreshTimes = {
        activeRoute: 0,
        historicalDate: 0,
        appUsers: 0,
        squareTransactions: 0,
        todayPatients: 0,
        patients: 0,
        stores: 0,
        payroll: 0
      };
      
      // CRITICAL: Clear the API fetch flag to reset fetch behavior
      if (this._pendingApiFetch) {
        this._pendingApiFetch.clear();
      }
      
      // CRITICAL: Dispatch event to trigger UI updates (e.g., FAB reactivation)
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('smartRefreshRestarted'));
      }
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
      // Trigger 60 second cooldown on rate limit errors (increased from 30s)
      this.errorCooldownUntil = Date.now() + 60000;
      console.warn(`🛑 [SmartRefresh] ${this.consecutiveErrors} consecutive errors - entering 60s cooldown`);
      this.consecutiveErrors = 0;
      this.notifyRateLimit(true);
    }
  }
  
  /**
   * Record a successful API call - resets error counter and recovery state
   */
  recordSuccess() {
    if (this.consecutiveErrors > 0) {
      console.log(`✅ [SmartRefresh] Successful call - resetting error counter (was ${this.consecutiveErrors})`);
      this.consecutiveErrors = 0;
    }
    
    // AUTO-RECOVERY: Reset connection error tracking on success
    this._connectionErrorCount = 0;
    this._lastSuccessfulRefresh = Date.now();
    this._recoveryAttempts = 0;
    this._recoveryBackoffMs = 30000;
    
    // Clear recovery mode if we were in it
    if (this._isInRecoveryMode) {
      console.log('🎉 [SmartRefresh] Connection restored - exiting recovery mode');
      this._isInRecoveryMode = false;
      this.notifyRateLimit(false);
      
      // Dispatch event so UI can show connection restored
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('connectionRestored'));
      }
    }
  }
  
  /**
   * Record a connection error and trigger auto-recovery if needed
   */
  recordConnectionError(error) {
    this._connectionErrorCount++;
    
    const isRateLimit = error?.response?.status === 429 || error?.message?.includes('429');
    const isConnectionError = error?.message?.includes('WebSocket') || 
                               error?.message?.includes('network') ||
                               error?.message?.includes('fetch') ||
                               error?.message?.includes('Failed to fetch') ||
                               error?.code === 'ECONNREFUSED';
    
    console.warn(`⚠️ [SmartRefresh] Connection error #${this._connectionErrorCount}:`, error?.message || error);
    
    // Enter recovery mode after 2 consecutive errors (was 3)
    if (this._connectionErrorCount >= 2 && !this._isInRecoveryMode) {
      console.log('🔄 [SmartRefresh] Entering auto-recovery mode');
      this._isInRecoveryMode = true;
      
      // Notify UI about connection issues
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('connectionError', {
          detail: { 
            errorCount: this._connectionErrorCount,
            isRateLimit,
            willRetryIn: this._recoveryBackoffMs 
          }
        }));
      }
      
      this.scheduleAutoRecovery();
    }
  }
  
  /**
   * Schedule an automatic recovery attempt with exponential backoff
   */
  scheduleAutoRecovery() {
    // Clear any existing timer
    if (this._autoRecoveryTimer) {
      clearTimeout(this._autoRecoveryTimer);
    }
    
    if (this._recoveryAttempts >= this._maxRecoveryAttempts) {
      console.log('⏹️ [SmartRefresh] Max recovery attempts reached - waiting for manual trigger');
      return;
    }
    
    console.log(`⏰ [SmartRefresh] Scheduling recovery attempt ${this._recoveryAttempts + 1}/${this._maxRecoveryAttempts} in ${this._recoveryBackoffMs / 1000}s`);
    
    this._autoRecoveryTimer = setTimeout(async () => {
      await this.attemptRecovery();
    }, this._recoveryBackoffMs);
    
    // Exponential backoff: 30s -> 60s -> 120s (capped at 2min)
    this._recoveryBackoffMs = Math.min(this._recoveryBackoffMs * 2, 120000);
  }
  
  /**
   * Attempt to recover connection by testing a simple API call
   */
  async attemptRecovery() {
    this._recoveryAttempts++;
    console.log(`🔄 [SmartRefresh] Recovery attempt ${this._recoveryAttempts}/${this._maxRecoveryAttempts}...`);
    
    // Notify UI that we're attempting recovery
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('recoveryAttempt', {
        detail: { attempt: this._recoveryAttempts, maxAttempts: this._maxRecoveryAttempts }
      }));
    }
    
    try {
      // Simple test: fetch AppUser count (lightweight)
      const testResult = await base44.entities.AppUser.filter({}, '-updated_date', 1);
      
      if (testResult) {
        // Success! Reset all error states
        console.log('✅ [SmartRefresh] Recovery successful - connection restored');
        this.recordSuccess();
        
        // DON'T force full refresh - let normal refresh cycles handle it
        console.log('📌 [SmartRefresh] Connection restored - resuming normal refresh cycles');
        
        return true;
      }
    } catch (error) {
      console.warn(`⚠️ [SmartRefresh] Recovery attempt ${this._recoveryAttempts} failed:`, error.message);
      
      // Schedule next attempt
      this.scheduleAutoRecovery();
      
      return false;
    }
    
    return false;
  }
  
  /**
   * Force a full refresh of all data - called after recovery
   * CRITICAL: REMOVED - this was causing the data wipe issue
   */
  forceFullRefresh() {
    console.log('📌 [SmartRefresh] Refresh timers reset - normal cycles will resume');
    
    // ONLY reset timers - DON'T dispatch forceDataRefresh event
    // This prevents the massive data wipe and reload
    this.lastRefreshTimes = {
      driverLocation: 0,
      activeDeliveries: 0,
      todayDeliveries: 0,
      appUsers: 0,
      squareTransactions: 0,
      todayPatients: 0,
      patients: 0,
      stores: 0,
      payroll: 0
    };
    
    // Clear error cooldown
    this.errorCooldownUntil = 0;
    this.consecutiveErrors = 0;
    
    // DON'T dispatch forceDataRefresh - it causes everything to reload
  }
  
  /**
   * Manual recovery trigger - can be called from UI
   */
  triggerManualRecovery() {
    console.log('👆 [SmartRefresh] Manual recovery triggered');
    this._recoveryAttempts = 0;
    this._recoveryBackoffMs = 10000; // Shorter wait for manual trigger
    this._connectionErrorCount = 0;
    this.scheduleAutoRecovery();
  }
  
  /**
   * Setup global interaction tracking (click, input, scroll, touch)
   */
  _setupInteractionTracking() {
    if (typeof window === 'undefined') return;
    
    const updateActivity = () => {
      this.recordUserInteraction();
    };
    
    // Track various user interactions
    ['click', 'keydown', 'scroll', 'touchstart', 'mousemove'].forEach(event => {
      window.addEventListener(event, updateActivity, { passive: true, once: false });
    });
  }

  /**
   * Track user activity for adaptive refresh rates
   */
  recordUserInteraction() {
    this._lastUserInteraction = Date.now();
    this._adaptiveCoefficient = 1.0; // Reset to fast refresh on activity
  }

  /**
   * Get adaptive driver location refresh interval based on user activity
   */
  getAdaptiveDriverLocationInterval() {
    const timeSinceActivity = Date.now() - this._lastUserInteraction;
    const inactiveThreshold = 120000; // 2 minutes of inactivity
    
    // After 2 minutes of no activity, progressively increase interval
    if (timeSinceActivity > inactiveThreshold) {
      this._adaptiveCoefficient = Math.min(
        4.0, // Max 4x multiplier (30s * 4 = 2min)
        1.0 + (timeSinceActivity - inactiveThreshold) / 120000
      );
    } else {
      this._adaptiveCoefficient = 1.0;
    }
    
    return Math.floor(this._minDriverLocationInterval * this._adaptiveCoefficient);
  }

  /**
   * Check if enough time has passed for a specific refresh type
   * CRITICAL: Block refresh until offline DB is loaded
   */
  shouldRefresh(type) {
     // CRITICAL: Don't start smart refresh until offline DB has loaded
     if (_isOfflineDBLoadComplete && !_isOfflineDBLoadComplete()) {
       return false;
     }

     const now = Date.now();
     const lastRefresh = this.lastRefreshTimes[type] || 0;
     
     // Use adaptive interval for driver locations
     let interval = this.intervals[type] || 30000;
     if (type === 'driverLocation') {
       interval = this.getAdaptiveDriverLocationInterval();
     }
     
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
   * CRITICAL: For dispatchers, auto-center to next delivery card and reactivate FAB
   */
  notifySubscribers(updates) {
    this.refreshCallbacks.forEach(callback => callback(updates));

    // CRITICAL: Notify dispatchers with UI updates
    if (typeof window !== 'undefined' && updates) {
      window.dispatchEvent(new CustomEvent('smartRefreshComplete', {
        detail: { updates }
      }));

      // Flash map FAB on phase 1 when new data updates
      if (window.__fabFlashUpdate) {
        window.__fabFlashUpdate();
      }
    }
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

          // PURGE AND RESYNC: Fetch ALL deliveries for this date from API
          const dateFilter = { ...filters, delivery_date: dateStr };

          await this.waitForRateLimit();
          const fetchedDeliveries = await queueEntityRequest(
            () => base44.entities.Delivery.filter(dateFilter),
            `Delivery filter [${dateStr}]`
          );

          if (!fetchedDeliveries || fetchedDeliveries.length === 0) {
              this.notifyRateLimit(false);
              return null;
          }

          // Filter out deliveries with pending local updates
          const protectedDeliveryIds = [];
          const filteredDeliveries = fetchedDeliveries.filter(d => {
            if (this.hasPendingUpdate(d.id)) {
              protectedDeliveryIds.push(d.id);
              return false;
            }
            return true;
          });

          // PURGE: Delete all offline deliveries for this date
          try {
            const { offlineDB } = await import('./offlineDatabase');
            await offlineDB.deleteDeliveriesByDate(dateStr);
            console.log(`🗑️ [SmartRefresh] Purged offline deliveries for ${dateStr}`);

            // RESYNC: Save fresh deliveries from API
            await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, filteredDeliveries);
            console.log(`✅ [SmartRefresh] Resynced ${filteredDeliveries.length} deliveries for ${dateStr}`);
          } catch (offlineError) {
            console.warn('⚠️ [SmartRefresh] Failed to purge/resync deliveries to offline DB:', offlineError);
          }

          // Merge with other dates and protected deliveries
          const otherDateDeliveries = currentDeliveries.filter(d => d && d.delivery_date !== dateStr);
          const protectedDeliveries = currentDateDeliveries.filter(d => this.hasPendingUpdate(d.id));
          const finalDeliveries = [...otherDateDeliveries, ...filteredDeliveries, ...protectedDeliveries];

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
   * CRITICAL: Loads from offline DB first to prevent rate limiting
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

      // CRITICAL: Try offline DB first for 7-day range
      try {
        const { offlineDB } = await import('./offlineDatabase');
        const offlineDeliveries = await offlineDB.getAll(offlineDB.STORES.DELIVERIES);

        if (offlineDeliveries && offlineDeliveries.length > 0) {
          // Filter to 7-day window
          const relevantOfflineDeliveries = offlineDeliveries.filter(d => 
            d && d.delivery_date && d.delivery_date >= todayStr && d.delivery_date <= futureDateStr
          );

          console.log(`💾 [SmartRefresh] Loaded ${relevantOfflineDeliveries.length} relevant deliveries from offline DB`);

          const diff = diffEntityArrays(relevantCurrentDeliveries, relevantOfflineDeliveries);

          if (diff.toUpdate.length === 0 && diff.toAdd.length === 0 && diff.toRemove.length === 0) {
            return null;
          }

          const mergedRelevantDeliveries = mergeEntityChanges(relevantCurrentDeliveries, diff);
          const finalDeliveries = [...pastDeliveries, ...mergedRelevantDeliveries];

          return {
            hasChanges: true,
            deliveries: finalDeliveries
          };
        }
      } catch (offlineError) {
        console.warn('⚠️ [SmartRefresh] Failed to load from offline DB, falling back to API:', offlineError.message);
      }

      // Fallback to API if offline DB unavailable
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
   * CRITICAL: Load from offline DB first, only fetch from API if needed
   * CRITICAL: NEVER wipe AppUsers during refresh - can cause UI to blank out
   */
  async refreshAppUsers(currentAppUsers, forceLocationRefresh = false) {
      try {
          // CRITICAL: Skip if paused (during status changes)
          if (this._paused) {
              console.log('⏸️ [SmartRefresh] AppUser refresh skipped - paused');
              return null;
          }

          // CRITICAL: Try to load from offline DB first
          try {
            const { offlineDB } = await import('./offlineDatabase');
            const offlineAppUsers = await offlineDB.getAll(offlineDB.STORES.APP_USERS);

            if (offlineAppUsers && offlineAppUsers.length > 0) {
              console.log(`💾 [SmartRefresh] Loaded ${offlineAppUsers.length} AppUsers from offline DB`);

              // CRITICAL: If offline DB has less than current (possible sync issue), don't use it
              if (offlineAppUsers.length < currentAppUsers.length * 0.5) {
                console.warn(`⚠️ [SmartRefresh] Offline AppUsers (${offlineAppUsers.length}) < current (${currentAppUsers.length}) - falling back to API`);
              } else {
                // Offline DB looks good - check for changes
                const diff = diffEntityArrays(currentAppUsers, offlineAppUsers);

                if (diff.toUpdate.length > 0 || diff.toAdd.length > 0) {
                  const mergedAppUsers = mergeEntityChanges(currentAppUsers, diff);
                  console.log(`   ✏️ [SmartRefresh] AppUser changes: +${diff.toAdd.length} -${diff.toRemove.length} ~${diff.toUpdate.length}`);
                  return {
                    hasChanges: true,
                    appUsers: mergedAppUsers
                  };
                }
                // Offline data matches current - no changes needed
                console.log(`   ✅ [SmartRefresh] AppUsers unchanged from offline DB`);
                return null;
              }
            }
          } catch (offlineError) {
            console.warn('⚠️ [SmartRefresh] Failed to load AppUsers from offline DB:', offlineError.message);
            // Fall through to API fetch
          }

          // Fallback to API if offline DB unavailable or empty
          const lastTimestamp = getLatestUpdateTimestamp(currentAppUsers);
          let queryFilter = {};

          if (lastTimestamp) {
              queryFilter.updated_date = {
                  $gte: lastTimestamp.toISOString()
              };
          }

          await this.waitForRateLimit();
          const updatedAppUsers = await queueEntityRequest(
            () => base44.entities.AppUser.filter(queryFilter),
            'AppUser filter'
          );

          if (!updatedAppUsers || updatedAppUsers.length === 0) {
              return null;
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

          const mergedAppUsers = mergeEntityChanges(currentAppUsers, diff);

          // CRITICAL: Sync to offline database after changes
          try {
            const { offlineDB } = await import('./offlineDatabase');
            await offlineDB.bulkSave(offlineDB.STORES.APP_USERS, mergedAppUsers);
            console.log(`✅ [SmartRefresh] Synced ${mergedAppUsers.length} AppUsers to offline DB`);
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
   * Fast driver location refresh with adaptive intervals
   * OFFLINE-FIRST: Loads from offline DB, only fetches API when stale or missing
   * @param currentAppUsers - Current AppUser data
   * @param forceRefresh - If true, bypasses offline DB and forces API fetch
   * CRITICAL: Never throws - always returns null on error to prevent stuck refresh
   */
  async refreshDriverLocations(currentAppUsers, forceRefresh = false) {
    try {
      // Check if disabled or paused - silently skip automatic polling (unless forced)
      if ((!this._enabled || this._paused) && !forceRefresh) {
        return null;
      }
      
      // CRITICAL: Use adaptive interval based on user activity
      const adaptiveInterval = this.getAdaptiveDriverLocationInterval();
      const now = Date.now();
      const timeSinceLastRefresh = now - (this.lastRefreshTimes.driverLocation || 0);
      
      if (!forceRefresh && timeSinceLastRefresh < adaptiveInterval) {
        return null;
      }
      
      this.lastRefreshTimes.driverLocation = now;
      
      // OFFLINE-FIRST: Load from offline DB first unless forceRefresh
      if (!forceRefresh) {
        try {
          const { offlineDB } = await import('./offlineDatabase');
          const offlineAppUsers = await offlineDB.getAll(offlineDB.STORES.APP_USERS);
          
          if (offlineAppUsers && offlineAppUsers.length > 0) {
            console.log(`💾 [SmartRefresh] Loaded ${offlineAppUsers.length} AppUsers from offline DB for driver locations`);
            
            // Check if offline data is fresh enough (< 15 seconds for real-time tracking)
            const syncStatus = await offlineDB.getSyncStatus('AppUser');
            const isFresh = syncStatus?.lastSync && 
              (Date.now() - new Date(syncStatus.lastSync).getTime() < 15000);
            
            if (isFresh) {
              // Offline data is fresh - use it directly
              const diff = diffEntityArrays(currentAppUsers, offlineAppUsers);
              
              if (diff.toUpdate.length > 0 || diff.toAdd.length > 0) {
                const mergedAppUsers = mergeEntityChanges(currentAppUsers, diff);
                
                // Dispatch location update event
                if (typeof window !== 'undefined') {
                  window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
                    detail: { appUsers: mergedAppUsers }
                  }));
                }
                
                return {
                  hasChanges: true,
                  appUsers: mergedAppUsers
                };
              }
              
              // No changes - return null
              return null;
            }
            
            // Offline data is stale - fetch from API in background and return offline immediately
            console.log(`⏰ [SmartRefresh] Offline AppUser data is stale - refreshing from API`);
          }
        } catch (offlineError) {
          console.warn('⚠️ [SmartRefresh] Failed to load AppUsers from offline DB:', offlineError.message);
        }
      }
      
      // Fetch from API (either forceRefresh or offline data is stale/missing)
      await this.waitForRateLimit();
      const allAppUsers = await queueEntityRequest(
        () => base44.entities.AppUser.filter({
          app_roles: { $in: ['driver'] }
        }),
        'AppUser list [drivers]'
      );
      
      this.recordSuccess();
      
      if (!allAppUsers || allAppUsers.length === 0) {
        return null;
      }
      
      // Merge server data with current state
      const updatedAppUsers = currentAppUsers.map(au => {
        const serverVersion = allAppUsers.find(ad => ad.user_id === au.user_id);
        if (serverVersion) {
          const localTime = new Date(au.updated_date || 0).getTime();
          const serverTime = new Date(serverVersion.updated_date || 0).getTime();
          
          // CRITICAL: ALWAYS take server's location data to prevent marker disappearing
          const merged = {
            ...au,
            current_latitude: serverVersion.current_latitude,
            current_longitude: serverVersion.current_longitude,
            location_updated_at: serverVersion.location_updated_at,
            driver_status: serverVersion.driver_status,
            location_tracking_enabled: serverVersion.location_tracking_enabled
          };
          
          // For other fields, prefer server if newer
          if (serverTime > localTime) {
            return { ...merged, ...serverVersion };
          }
          
          return merged;
        }
        return au;
      });
      
      // Add any new AppUsers from server
      allAppUsers.forEach(serverAu => {
        if (!updatedAppUsers.find(au => au.user_id === serverAu.user_id)) {
          updatedAppUsers.push(serverAu);
        }
      });
      
      // CRITICAL: Sync to offline DB and update sync status
      try {
        const { offlineDB } = await import('./offlineDatabase');
        await offlineDB.bulkSave(offlineDB.STORES.APP_USERS, updatedAppUsers);

        // CRITICAL: Deduplicate after saving to ensure uniqueness
        await offlineDB.deduplicateAppUsers();

        await offlineDB.updateSyncStatus('AppUser', {
          recordCount: updatedAppUsers.length,
          status: 'synced',
          lastSync: new Date().toISOString()
        });
        console.log(`✅ [SmartRefresh] Synced ${updatedAppUsers.length} AppUsers to offline DB`);
      } catch (offlineError) {
        console.warn('⚠️ [SmartRefresh] Failed to sync driver locations to offline DB:', offlineError);
      }
      
      // Dispatch location update event
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
          detail: { appUsers: updatedAppUsers }
        }));
        
        // CRITICAL: Trigger polyline refresh for drivers with updated locations
        window.dispatchEvent(new CustomEvent('driverLocationChanged', {
          detail: { appUsers: updatedAppUsers }
        }));
      }
      
      return {
        hasChanges: true,
        appUsers: updatedAppUsers
      };
      
    } catch (error) {
      this.recordError();
      this.recordConnectionError(error);
      
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
   * Smart refresh for ALL active patients (ensuring complete patient data sync)
   * CRITICAL: Syncs ALL active patients to offline DB, not just those with deliveries
   * CRITICAL: Always checks if deliveries reference patients not in offline DB
   */
  async refreshTodayPatients(currentPatients, todayDeliveries) {
    try {
      const { offlineDB } = await import('./offlineDatabase');
      const offlinePatients = await offlineDB.getAll(offlineDB.STORES.PATIENTS);
      
      // CRITICAL: Get ALL patient IDs referenced by today's deliveries
      const todayPatientIds = todayDeliveries && todayDeliveries.length > 0 ? 
        [...new Set(
          todayDeliveries
            .filter(d => d && d.patient_id)
            .map(d => d.patient_id)
        )] : [];
      
      // CRITICAL: Check if any delivery references a patient NOT in offline DB
      // This detects when new patients were imported on another device
      const offlinePatientIds = new Set((offlinePatients || []).map(p => p?.id).filter(Boolean));
      const missingPatientIds = todayPatientIds.filter(id => id && !offlinePatientIds.has(id));
      
      if (missingPatientIds.length > 0) {
        console.log(`⚠️ [SmartRefresh] ${missingPatientIds.length} patients missing from offline DB - fetching from API`);
        
        // CRITICAL: Fetch ALL patients from API to ensure complete sync
        await this.waitForRateLimit();
        const allPatients = await queueEntityRequest(
          () => base44.entities.Patient.filter({ status: 'active' }, '-created_date', 5000),
          'Patient list [all active]'
        );
        
        if (allPatients && allPatients.length > 0) {
          // Save ALL patients to offline DB
          const cleanPatients = allPatients.filter(p => p && p.id && !p.id.startsWith('temp_'));
          await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, cleanPatients);
          console.log(`✅ [SmartRefresh] Synced ${cleanPatients.length} patients to offline DB`);
          
          // Update sync status
          await offlineDB.updateSyncStatus('Patient', {
            recordCount: cleanPatients.length,
            status: 'synced',
            lastSync: new Date().toISOString(),
            lastFullSync: new Date().toISOString()
          });
          
          // Merge with current patients
          const diff = diffEntityArrays(currentPatients, cleanPatients);
          if (diff.toUpdate.length > 0 || diff.toAdd.length > 0 || diff.toRemove.length > 0) {
            const mergedPatients = mergeEntityChanges(currentPatients, diff);
            return {
              hasChanges: true,
              patients: mergedPatients
            };
          }
        }
        return null;
      }

      // If we have offline patient data and no missing patients, use it
      if (offlinePatients && offlinePatients.length > 0) {
        const diff = diffEntityArrays(currentPatients, offlinePatients);

        if (diff.toUpdate.length > 0 || diff.toAdd.length > 0 || diff.toRemove.length > 0) {
          const mergedPatients = mergeEntityChanges(currentPatients, diff);

          return {
            hasChanges: true,
            patients: mergedPatients
          };
        }
        return null;
      }

      // No offline data - fetch ALL patients from API
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
      
      // CRITICAL: Fetch ALL active patients to ensure complete data sync across devices
      const queryFilter = {};

      // Only add timestamp filter if we're not responding to a broadcast AND have current data
      if (lastTimestamp && !needsApiFetch && currentPatients.length > 0) {
        queryFilter.updated_date = { $gte: lastTimestamp.toISOString() };
      }

      await this.waitForRateLimit();
      const updatedPatients = await base44.entities.Patient.filter(queryFilter);
      
      if (!updatedPatients || updatedPatients.length === 0) {
        return null;
      }
      

      
      // BIDIRECTIONAL: Merge updates into full patient list (keep local if newer OR protected)
      let mergedPatients = currentPatients.map(p => {
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
        const { offlineDB } = await import('./offlineDatabase');
        await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, mergedPatients);
        console.log(`✅ [SmartRefresh] Synced ${mergedPatients.length} patients to offline DB`);
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
      const updatedPatients = await queueEntityRequest(
        () => base44.entities.Patient.filter(queryFilter),
        'Patient filter'
      );
      
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
      
      const updatedStores = await queueEntityRequest(
        () => base44.entities.Store.filter(queryFilter),
        'Store filter'
      );
      
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
      
      // AUTO-RECOVERY: Track connection errors
      this.recordConnectionError(error);
      
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
      
      const updatedAppUsers = await queueEntityRequest(
        () => base44.entities.AppUser.filter(queryFilter),
        'AppUser filter'
      );
      
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
   * @param {boolean} showAllDrivers - If true, fetch ALL drivers' deliveries regardless of filter
   */
  async refreshActiveDeliveryStatuses(currentDeliveries, selectedDate, filters = {}, showAllDrivers = false) {
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

      // CRITICAL: If showAllDrivers is true, fetch ALL drivers' deliveries, ignore driver_id filter
      if (!showAllDrivers) {
        if (filters.deliveryFilter && filters.deliveryFilter.store_id) {
          cityOnlyFilter.store_id = filters.deliveryFilter.store_id;
        }

        if (filters.deliveryFilter && filters.deliveryFilter.driver_id) {
          cityOnlyFilter.driver_id = filters.deliveryFilter.driver_id;
        }
      } else {
        // Show All mode - only filter by store if specified, fetch all drivers
        if (filters.deliveryFilter && filters.deliveryFilter.store_id) {
          cityOnlyFilter.store_id = filters.deliveryFilter.store_id;
        }
        console.log('📡 [SmartRefresh] Show All Drivers mode - fetching ALL drivers deliveries for', dateStr);
      }
      
      let fetchedDeliveries;
      try {
        fetchedDeliveries = await queueEntityRequest(
          () => base44.entities.Delivery.filter(cityOnlyFilter),
          `Delivery filter [active, ${dateStr}]`
        );
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
      
      // CRITICAL: Build a Set of IDs that exist on the server for this date
      const serverDeliveryIds = new Set(fetchedDeliveries.map(fd => fd.id));
      
      // CRITICAL: Detect deliveries that were DELETED on server (exist locally but not on server)
      const deletedDeliveries = currentDateDeliveries.filter(d => {
        if (!d) return false;
        // Skip if has pending local update (user just created it, might not be synced yet)
        if (this.hasPendingUpdate(d.id)) return false;
        // Skip temp IDs (local-only, not yet synced)
        if (d.id && d.id.startsWith('temp_')) return false;
        // If not on server, it was deleted
        return !serverDeliveryIds.has(d.id);
      });
      
      if (deletedDeliveries.length > 0) {
        console.log(`🗑️ [SmartRefresh] Detected ${deletedDeliveries.length} deliveries deleted on server:`, 
          deletedDeliveries.map(d => d.patient_name || d.id).join(', '));
        hasChanges = true;
      }
      
      // Filter out deleted deliveries from current date deliveries
      const survivingCurrentDateDeliveries = currentDateDeliveries.filter(d => {
        if (!d) return false;
        // Keep if has pending update or is temp ID
        if (this.hasPendingUpdate(d.id)) return true;
        if (d.id && d.id.startsWith('temp_')) return true;
        // Keep only if exists on server
        return serverDeliveryIds.has(d.id);
      });
      
      const updatedCurrentDateDeliveries = survivingCurrentDateDeliveries.map(d => {
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
      
      // CRITICAL: Ensure isNextDelivery stop is first among incomplete deliveries
      // This must happen BEFORE any optimizer runs to prevent it from being reordered
      const incompleteDeliveries = filteredCurrentDateDeliveries.filter(d => 
        d && !['completed', 'failed', 'cancelled', 'returned'].includes(d.status)
      );
      const completedDeliveries = filteredCurrentDateDeliveries.filter(d => 
        d && ['completed', 'failed', 'cancelled', 'returned'].includes(d.status)
      );
      
      // Find the isNextDelivery stop
      const nextDeliveryStop = incompleteDeliveries.find(d => d.isNextDelivery === true);
      
      if (nextDeliveryStop) {
        // Get the first stop_order among incomplete deliveries
        const minIncompleteOrder = Math.min(...incompleteDeliveries.map(d => d.stop_order || Infinity));
        
        // If isNextDelivery stop is not at the first incomplete position, fix it
        if (nextDeliveryStop.stop_order !== minIncompleteOrder) {
          console.log(`🔧 [SmartRefresh] Fixing isNextDelivery stop order: ${nextDeliveryStop.patient_name || 'Pickup'} should be first (order ${minIncompleteOrder})`);
          
          // Update the stop locally to have the first position
          nextDeliveryStop.stop_order = minIncompleteOrder;
          hasChanges = true;
          
          // Also update in the database (async, don't await to keep refresh fast)
          base44.entities.Delivery.update(nextDeliveryStop.id, {
            stop_order: minIncompleteOrder
          }).catch(err => {
            console.warn(`⚠️ [SmartRefresh] Failed to update isNextDelivery stop order in DB:`, err.message);
          });
        }
      }
      
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
      
      // AUTO-RECOVERY: Track connection errors
      this.recordConnectionError(error);
      
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
   * Refresh ACTIVE route data (today's deliveries + driver locations)
   * CRITICAL: 15-second cycle for real-time updates
   * CRITICAL: ALWAYS fetches from API for today for cross-device sync
   * @param {boolean} showAllDrivers - If true, refreshes ALL drivers' data regardless of selected driver
   */
  async refreshActiveRoute(currentData, filters, showAllDrivers = false) {
    const updates = {};
    const todayStr = format(new Date(), 'yyyy-MM-dd');
    
    try {
      // STEP 1: Refresh driver locations (from API for live data)
      await this.waitForRateLimit();
      const locationResult = await this.refreshDriverLocations(currentData.appUsers, true);
      if (locationResult?.hasChanges) {
        updates.appUsers = locationResult.appUsers;
        console.log(`📍 [ActiveRoute] Driver locations refreshed: ${locationResult.appUsers.length} AppUsers`);
      }
      
      // STEP 2: ALWAYS fetch today's deliveries from API (not offline DB)
      await this.waitForRateLimit();
      const cityOnlyFilter = { delivery_date: todayStr };
      
      if (!showAllDrivers && filters.deliveryFilter?.driver_id) {
        cityOnlyFilter.driver_id = filters.deliveryFilter.driver_id;
        console.log(`📦 [ActiveRoute] Fetching driver ${filters.deliveryFilter.driver_id} from API`);
      } else if (showAllDrivers) {
        console.log(`📦 [ActiveRoute] Fetching ALL drivers from API for ${todayStr}`);
      }
      
      if (filters.deliveryFilter?.store_id) {
        cityOnlyFilter.store_id = filters.deliveryFilter.store_id;
      }
      
      const fetchedDeliveries = await queueEntityRequest(
        () => base44.entities.Delivery.filter(cityOnlyFilter),
        `Delivery filter [active, ${todayStr}]`
      );
      
      if (fetchedDeliveries && fetchedDeliveries.length > 0) {
        const { offlineDB } = await import('./offlineDatabase');

        // Sync to offline DB for this device
        await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, fetchedDeliveries);
        console.log(`✅ [ActiveRoute] Synced ${fetchedDeliveries.length} deliveries from API to offline DB`);

        const currentTodayDeliveries = currentData.deliveries.filter(d => d && d.delivery_date === todayStr);
        const otherDeliveries = currentData.deliveries.filter(d => d && d.delivery_date !== todayStr);

        // Merge API data with current state
        const diff = diffEntityArrays(currentTodayDeliveries, fetchedDeliveries);
        if (diff.toUpdate.length > 0 || diff.toAdd.length > 0 || diff.toRemove.length > 0) {
          const mergedToday = mergeEntityChanges(currentTodayDeliveries, diff);
          
          // Preserve items with pending local updates (just created/edited)
          const filteredMerged = mergedToday.map(d => {
            if (this.hasPendingUpdate(d.id)) {
              const localVersion = currentTodayDeliveries.find(cd => cd.id === d.id);
              return localVersion || d;
            }
            return d;
          });
          
          updates.deliveries = [...otherDeliveries, ...filteredMerged];
          console.log(`✨ [ActiveRoute] Delivery updates from API: +${diff.toAdd.length} ~${diff.toUpdate.length} -${diff.toRemove.length}`);
        }
      }
      
      this.recordSuccess();
      return Object.keys(updates).length > 0 ? updates : null;
      
    } catch (error) {
      this.recordError();
      this.recordConnectionError(error);
      console.warn(`⚠️ [ActiveRoute] Error (will retry): ${error.message}`);
      return null;
    }
  }
  
  /**
   * Opportunistically check ONE historical date for updates
   * Only runs when rate limits are low (no recent errors)
   */
  async checkOneHistoricalDate(currentDeliveries, historicalDates) {
    // Skip if we have any recent errors (rate limits)
    if (this.consecutiveErrors > 0 || Date.now() < this.errorCooldownUntil) {
      return null;
    }
    
    // Skip if no historical dates to check
    if (!historicalDates || historicalDates.length === 0) {
      return null;
    }
    
    // Get next date to check (round-robin through the queue)
    const dateToCheck = historicalDates[this.currentHistoricalIndex % historicalDates.length];
    this.currentHistoricalIndex++;
    
    try {
      await this.waitForRateLimit();
      
      const { offlineDB } = await import('./offlineDatabase');
      const offlineDeliveries = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, dateToCheck);
      
      // Check if offline data is stale (> 5 minutes old)
      const syncStatus = await offlineDB.getSyncStatus('Delivery');
      const needsUpdate = !syncStatus || !syncStatus.lastSync || 
        (Date.now() - new Date(syncStatus.lastSync).getTime() > 300000);
      
      if (needsUpdate) {
        const fetchedDeliveries = await queueEntityRequest(
          () => base44.entities.Delivery.filter({ delivery_date: dateToCheck }),
          `Delivery filter [historical, ${dateToCheck}]`
        );
        
        if (fetchedDeliveries && fetchedDeliveries.length > 0) {
          await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, fetchedDeliveries);
          
          const currentDateDeliveries = currentDeliveries.filter(d => d && d.delivery_date === dateToCheck);
          const diff = diffEntityArrays(currentDateDeliveries, fetchedDeliveries);
          
          if (diff.toUpdate.length > 0 || diff.toAdd.length > 0 || diff.toRemove.length > 0) {
            const otherDeliveries = currentDeliveries.filter(d => d && d.delivery_date !== dateToCheck);
            const mergedDate = mergeEntityChanges(currentDateDeliveries, diff);
            
            this.recordSuccess();
            return {
              hasChanges: true,
              deliveries: [...otherDeliveries, ...mergedDate],
              dateChecked: dateToCheck
            };
          }
        }
        
        this.recordSuccess();
      }
      
      return null;
      
    } catch (error) {
      this.recordError();
      console.warn(`⚠️ [SmartRefresh] Historical date ${dateToCheck} check failed:`, error.message);
      return null;
    }
  }
  
  /**
   * NEW: Combined smart refresh - 15s active route, opportunistic historical
   */
  async performSmartRefresh(currentData, filters, isEntityUpdating = false, showAllDrivers = false) {
    // CRITICAL: When disabled, skip background polling
    if (!this._enabled) {
      this.isRefreshing = false;
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
      // PRIORITY 1: Active route data (15-second cycle)
      if (this.shouldRefresh('activeRoute')) {
        const activeResult = await this.refreshActiveRoute(currentData, filters, showAllDrivers);
        if (activeResult) {
          Object.assign(updates, activeResult);
        }
        this.markRefreshed('activeRoute');
      }
      
      // PRIORITY 2: Historical date sync (opportunistic, one at a time)
      const todayStr = format(new Date(), 'yyyy-MM-dd');
      const historicalDates = [...new Set(
        currentData.deliveries
          ?.filter(d => d && d.delivery_date && d.delivery_date !== todayStr)
          ?.map(d => d.delivery_date)
          ?.sort((a, b) => b.localeCompare(a)) // Most recent first
      )];
      
      if (historicalDates.length > 0) {
        const historicalResult = await this.checkOneHistoricalDate(currentData.deliveries, historicalDates);
        if (historicalResult?.hasChanges) {
          updates.deliveries = historicalResult.deliveries;
        }
      }
      
      // PRIORITY 3: Background entity refreshes (longer intervals)
       if (this.shouldRefresh('todayPatients') && currentData.patients) {
         try {
           const todayDeliveries = currentData.deliveries?.filter(d => {
             return d && d.delivery_date === todayStr;
           }) || [];

           const patientResult = await this.refreshTodayPatients(currentData.patients, todayDeliveries);
           if (patientResult?.hasChanges) {
             updates.patients = patientResult.patients;
           }
           this.markRefreshed('todayPatients');
         } catch (e) {
           console.warn('⚠️ [SmartRefresh] Patient refresh failed:', e.message);
         }
       }

       // Refresh AppUsers status (includes driver status)
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

       // PRIORITY 4: Payroll records (5-minute cycle)
       if (this.shouldRefresh('payroll') && currentData.payrollRecords && currentData.periodStart && currentData.periodEnd) {
         try {
           const payrollResult = await this.refreshPayrollRecords(currentData.payrollRecords, currentData.periodStart, currentData.periodEnd);
           if (payrollResult?.hasChanges) {
             updates.payrollRecords = payrollResult.payrollRecords;
             // Dispatch event to notify payroll UI
             if (typeof window !== 'undefined') {
               window.dispatchEvent(new CustomEvent('payrollRecordsUpdated', {
                 detail: { records: payrollResult.payrollRecords }
               }));
             }
           }
           this.markRefreshed('payroll');
         } catch (e) {
           console.warn('⚠️ [SmartRefresh] Payroll refresh failed:', e.message);
         }
       }

       // DISABLED: Square Transactions now sync via real-time events only
       // They update when COD items are created/edited/deleted, not on every refresh cycle

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
        // Reset active route timer to force immediate refresh
        this.lastRefreshTimes.activeRoute = 0;
        break;
        
      case 'Patient':
        // Reset patient refresh timer
        this.lastRefreshTimes.todayPatients = 0;
        this.lastRefreshTimes.patients = 0;
        break;
        
      case 'AppUser':
        // Reset active route timer (includes driver locations)
        this.lastRefreshTimes.activeRoute = 0;
        this.lastRefreshTimes.appUsers = 0;
        break;
        
      case 'Store':
        // Reset store refresh timer
        this.lastRefreshTimes.stores = 0;
        break;
        
      case 'Payroll':
        // Reset payroll refresh timer
        this.lastRefreshTimes.payroll = 0;
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
   * Smart refresh for Square Transactions
   * CRITICAL: Fetches updated Square transaction data and caches to offline DB
   */
  async refreshSquareTransactions(currentTransactions = []) {
    try {
      if (!this.shouldRefresh('squareTransactions')) {
        return null;
      }
      
      this.markRefreshed('squareTransactions');
      await this.waitForRateLimit();
      
      const lastTimestamp = getLatestUpdateTimestamp(currentTransactions);
      
      let queryFilter = {};
      if (lastTimestamp) {
        queryFilter.updated_date = {
          $gte: lastTimestamp.toISOString()
        };
      }
      
      const updatedTransactions = await queueEntityRequest(
        () => base44.entities.SquareTransaction.filter(queryFilter, '-updated_date', 500),
        'SquareTransaction filter'
      );
      
      // Record success
      this.recordSuccess();
      
      if (!updatedTransactions || updatedTransactions.length === 0) {
        return null;
      }
      
      const diff = diffEntityArrays(currentTransactions, updatedTransactions);
      
      if (diff.toUpdate.length === 0 && diff.toAdd.length === 0) {
        return null;
      }
      
      const mergedTransactions = mergeEntityChanges(currentTransactions, diff);
      
      // CRITICAL: Sync to offline database after changes
      try {
        const { offlineDB } = await import('./offlineDatabase');
        await offlineDB.bulkSave(offlineDB.STORES.SQUARE_TRANSACTIONS, mergedTransactions);
      } catch (offlineError) {
        console.warn('⚠️ [SmartRefresh] Failed to sync Square Transactions to offline DB:', offlineError);
      }
      
      return {
        hasChanges: true,
        squareTransactions: mergedTransactions
      };
      
    } catch (error) {
      // CRITICAL: Record error for exponential backoff
      this.recordError();
      
      if (error.response?.status === 429 || error.message?.includes('429')) {
        console.warn('⏰ [SmartRefresh] Rate limit on Square Transactions - skipping cycle');
        this.notifyRateLimit(true);
      } else if (error.message?.includes('WebSocket') || error.message?.includes('closed')) {
        console.warn('🔌 [SmartRefresh] WebSocket error on Square Transactions - skipping cycle');
      } else {
        console.warn('⚠️ [SmartRefresh] Error refreshing Square Transactions (non-fatal):', error.message || error);
      }
      return null;
    }
  }

  /**
   * Smart refresh for Payroll records
   * CRITICAL: Used by DriverPayroll page to sync payroll confirmation status
   */
  async refreshPayrollRecords(currentRecords, periodStart, periodEnd) {
    try {
      if (!this.shouldRefresh('payroll')) {
        return null;
      }
      
      if (!periodStart || !periodEnd) {
        return null;
      }
      
      this.markRefreshed('payroll');
      await this.waitForRateLimit();
      
      const queryFilter = {
        pay_period_start: periodStart,
        pay_period_end: periodEnd
      };
      
      const updatedRecords = await queueEntityRequest(
        () => base44.entities.Payroll.filter(queryFilter),
        'Payroll filter'
      );
      
      // Record success
      this.recordSuccess();
      
      if (!updatedRecords) {
        return null;
      }
      
      // Check for changes
      const currentIds = new Set(currentRecords.map(r => r.id));
      
      // Check for new records or status changes
      let hasChanges = false;
      
      // New records added
      if (updatedRecords.some(r => !currentIds.has(r.id))) {
        hasChanges = true;
      }
      
      // Existing records changed
      if (!hasChanges) {
        for (const updated of updatedRecords) {
          const current = currentRecords.find(r => r.id === updated.id);
          if (current && current.status !== updated.status) {
            hasChanges = true;
            break;
          }
        }
      }
      
      if (!hasChanges) {
        return null;
      }
      
      console.log(`📊 [SmartRefresh] Payroll records updated: ${updatedRecords.length} records`);
      
      return {
        hasChanges: true,
        payrollRecords: updatedRecords
      };
      
    } catch (error) {
      // CRITICAL: Record error for exponential backoff
      this.recordError();
      
      if (error.response?.status === 429 || error.message?.includes('429')) {
        console.warn('⏰ [SmartRefresh] Rate limit on payroll - skipping cycle');
        this.notifyRateLimit(true);
      } else if (error.message?.includes('WebSocket') || error.message?.includes('closed')) {
        console.warn('🔌 [SmartRefresh] WebSocket error on payroll - skipping cycle');
      } else {
        console.warn('⚠️ [SmartRefresh] Error refreshing payroll (non-fatal):', error.message || error);
      }
      return null;
    }
  }
  
  /**
   * CRITICAL: DISABLED - was causing unnecessary data reloads
   */
  async checkAndRestartOfflineSync() {
    // DISABLED - this was triggering full data reloads
    return { skipped: true, reason: 'disabled' };
  }
}

export const smartRefreshManager = new SmartRefreshManager();