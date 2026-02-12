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

    // Minimal intervals - only for non-WebSocket entities and offline sync
    this.intervals = {
      cities: 300000,        // 5min - Full Cities dataset
      stores: 300000,        // 5min - Full Stores dataset
      appUsers: 60000,       // 1min - AppUser backup sync (catches WebSocket misses)
      offlineSync: 60000,    // 1min - Offline DB reconciliation
      cacheRefresh: 300000   // 5min - Cache consistency check
    };

    this.lastRefreshTimes = {
      cities: 0,
      stores: 0,
      appUsers: 0,
      offlineSync: 0,
      cacheRefresh: 0
    };

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

      // CRITICAL: Refresh AppUsers every 15 seconds as backup for WebSocket
      // This catches status changes that WebSocket might miss
      if (this.shouldRefresh('appUsers') && currentData.appUsers) {
        try {
          console.log('👥 [LightweightRefresh] Syncing AppUsers (backup for WebSocket)');
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
              console.log(`✅ [LightweightRefresh] AppUsers updated: +${diff.toAdd.length} ~${diff.toUpdate.length}`);
              
              // CRITICAL: Save to offline DB immediately
              const { offlineDB } = await import('./offlineDatabase');
              await offlineDB.bulkSave(offlineDB.STORES.APP_USERS, updates.appUsers);
              
              // Broadcast the updates
              window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
                detail: { appUsers: updates.appUsers, fromSmartRefresh: true }
              }));
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