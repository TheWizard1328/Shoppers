// smartRefreshManager.js - Manages intelligent, differential data refreshes

import { base44 } from "@/api/base44Client";
import { diffEntityArrays, mergeEntityChanges, getLatestUpdateTimestamp, mergeDriverLocations, logDiffStats } from "./dataDiffer";
import { format } from "date-fns";
import { invalidate } from "./dataManager";
import { touchUserCache } from "./auth";
import { queueEntityRequest } from "./requestQueue";
import { initializeAutoDarkMode, getSetting } from "./userSettingsManager";
import { globalFilters } from "./globalFilters";

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
    this._currentUser = null; // Store current user for location polling
    
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
      appUsers: 120000,              // 2min - ENTIRE AppUser dataset (reduced from 15s to prevent rate limits)
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
      activeRoute: 0,            // Combined: today's deliveries + driver locations (15s)
      appUsers: 0,               // Full AppUser dataset (15s)
      cities: 0,                 // Full Cities dataset (5min)
      stores: 0,                 // Full Stores dataset (5min)
      patients: 0,               // Full Patients dataset (once daily)
      deliveries: 0,             // Last 90 days of deliveries (once daily)
      squareTransactions: 0,     // Square transaction updates (10min)
      payroll: 0                 // Payroll records (5min)
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
    this._lastIncompleteDeliveriesCount = 0; // Track incomplete delivery count for auto-centering
    
    // CRITICAL: Track incomplete stops per driver for route completion detection
    this._lastIncompleteStopsByDriver = new Map(); // driverId -> incompleteCount
    
    // CRITICAL: Track which stop has isNextDelivery flag per driver for auto-centering
    this._lastNextDeliveryStopByDriver = new Map(); // driverId -> deliveryId
    
    // CRITICAL: Track deliveries that have pending local updates
    // This prevents smart refresh from overwriting them with stale DB data
    this.pendingLocalUpdates = new Map(); // deliveryId -> { expiresAt, driverId, deliveryDate }

    // CRITICAL: Track patients that have pending local updates
    this.pendingPatientUpdates = new Map(); // patientId -> { expiresAt }
    
    // CRITICAL: Track AppUsers with pending status changes
    this.pendingAppUserUpdates = new Map(); // appUserId -> { expiresAt, field }

    // Setup user interaction tracking for adaptive refresh
    this._setupInteractionTracking();
    
    // CRITICAL: Track IDs that were deleted via broadcast
    // These should be removed from UI even if smart refresh brings them back from stale offline DB
    this.deletedDeliveryIds = new Set();
    this.deletedPatientIds = new Set();
    
    // Track last AppUser sync time to avoid duplicate syncs on initial load
    this._lastAppUserSyncTime = 0;
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
   * Register a pending AppUser update (driver status change)
   * This prevents smart refresh from overwriting it for 10 seconds
   */
  registerPendingAppUserUpdate(appUserId, field = 'driver_status') {
    const expiresAt = Date.now() + 10000; // 10 second protection window
    this.pendingAppUserUpdates.set(appUserId, { expiresAt, field });
    console.log(`🛡️ [SmartRefresh] Protected AppUser ${appUserId} ${field} from overwrite for 10s`);
  }
  
  /**
   * Check if an AppUser has a pending local update
   */
  hasPendingAppUserUpdate(appUserId) {
    const entry = this.pendingAppUserUpdates.get(appUserId);
    if (!entry) return false;
    
    // Check if protection window expired
    if (Date.now() > entry.expiresAt) {
      this.pendingAppUserUpdates.delete(appUserId);
      return false;
    }
    
    return true;
  }
  
  /**
   * Clear pending AppUser update
   */
  clearPendingAppUserUpdate(appUserId) {
    this.pendingAppUserUpdates.delete(appUserId);
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
      
      // CRITICAL: Dispatch rate limit event for UI indicator
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('rateLimitDetected', {
          detail: { hasError: true, timestamp: Date.now() }
        }));
      }
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
   * Dispatch event when syncing entity to offline DB (for UI feedback)
   * Used by OfflineSyncIndicator to show real-time sync progress
   */
  _dispatchPeriodicSyncEvent(entityName, count, isComplete = false) {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('periodicSyncProgress', {
        detail: {
          entity: entityName,
          count: count,
          isComplete: isComplete,
          timestamp: new Date().toISOString()
        }
      }));
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

          // CRITICAL: Dispatch event for UI feedback
          this._dispatchPeriodicSyncEvent('Deliveries', finalDeliveries.length, true);

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

          // CRITICAL: Dispatch event for UI feedback
          this._dispatchPeriodicSyncEvent('Deliveries', finalDeliveries.length);

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

              // CRITICAL: Detect role changes and dispatch event for UI update
              const roleChanges = diff.toUpdate.filter(update => {
                const current = currentAppUsers.find(u => u.id === update.id);
                if (!current) return false;
                const currentRoles = JSON.stringify((current.app_roles || []).sort());
                const newRoles = JSON.stringify((update.app_roles || []).sort());
                return currentRoles !== newRoles;
              });

              if (roleChanges.length > 0) {
                console.log(`🔐 [SmartRefresh] Detected role changes in ${roleChanges.length} AppUsers`);
                if (typeof window !== 'undefined') {
                  window.dispatchEvent(new CustomEvent('userRolesChanged', {
                    detail: { appUsers: roleChanges }
                  }));
                }
              }

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
    * CRITICAL: When showAllDrivers is true, ALWAYS fetches ALL drivers from API and updates all markers
    * @param currentAppUsers - Current AppUser data
    * @param forceRefresh - If true, bypasses offline DB and forces API fetch
    * @param currentPage - Current page name (to check if on Dashboard)
    * @param selectedDate - Selected date (to check if today)
    * @param showAllDrivers - If true, fetches ALL drivers regardless of page/date checks
    * CRITICAL: Never throws - always returns null on error to prevent stuck refresh
    */
   async refreshDriverLocations(currentAppUsers, forceRefresh = false, currentPage = null, selectedDate = null, showAllDrivers = false) {
     try {
       // Check if disabled or paused - silently skip automatic polling (unless forced)
       if ((!this._enabled || this._paused) && !forceRefresh) {
         return null;
       }

       // CRITICAL: When showAllDrivers is true, ALWAYS fetch - skip page/date checks
       if (!showAllDrivers && !forceRefresh && currentPage && selectedDate) {
         const todayStr = format(new Date(), 'yyyy-MM-dd');
         const selectedDateStr = format(selectedDate, 'yyyy-MM-dd');

         if (currentPage !== 'Dashboard' || selectedDateStr !== todayStr) {
           console.log(`⏭️ [SmartRefresh] Skipping driver location refresh - not on Dashboard today (page: ${currentPage}, date: ${selectedDateStr})`);
           return null;
         }
       }
      
      // CRITICAL: Use adaptive interval based on user activity
      const adaptiveInterval = this.getAdaptiveDriverLocationInterval();
      const now = Date.now();
      const timeSinceLastRefresh = now - (this.lastRefreshTimes.driverLocation || 0);
      
      if (!forceRefresh && timeSinceLastRefresh < adaptiveInterval) {
        return null;
      }
      
      this.lastRefreshTimes.driverLocation = now;
      
      // CRITICAL: Load from offline DB (kept fresh by performPrioritySyncBeforeRefresh every 15s)
      // This avoids duplicate API calls and uses the data that was just synced
      const { offlineDB } = await import('./offlineDatabase');
      const offlineAppUsers = await offlineDB.getAll(offlineDB.STORES.APP_USERS);
      
      if (!offlineAppUsers || offlineAppUsers.length === 0) {
        console.log(`⚠️ [SmartRefresh] No AppUsers in offline DB - waiting for priority sync`);
        return null;
      }
      
      // Merge offline data with current state (always prefer offline since it's authoritative)
      const updatedAppUsers = currentAppUsers.map(au => {
        const offlineVersion = offlineAppUsers.find(ad => ad.user_id === au.user_id);
        if (offlineVersion) {
          // CRITICAL: Always use offline DB version (it's kept fresh by priority sync)
          // This prevents bouncing between old/new data and ensures real-time location updates
          return offlineVersion;
        }
        return au;
      });

      // Add any new AppUsers from offline DB
      offlineAppUsers.forEach(offlineAu => {
        if (!updatedAppUsers.find(au => au.user_id === offlineAu.user_id)) {
          updatedAppUsers.push(offlineAu);
        }
      });
      
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

        // CRITICAL: Dispatch event for UI feedback
        this._dispatchPeriodicSyncEvent('Patients', mergedPatients.length);
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

      // CRITICAL: Dispatch event for UI feedback
      this._dispatchPeriodicSyncEvent('Stores', mergedStores.length);

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
            d.stop_order !== fetchedVersion.stop_order ||
            d.isNextDelivery !== fetchedVersion.isNextDelivery;
          
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
   * CRITICAL: PURGE-AND-RESYNC pattern - deletes offline DB, fetches fresh from API
   * CRITICAL: When showAllDrivers is true, fetch ALL drivers and refresh their delivery data
   * @param {boolean} showAllDrivers - If true, refreshes ALL drivers' data regardless of selected driver
   * @param {string} currentPage - Current page name (to check if on Dashboard)
   * @param {Date} selectedDate - Selected date (to check if today)
   */
  async refreshActiveRoute(currentData, filters, showAllDrivers = false, currentPage = null, selectedDate = null) {
  const updates = {};
  const todayStr = format(new Date(), 'yyyy-MM-dd');
  const activeDateStr = globalFilters?.getSelectedDate?.() || todayStr;

  try {
    const { offlineDB } = await import('./offlineDatabase');

    // STEP 1: DELETE offline AppUsers completely
    console.log('🗑️ [ActiveRoute] STEP 1: Deleting ALL offline AppUsers...');
    await offlineDB.clearStore(offlineDB.STORES.APP_USERS);
    console.log('✅ [ActiveRoute] Offline AppUsers cleared');

    // STEP 2: FETCH fresh AppUsers from API
    console.log('📡 [ActiveRoute] STEP 2: Fetching fresh AppUsers from API...');
    await this.waitForRateLimit();
    const freshAppUsers = await queueEntityRequest(
      () => base44.entities.AppUser.list(),
      'AppUser list [PURGE-RESYNC]'
    );

    if (!freshAppUsers || freshAppUsers.length === 0) {
      console.warn('⚠️ [ActiveRoute] No AppUsers returned from API');
      return null;
    }

    // STEP 3: RESYNC AppUsers to offline DB
    console.log(`💾 [ActiveRoute] STEP 3: Resyncing ${freshAppUsers.length} AppUsers to offline DB...`);
    await offlineDB.bulkSave(offlineDB.STORES.APP_USERS, freshAppUsers);
    console.log('✅ [ActiveRoute] AppUsers resynced to offline DB');
    updates.appUsers = freshAppUsers;

    // STEP 4: FETCH and sync relevant patients for the selected date deliveries
    console.log('📡 [ActiveRoute] STEP 4: Fetching deliveries to determine patient IDs...');
    await this.waitForRateLimit();
    const cityOnlyFilter = { delivery_date: activeDateStr };

    if (showAllDrivers) {
      console.log(`📦 [ActiveRoute] Show All mode - fetching ALL drivers for ${activeDateStr}`);
    } else if (filters.deliveryFilter?.driver_id) {
      cityOnlyFilter.driver_id = filters.deliveryFilter.driver_id;
    }

    if (filters.deliveryFilter?.store_id) {
      cityOnlyFilter.store_id = filters.deliveryFilter.store_id;
    }

    const fetchedDeliveries = await queueEntityRequest(
      () => base44.entities.Delivery.filter(cityOnlyFilter),
      `Delivery filter [active, ${activeDateStr}]`
    );

    if (fetchedDeliveries && fetchedDeliveries.length > 0) {
      // Extract patient IDs from fetched deliveries
      const patientIds = [...new Set(fetchedDeliveries.map(d => d.patient_id).filter(Boolean))];

      if (patientIds.length > 0) {
        console.log(`👥 [ActiveRoute] Fetching ${patientIds.length} patients for deliveries...`);
        await this.waitForRateLimit();
        const patientsForActiveDate = await queueEntityRequest(
          () => base44.entities.Patient.filter({ id: { $in: patientIds } }),
          `Patient filter [active date patients]`
        );

        if (patientsForActiveDate && patientsForActiveDate.length > 0) {
          await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, patientsForActiveDate);
          console.log(`✅ [ActiveRoute] Synced ${patientsForActiveDate.length} patients to offline DB`);

          // Update patients in state
          const diff = diffEntityArrays(currentData.patients || [], patientsForActiveDate);
          if (diff.toUpdate.length > 0 || diff.toAdd.length > 0) {
            const merged = mergeEntityChanges(currentData.patients || [], diff);
            updates.patients = merged;
          }
        }
      }

      // STEP 5: DELETE all offline deliveries for selected date
      console.log(`🗑️ [ActiveRoute] STEP 5: Deleting offline deliveries for ${activeDateStr}...`);
      await offlineDB.deleteDeliveriesByDate(activeDateStr);
      console.log('✅ [ActiveRoute] Offline deliveries deleted');

      // STEP 6: FETCH fresh deliveries already done above (fetchedDeliveries)
      console.log(`📦 [ActiveRoute] STEP 6: Already fetched ${fetchedDeliveries.length} deliveries from API`);

      // STEP 7: RESYNC deliveries to offline DB
      console.log(`💾 [ActiveRoute] STEP 7: Resyncing ${fetchedDeliveries.length} deliveries to offline DB...`);
      await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, fetchedDeliveries);
      console.log('✅ [ActiveRoute] Deliveries resynced to offline DB');

      // Update state with fresh API data (no merging - complete replacement)
      const otherDeliveries = currentData.deliveries.filter(d => d && d.delivery_date !== activeDateStr);

      // Preserve items with pending local updates
      const protectedDeliveries = currentData.deliveries.filter(d => 
        d && d.delivery_date === activeDateStr && this.hasPendingUpdate(d.id)
      );

      updates.deliveries = [...otherDeliveries, ...fetchedDeliveries, ...protectedDeliveries];
      console.log(`✨ [ActiveRoute] Replaced with ${fetchedDeliveries.length} fresh deliveries (+${protectedDeliveries.length} protected)`);
    } else {
      // CRITICAL: Even if no deliveries fetched, force return offline DB data for UI update
      console.log('📦 [ActiveRoute] No deliveries fetched, loading from offline DB for UI update...');
      const offlineDeliveries = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, activeDateStr);
      const otherDeliveries = currentData.deliveries.filter(d => d && d.delivery_date !== activeDateStr);
      updates.deliveries = [...otherDeliveries, ...(offlineDeliveries || [])];
    }

    // CRITICAL: Always return fresh patients from offline DB for UI update
    const offlinePatients = await offlineDB.getAll(offlineDB.STORES.PATIENTS);
    if (offlinePatients && offlinePatients.length > 0) {
      updates.patients = offlinePatients;
    }

    this.recordSuccess();

      // CRITICAL: STEP FINAL - Compare state AFTER all refreshes with state BEFORE refresh
      // Only trigger centering if something actually changed
      if (activeDriverId && updates.deliveries) {
        const activeDriverDeliveriesAfter = updates.deliveries.filter(d => 
          d && d.driver_id === activeDriverId && d.delivery_date === activeDateStr
        );

        // Count incomplete deliveries AFTER refresh
        const incompleteCountAfter = activeDriverDeliveriesAfter.filter(d => 
          !['completed', 'failed', 'cancelled', 'returned'].includes(d.status)
        ).length;

        // Find isNextDelivery stop AFTER refresh
        const nextDeliveryStopAfter = activeDriverDeliveriesAfter.find(d => d.isNextDelivery === true);
        const nextDeliveryStopIdAfter = nextDeliveryStopAfter?.id || null;

        console.log(`📊 [SmartRefresh] STEP FINAL: Comparing state - before: incomplete=${stateBeforeRefresh.incompleteCount} nextStop=${stateBeforeRefresh.nextDeliveryStopId}, after: incomplete=${incompleteCountAfter} nextStop=${nextDeliveryStopIdAfter}`);

        // Check if either incomplete count OR isNextDelivery stop ID changed
        const incompleteCountChanged = stateBeforeRefresh.incompleteCount !== incompleteCountAfter;
        const nextDeliveryStopChanged = stateBeforeRefresh.nextDeliveryStopId !== nextDeliveryStopIdAfter;

        if (incompleteCountChanged || nextDeliveryStopChanged) {
          console.log(`🎯 [SmartRefresh] State changed - triggering center: incomplete=${incompleteCountChanged} nextStop=${nextDeliveryStopChanged}`);
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('incompleteDeliveriesCountChanged'));
          }
        }

        // Check for route completion (all deliveries done)
        const hasNextDeliveryAfter = activeDriverDeliveriesAfter.some(d => d.isNextDelivery === true);
        const routeCompleted = incompleteCountAfter === 0 && !hasNextDeliveryAfter && stateBeforeRefresh.incompleteCount > 0;

        if (routeCompleted) {
          console.log(`✅ [SmartRefresh] Driver ${activeDriverId} completed all stops - activating phase 1`);
          if (typeof window !== 'undefined') {
            const { fabControlEvents } = await import('./fabControlEvents');
            fabControlEvents.notifyDoneButtonClicked();
          }
        }
      }

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
   * Set current user for location polling
   */
  setCurrentUser(user) {
    this._currentUser = user;
  }

  /**
    * NEW: Combined smart refresh - 15s active route, opportunistic historical
    * @param {string} currentPage - Current page name (to check if on Dashboard)
    * @param {Date} selectedDate - Selected date (to check if today)
    */
  async performSmartRefresh(currentData, filters, isEntityUpdating = false, showAllDrivers = false, currentPage = null, selectedDate = null) {
   if (!this._enabled) {
     this.isRefreshing = false;
     return null;
   }

   if (this._paused) {
     this.isRefreshing = false;
     return null;
   }

   if (isEntityUpdating) {
     this.isRefreshing = false;
     return null;
   }

   if (this.isRefreshing && this._refreshStartTime && (Date.now() - this._refreshStartTime > 30000)) {
     console.warn('🔓 [SmartRefresh] Auto-unlocking stuck refresh state (>30s)');
     this.isRefreshing = false;
   }

   if (this.isRefreshing) {
     return null;
   }

   try {
     touchUserCache();
   } catch (e) {
     // Ignore errors from touchUserCache
   }

   this.isRefreshing = true;
    this._refreshStartTime = Date.now();
    const updates = {};

    // CRITICAL: STEP 0 - Determine view mode (Show All vs All Drivers vs Individual Driver)
    const todayStr = format(new Date(), 'yyyy-MM-dd');
    const activeDateStr = selectedDate ? format(selectedDate, 'yyyy-MM-dd') : todayStr;
    const selectedDriverId = globalFilters?.getSelectedDriverId?.() || filters?.deliveryFilter?.driver_id;
    const isViewingTodayDate = activeDateStr === todayStr;

    // CRITICAL: Check global Show All state
    const { showAllDataManager } = await import('./showAllDataManager');
    const isShowAllMode = showAllDataManager.getShowAllState();
    const isAllDriversMode = selectedDriverId === 'all';
    const isIndividualDriverMode = !isShowAllMode && !isAllDriversMode && selectedDriverId && selectedDriverId !== 'all';

    // Determine which driver ID to use for filtering
    const activeDriverId = isIndividualDriverMode ? selectedDriverId : null;

    // CRITICAL: Update showAllDrivers flag based on actual mode BEFORE using activeDriverId
    const shouldFetchAllDrivers = isShowAllMode || isAllDriversMode || showAllDrivers;
    
    console.log(`🔍 [SmartRefresh] View mode - Show All: ${isShowAllMode}, All Drivers: ${isAllDriversMode}, Individual: ${isIndividualDriverMode}, Driver: ${activeDriverId || 'ALL'}`);

    // Capture state BEFORE refresh
    const stateBeforeRefresh = {
      incompleteCount: 0,
      nextDeliveryStopId: null
    };

    if (activeDriverId && currentData.deliveries) {
      const activeDriverDeliveries = currentData.deliveries.filter(d => 
        d && d.driver_id === activeDriverId && d.delivery_date === activeDateStr
      );

      // Count incomplete deliveries
      stateBeforeRefresh.incompleteCount = activeDriverDeliveries.filter(d => 
        !['completed', 'failed', 'cancelled', 'returned'].includes(d.status)
      ).length;

      // Find current isNextDelivery stop
      const nextDeliveryStop = activeDriverDeliveries.find(d => d.isNextDelivery === true);
      if (nextDeliveryStop) {
        stateBeforeRefresh.nextDeliveryStopId = nextDeliveryStop.id;
      }

      console.log(`📸 [SmartRefresh] STEP 0: Captured state before refresh - incomplete: ${stateBeforeRefresh.incompleteCount}, nextStop: ${stateBeforeRefresh.nextDeliveryStopId}`);
    }

    // CRITICAL: Run priority sync FIRST before any other refresh operations
    // This ensures AppUsers, active date Deliveries, and associated Patients are always fresh
    // CRITICAL: When in Show All or All Drivers mode, fetch ALL drivers' deliveries
    try {
      const selectedDateStr = selectedDate ? format(selectedDate, 'yyyy-MM-dd') : format(new Date(), 'yyyy-MM-dd');
      const { performPrioritySyncBeforeRefresh } = await import('./offlineSync');
      await performPrioritySyncBeforeRefresh(selectedDateStr, filters?.cityFilter?.city_id || null, this, shouldFetchAllDrivers);
    } catch (priorityError) {
      console.warn('⚠️ [SmartRefresh] Priority sync failed:', priorityError.message);
      // Continue with regular refresh even if priority sync fails
    }
    
    try {
      // CRITICAL: ONLY sync AppUsers and display driver locations when viewing TODAY's date
      // When viewing past dates, DO NOT pull driver locations
      if (isViewingTodayDate) {
        // PRIORITY 0 (CRITICAL): Load AppUsers from offline DB (kept fresh by priority sync every 15s)
        // Only fetch from API every 2 minutes if offline DB is stale
        // CRITICAL: When in Show All or All Drivers mode, ALWAYS process all drivers
        const shouldFetchAppUsers = shouldFetchAllDrivers || (currentPage === 'Dashboard');

          if (this.shouldRefresh('appUsers') && currentData.appUsers && shouldFetchAppUsers) {
          try {
            console.log(`📡 [SmartRefresh] PRIORITY 0: Loading driver locations from offline DB (Show All: ${isShowAllMode}, All Drivers: ${isAllDriversMode})`);
            const { offlineDB } = await import('./offlineDatabase');
            const appUsersFromOfflineDB = await offlineDB.getAll(offlineDB.STORES.APP_USERS);

            if (appUsersFromOfflineDB && appUsersFromOfflineDB.length > 0) {
              console.log(`📍 [SmartRefresh] Loaded ${appUsersFromOfflineDB.length} driver locations from offline DB`);
              
              // CRITICAL: ALWAYS update state with ALL AppUsers from offline DB
              // This ensures all driver markers are refreshed, not just the active driver
              updates.appUsers = appUsersFromOfflineDB;

              // Process through driverLocationPoller
              try {
                const { driverLocationPoller } = await import('./driverLocationPoller');
                const currentUser = this._currentUser;

                if (currentUser) {
                  driverLocationPoller.processLocationData(
                    currentUser, 
                    currentData.deliveries,
                    [],
                    [],
                    appUsersFromOfflineDB, 
                    selectedDate || new Date(),
                    true, // forceNotify
                    currentPage || 'Dashboard',
                    shouldFetchAllDrivers // Use the resolved flag
                  );
                }
              } catch (pollerError) {
                console.warn('⚠️ [SmartRefresh] Failed to process through poller:', pollerError.message);
              }

              // Dispatch event - CRITICAL: Include the mode flags
              if (typeof window !== 'undefined') {
                window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
                  detail: { 
                    appUsers: appUsersFromOfflineDB,
                    showAllDrivers: shouldFetchAllDrivers,
                    forceAll: true
                  }
                }));
              }
            }
          } catch (offlineError) {
            console.warn('⚠️ [SmartRefresh] Failed to load AppUsers from offline DB:', offlineError.message);
          }
        }
      } else {
        console.log(`⏭️ [SmartRefresh] Skipping driver location sync - viewing past date (${activeDateStr}), not today (${todayStr})`);
      }

      // PRIORITY 1: Active route data (15-second cycle)
      // Now uses fresh driver locations from offline DB (just synced above)
      // CRITICAL: Pass the shouldFetchAllDrivers flag to fetch all drivers when in Show All/All Drivers mode
      if (this.shouldRefresh('activeRoute')) {
        const activeResult = await this.refreshActiveRoute(currentData, filters, shouldFetchAllDrivers, currentPage, selectedDate);
        if (activeResult) {
          Object.assign(updates, activeResult);
        }
        this.markRefreshed('activeRoute');
      }
      
      // PRIORITY 2: Historical date sync (opportunistic, one at a time)
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

      // PRIORITY 2C: Every 5 minutes - FULL Cities + Stores datasets (entire sync, one hit each)
      if (this.shouldRefresh('cities') && currentData.cities) {
        try {
          console.log('🏙️ [SmartRefresh] Syncing FULL Cities dataset (every 5min)');
          const citiesResult = await this.refreshAllCitiesFullSync(currentData.cities);
          if (citiesResult?.hasChanges) {
            updates.cities = citiesResult.cities;
          }
          this.markRefreshed('cities');
        } catch (e) {
          console.warn('⚠️ [SmartRefresh] Full Cities sync failed:', e.message);
        }
      }

      if (this.shouldRefresh('stores') && currentData.stores) {
        try {
          console.log('🏪 [SmartRefresh] Syncing FULL Stores dataset (every 5min)');
          const storesResult = await this.refreshAllStoresFullSync(currentData.stores);
          if (storesResult?.hasChanges) {
            updates.stores = storesResult.stores;
          }
          this.markRefreshed('stores');
        } catch (e) {
          console.warn('⚠️ [SmartRefresh] Full Stores sync failed:', e.message);
        }
      }

      // PRIORITY 3: Once daily - FULL Patient + Last 90 days Deliveries
      if (this.shouldRefresh('patients') && currentData.patients) {
        try {
          console.log('👥 [SmartRefresh] Syncing FULL Patient dataset + last 90 days deliveries (once daily)');
          const patientResult = await this.refreshAllPatientsFullSync(currentData.patients);
          if (patientResult?.hasChanges) {
            updates.patients = patientResult.patients;
          }
          this.markRefreshed('patients');
        } catch (e) {
          console.warn('⚠️ [SmartRefresh] Full Patient sync failed:', e.message);
        }
      }

      // PRIORITY 3B: Throughout the day - Update patients for current date + selected date deliveries
      const selectedDateStr = globalFilters?.getSelectedDate?.() || todayStr;
      if (selectedDateStr !== todayStr && currentData.deliveries && currentData.patients && Array.isArray(currentData.patients)) {
        try {
          console.log(`👥 [SmartRefresh] Syncing patients for current+selected dates (${todayStr}, ${selectedDateStr})`);
          const relevantDeliveries = currentData.deliveries.filter(d => 
            d && (d.delivery_date === todayStr || d.delivery_date === selectedDateStr)
          );
          const uniquePatientIds = [...new Set(relevantDeliveries.map(d => d.patient_id).filter(Boolean))];
          const relevantPatientResult = await this.refreshRelevantPatientsOnly(currentData.patients, uniquePatientIds);
          if (relevantPatientResult?.hasChanges) {
            updates.patients = relevantPatientResult.patients;
          }
        } catch (e) {
          console.warn('⚠️ [SmartRefresh] Relevant patient sync failed:', e.message);
        }
      }

      // PRIORITY 3C: Throughout the day - Update deliveries for current date + selected date only
      if (selectedDateStr !== todayStr && currentData.deliveries) {
        try {
          console.log(`📦 [SmartRefresh] Syncing deliveries for current+selected dates (${todayStr}, ${selectedDateStr})`);
          const selectedDateDeliveryResult = await this.refreshSelectDateDeliveries(currentData.deliveries, selectedDateStr);
          if (selectedDateDeliveryResult?.hasChanges) {
            updates.deliveries = selectedDateDeliveryResult.deliveries;
          }
        } catch (e) {
          console.warn('⚠️ [SmartRefresh] Selected date delivery sync failed:', e.message);
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

      // CRITICAL: ALWAYS return offline DB data even if no changes detected
      // This ensures UI is always in sync with offline DB regardless of diff logic
      try {
        const { offlineDB } = await import('./offlineDatabase');
        
        // Force return deliveries for active date from offline DB
        if (!updates.deliveries && currentData.deliveries) {
          const offlineDeliveries = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, activeDateStr);
          if (offlineDeliveries && offlineDeliveries.length > 0) {
            const otherDeliveries = currentData.deliveries.filter(d => d && d.delivery_date !== activeDateStr);
            updates.deliveries = [...otherDeliveries, ...offlineDeliveries];
            console.log(`🔄 [SmartRefresh] Force returning ${offlineDeliveries.length} deliveries from offline DB for UI sync`);
          }
        }
        
        // CRITICAL: ALWAYS force return ALL AppUsers from offline DB for proper location marker updates
        // This ensures that location markers update for ALL drivers in Show All and All Drivers modes
        const offlineAppUsers = await offlineDB.getAll(offlineDB.STORES.APP_USERS);
        if (offlineAppUsers && offlineAppUsers.length > 0 && isViewingTodayDate) {
          updates.appUsers = offlineAppUsers;
          console.log(`🔄 [SmartRefresh] Force returning ${offlineAppUsers.length} AppUsers from offline DB for location marker sync (Mode: ${isShowAllMode ? 'Show All' : isAllDriversMode ? 'All Drivers' : 'Individual'})`);
          
          // CRITICAL: Dispatch location update event with mode flags
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
              detail: { 
                appUsers: offlineAppUsers,
                showAllDrivers: shouldFetchAllDrivers,
                forceAll: true
              }
            }));
          }
        }
        
        // Force return stores from offline DB
        if (!updates.stores && currentData.stores) {
          const offlineStores = await offlineDB.getAll(offlineDB.STORES.STORES);
          if (offlineStores && offlineStores.length > 0) {
            updates.stores = offlineStores;
          }
        }
        
        // Force return patients from offline DB
        if (!updates.patients && currentData.patients) {
          const offlinePatients = await offlineDB.getAll(offlineDB.STORES.PATIENTS);
          if (offlinePatients && offlinePatients.length > 0) {
            updates.patients = offlinePatients;
          }
        }
      } catch (forceError) {
        console.warn('⚠️ [SmartRefresh] Failed to force offline data return:', forceError.message);
      }
      
      // ALWAYS return updates object (even if empty, Dashboard will handle it)
      return updates;
      
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

        // CRITICAL: Dispatch event for UI feedback
        this._dispatchPeriodicSyncEvent('Square TX', mergedTransactions.length);
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

   /**
    * NEW: Full AppUser sync - every 15 seconds
    * NEW Workflow: 1) Read AppUsers from API 2) Update GPS if on default device 3) Update UI 4) Save to offline DB
    * @param {boolean} showAllDrivers - If true, processes all drivers through poller
    */
   async refreshAllAppUsersFullSync(currentAppUsers, currentPageName = null, selectedDate = null, showAllDrivers = false) {
     try {
       // STEP 1: Read entire AppUser database from API
       console.log('🔄 [SmartRefresh] STEP 1: Reading entire AppUser database from API...');
       await this.waitForRateLimit();
       const allAppUsers = await queueEntityRequest(
         () => base44.entities.AppUser.list(),
         'AppUser list [FULL SYNC]'
       );

       this.recordSuccess();

       if (!allAppUsers || allAppUsers.length === 0) {
         console.warn('⚠️ [SmartRefresh] No AppUsers returned from API');
         return null;
       }

       console.log(`📥 [SmartRefresh] Fetched ${allAppUsers.length} AppUsers from API`);

       // STEP 2: Update PRIMARY device GPS to both online and offline databases
       const { isDriver } = await import('./userRoles');
       const { locationTracker } = await import('./locationTracker');
       const { getCurrentDevice } = await import('./deviceManager');

       if (this._currentUser && isDriver(this._currentUser) && locationTracker.lastPosition) {
         // Check if this device is the primary tracker
         const currentDevice = await getCurrentDevice(this._currentUser.id);
         const isPrimaryTracker = currentDevice?.is_primary_tracker !== false;

         if (isPrimaryTracker) {
           const currentAppUser = allAppUsers.find(au => au.user_id === this._currentUser.id);
           if (currentAppUser) {
             console.log('📍 [SmartRefresh] STEP 2: Updating PRIMARY device GPS to online + offline...');

             const nowISO = new Date().toISOString();
             const updateData = {
               current_latitude: locationTracker.lastPosition.latitude,
               current_longitude: locationTracker.lastPosition.longitude,
               location_updated_at: nowISO
             };

             try {
               // Push to API first
               await base44.entities.AppUser.update(currentAppUser.id, updateData);
               console.log(`✅ [SmartRefresh] Pushed GPS to API: ${updateData.current_latitude.toFixed(6)}, ${updateData.current_longitude.toFixed(6)}`);

               // Update in fetched dataset (will be saved to offline DB in STEP 4)
               currentAppUser.current_latitude = updateData.current_latitude;
               currentAppUser.current_longitude = updateData.current_longitude;
               currentAppUser.location_updated_at = updateData.location_updated_at;
             } catch (error) {
               console.warn('⚠️ [SmartRefresh] Failed to push GPS to API:', error.message);
             }
           }
         }
       }

       // Deduplicate by user_id (keep most recent by location_updated_at, then updated_date)
       const appUsersByUserId = new Map();
       allAppUsers.forEach(au => {
         if (!au || !au.user_id) return;
         const existing = appUsersByUserId.get(au.user_id);

         if (!existing) {
           appUsersByUserId.set(au.user_id, au);
         } else {
           const newLocationTime = au.location_updated_at ? new Date(au.location_updated_at).getTime() : 0;
           const existingLocationTime = existing.location_updated_at ? new Date(existing.location_updated_at).getTime() : 0;
           const newUpdatedTime = au.updated_date ? new Date(au.updated_date).getTime() : 0;
           const existingUpdatedTime = existing.updated_date ? new Date(existing.updated_date).getTime() : 0;

           // Prioritize by location_updated_at first
           if (newLocationTime > existingLocationTime) {
             appUsersByUserId.set(au.user_id, au);
           } else if (newLocationTime === existingLocationTime && newUpdatedTime > existingUpdatedTime) {
             // If location times equal, use updated_date
             appUsersByUserId.set(au.user_id, au);
           }
         }
       });
       const deduplicatedAppUsers = Array.from(appUsersByUserId.values());
       const duplicatesRemoved = allAppUsers.length - deduplicatedAppUsers.length;
       if (duplicatesRemoved > 0) {
         console.warn(`⚠️ [SmartRefresh] Removed ${duplicatesRemoved} duplicate AppUsers`);
       }

       // STEP 3: Update UI with driver locations and statuses
       console.log(`📍 [SmartRefresh] STEP 3: Updating UI with ${deduplicatedAppUsers.length} driver locations...`);
       
       try {
         const { driverLocationPoller } = await import('./driverLocationPoller');
         const currentUser = this._currentUser;

         if (currentUser) {
           console.log(`📍 [SmartRefresh] Processing ${deduplicatedAppUsers.length} AppUsers through poller (showAllDrivers: ${showAllDrivers})`);
           driverLocationPoller.processLocationData(
             currentUser, 
             [], 
             [], 
             [], 
             deduplicatedAppUsers, 
             selectedDate || new Date(),
             true, // forceNotify
             currentPageName || 'Dashboard',
             showAllDrivers // Pass through showAllDrivers flag
           );
         }
       } catch (pollerError) {
         console.warn('⚠️ [SmartRefresh] Failed to process through poller:', pollerError.message);
       }

       if (typeof window !== 'undefined') {
         window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
           detail: { 
             appUsers: deduplicatedAppUsers, 
             forceAll: true,
             showAllDrivers: showAllDrivers 
           }
         }));
       }

       // STEP 4: Save updated data to offline DB
       try {
         const { offlineDB } = await import('./offlineDatabase');
         console.log(`💾 [SmartRefresh] STEP 4: Saving ${deduplicatedAppUsers.length} AppUsers to offline DB...`);
         await offlineDB.bulkSave(offlineDB.STORES.APP_USERS, deduplicatedAppUsers);
         console.log(`✅ [SmartRefresh] AppUsers saved to offline DB`);

         await offlineDB.updateSyncStatus('AppUser', {
           recordCount: deduplicatedAppUsers.length,
           status: 'synced',
           lastSync: new Date().toISOString()
         });
       } catch (offlineError) {
         console.error('❌ [SmartRefresh] Failed to save AppUsers to offline DB:', offlineError.message);
       }

       return {
         hasChanges: true,
         appUsers: deduplicatedAppUsers
       };
     } catch (error) {
       this.recordError();
       this.recordConnectionError(error);
       console.error('❌ [SmartRefresh] Full AppUser sync error:', error.message);
       if (error.response?.status === 429 || error.message?.includes('429')) {
         console.warn('⏰ [SmartRefresh] Rate limit on full AppUser sync');
         this.notifyRateLimit(true);
       }
       return null;
     }
   }

   /**
    * NEW: Full Cities sync - every 5 minutes, entire dataset in one API hit
    */
   async refreshAllCitiesFullSync(currentCities) {
     try {
       await this.waitForRateLimit();
       const allCities = await queueEntityRequest(
         () => base44.entities.City.list(),
         'City list [FULL SYNC]'
       );

       this.recordSuccess();

       if (!allCities || allCities.length === 0) {
         return null;
       }

       // Sync entire dataset to offline DB
       try {
         const { offlineDB } = await import('./offlineDatabase');
         await offlineDB.bulkSave(offlineDB.STORES.CITIES, allCities);
         await offlineDB.updateSyncStatus('City', {
           recordCount: allCities.length,
           status: 'synced',
           lastSync: new Date().toISOString()
         });
         console.log(`✅ [SmartRefresh] Full Cities sync: ${allCities.length} records`);
       } catch (offlineError) {
         console.warn('⚠️ [SmartRefresh] Failed to sync Cities to offline DB:', offlineError);
       }

       const diff = diffEntityArrays(currentCities, allCities);

       if (diff.toUpdate.length === 0 && diff.toAdd.length === 0 && diff.toRemove.length === 0) {
         return null;
       }

       const merged = mergeEntityChanges(currentCities, diff);
       return {
         hasChanges: true,
         cities: merged
       };
     } catch (error) {
       this.recordError();
       this.recordConnectionError(error);
       if (error.response?.status === 429 || error.message?.includes('429')) {
         console.warn('⏰ [SmartRefresh] Rate limit on full Cities sync');
         this.notifyRateLimit(true);
       }
       return null;
     }
   }

   /**
    * NEW: Full Stores sync - every 5 minutes, entire dataset in one API hit
    */
   async refreshAllStoresFullSync(currentStores) {
     try {
       await this.waitForRateLimit();
       const allStores = await queueEntityRequest(
         () => base44.entities.Store.list(),
         'Store list [FULL SYNC]'
       );

       this.recordSuccess();

       if (!allStores || allStores.length === 0) {
         return null;
       }

       // Sync entire dataset to offline DB
       try {
         const { offlineDB } = await import('./offlineDatabase');
         await offlineDB.bulkSave(offlineDB.STORES.STORES, allStores);
         await offlineDB.updateSyncStatus('Store', {
           recordCount: allStores.length,
           status: 'synced',
           lastSync: new Date().toISOString()
         });
         console.log(`✅ [SmartRefresh] Full Stores sync: ${allStores.length} records`);
       } catch (offlineError) {
         console.warn('⚠️ [SmartRefresh] Failed to sync Stores to offline DB:', offlineError);
       }

       const diff = diffEntityArrays(currentStores, allStores);

       if (diff.toUpdate.length === 0 && diff.toAdd.length === 0 && diff.toRemove.length === 0) {
         return null;
       }

       const merged = mergeEntityChanges(currentStores, diff);
       return {
         hasChanges: true,
         stores: merged
       };
     } catch (error) {
       this.recordError();
       this.recordConnectionError(error);
       if (error.response?.status === 429 || error.message?.includes('429')) {
         console.warn('⏰ [SmartRefresh] Rate limit on full Stores sync');
         this.notifyRateLimit(true);
       }
       return null;
     }
   }

   /**
    * NEW: Full Patients sync - once daily, entire dataset + last 90 days deliveries
    */
   async refreshAllPatientsFullSync(currentPatients) {
     try {
       // First sync all active patients
       await this.waitForRateLimit();
       const allPatients = await queueEntityRequest(
         () => base44.entities.Patient.list(),
         'Patient list [FULL SYNC - ALL]'
       );

       this.recordSuccess();

       if (!allPatients || allPatients.length === 0) {
         return null;
       }

       // Sync entire patient dataset to offline DB
       try {
         const { offlineDB } = await import('./offlineDatabase');
         await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, allPatients);

         // Also sync last 90 days of deliveries
         const ninetyDaysAgo = new Date();
         ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
         const startDateStr = format(ninetyDaysAgo, 'yyyy-MM-dd');

         await this.waitForRateLimit();
         const last90DeliveriesResult = await queueEntityRequest(
           () => base44.entities.Delivery.filter({
             delivery_date: { $gte: startDateStr }
           }, '-updated_date', 5000),
           'Delivery list [LAST 90 DAYS]'
         );

         if (last90DeliveriesResult && last90DeliveriesResult.length > 0) {
           await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, last90DeliveriesResult);
         }

         await offlineDB.updateSyncStatus('Patient', {
           recordCount: allPatients.length,
           status: 'synced',
           lastSync: new Date().toISOString(),
           lastFullSync: new Date().toISOString()
         });
         console.log(`✅ [SmartRefresh] Full Patient sync: ${allPatients.length} records + last 90 days deliveries`);
       } catch (offlineError) {
         console.warn('⚠️ [SmartRefresh] Failed to sync Patients to offline DB:', offlineError);
       }

       const diff = diffEntityArrays(currentPatients, allPatients);

       if (diff.toUpdate.length === 0 && diff.toAdd.length === 0 && diff.toRemove.length === 0) {
         return null;
       }

       const merged = mergeEntityChanges(currentPatients, diff);
       return {
         hasChanges: true,
         patients: merged
       };
     } catch (error) {
       this.recordError();
       this.recordConnectionError(error);
       if (error.response?.status === 429 || error.message?.includes('429')) {
         console.warn('⏰ [SmartRefresh] Rate limit on full Patient sync');
         this.notifyRateLimit(true);
       }
       return null;
     }
   }

   /**
    * NEW: Sync only patients referenced by current date + selected date deliveries
    */
   async refreshRelevantPatientsOnly(currentPatients, relevantPatientIds) {
     try {
       // CRITICAL: Guard against undefined currentPatients
       if (!currentPatients || !Array.isArray(currentPatients)) {
         console.warn('⚠️ [SmartRefresh] currentPatients is undefined or not an array - skipping patient sync');
         return null;
       }

       if (!relevantPatientIds || relevantPatientIds.length === 0) {
         return null;
       }

       await this.waitForRateLimit();
       const relevantPatients = await queueEntityRequest(
         () => base44.entities.Patient.filter({
           id: { $in: relevantPatientIds }
         }),
         `Patient list [${relevantPatientIds.length} for dates]`
       );

       this.recordSuccess();

       if (!relevantPatients || relevantPatients.length === 0) {
         return null;
       }

       // Sync to offline DB
       try {
         const { offlineDB } = await import('./offlineDatabase');
         await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, relevantPatients);
       } catch (offlineError) {
         console.warn('⚠️ [SmartRefresh] Failed to sync relevant patients to offline DB:', offlineError);
       }

       const diff = diffEntityArrays(currentPatients, relevantPatients);

       if (diff.toUpdate.length === 0 && diff.toAdd.length === 0) {
         return null;
       }

       const merged = mergeEntityChanges(currentPatients, diff);
       return {
         hasChanges: true,
         patients: merged
       };
     } catch (error) {
       if (error.response?.status === 429 || error.message?.includes('429')) {
         console.warn('⏰ [SmartRefresh] Rate limit on relevant patient sync');
         this.notifyRateLimit(true);
       }
       return null;
     }
   }

   /**
    * NEW: Sync deliveries for selected date only
    */
   async refreshSelectDateDeliveries(currentDeliveries, selectedDateStr) {
     try {
       await this.waitForRateLimit();
       const selectedDateDeliveries = await queueEntityRequest(
         () => base44.entities.Delivery.filter({
           delivery_date: selectedDateStr
         }),
         `Delivery filter [selected: ${selectedDateStr}]`
       );

       this.recordSuccess();

       if (!selectedDateDeliveries || selectedDateDeliveries.length === 0) {
         return null;
       }

       // Sync to offline DB
       try {
         const { offlineDB } = await import('./offlineDatabase');
         await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, selectedDateDeliveries);
       } catch (offlineError) {
         console.warn('⚠️ [SmartRefresh] Failed to sync selected date deliveries to offline DB:', offlineError);
       }

       // Merge with other dates
       const otherDeliveries = currentDeliveries.filter(d => d && d.delivery_date !== selectedDateStr);
       const diff = diffEntityArrays(
         currentDeliveries.filter(d => d && d.delivery_date === selectedDateStr),
         selectedDateDeliveries
       );

       if (diff.toUpdate.length === 0 && diff.toAdd.length === 0) {
         return null;
       }

       const merged = mergeEntityChanges(
         currentDeliveries.filter(d => d && d.delivery_date === selectedDateStr),
         diff
       );

       return {
         hasChanges: true,
         deliveries: [...otherDeliveries, ...merged]
       };
     } catch (error) {
       if (error.response?.status === 429 || error.message?.includes('429')) {
         console.warn('⏰ [SmartRefresh] Rate limit on selected date delivery sync');
         this.notifyRateLimit(true);
       }
       return null;
     }
   }
  }

  export const smartRefreshManager = new SmartRefreshManager();