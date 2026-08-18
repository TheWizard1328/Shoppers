import { base44 } from '@/api/base44Client';
import { offlineDB } from './offlineDatabase';
import { format } from 'date-fns';

/**
 * Background Sync Manager
 * 
 * Runs periodic background synchronization to keep offline database current
 * with historical data and less critical entities. Operates independently
 * from smartRefreshManager and user interactions.
 * 
 * Features:
 * - Configurable sync intervals and priorities
 * - Intelligent rate limiting to avoid API overload
 * - Uses requestIdleCallback for non-urgent syncs
 * - Pausable during critical operations
 * - Syncs historical deliveries, patients, and driver data incrementally
 */

class BackgroundSyncManager {
  constructor() {
    this.isRunning = false;
    this.configLoadedAt = 0;
    this.configLoadPromise = null;
    this.isPaused = false;
    this.currentSyncInterval = null;
    this.lastSyncTimes = {
      deliveries: null,
      patients: null,
      appUsers: null,
      cities: null
    };
    
    // Default configuration
    this.config = {
      enabled: true,
      syncInterval: 60 * 60 * 1000, // 60 minutes (increased from 30)
      historicalDaysToSync: 90, // Sync past 90 days
      batchSize: 50, // Number of records per batch
      maxAPICallsPerCycle: 1, // Single API call per cycle to avoid 429s
      // Historical sync: 10 PM to 8 AM only, one date at a time (slow & steady)
      deferHistoricalOnLoad: true,
      historicalDeferMinutes: 15,
      offPeakWindows: [
        // 10 PM until 8 AM local time
        { start: '22:00', end: '08:00' }
      ],
      historicalMaxDatesPerCycleDaytime: 0,   // Never run during daytime
      historicalMaxDatesPerCycleOffpeak: 1,   // 1 date per cycle off-peak (slow & steady)
      throttleBetweenCallsMsDaytime: 5000,
      throttleBetweenCallsMsOffpeak: 500,
      priorities: {
        deliveries: 1, // Highest priority
        patients: 2,
        appUsers: 3,
        cities: 4 // Lowest priority
      }
    };
    
    this.currentCycleAPICalls = 0;
    this.appStartTime = Date.now();
    this.subscribers = new Set();
    this.historicalSyncDateCursor = null; // Persisted across cycles for sequential day-by-day backfill
  }

  /**
   * Start the background sync manager
   */
  start() {
    if (this.isRunning) {
      console.log('⏭️ [BackgroundSync] Already running');
      return;
    }

    console.log('🔄 [BackgroundSync] Starting background synchronization...');
    this.isRunning = true;
    this.scheduleNextSync();
  }

  /**
   * Stop the background sync manager
   */
  stop() {
    console.log('🛑 [BackgroundSync] Stopping background synchronization');
    this.isRunning = false;
    if (this.currentSyncInterval) {
      clearTimeout(this.currentSyncInterval);
      this.currentSyncInterval = null;
    }
  }

  /**
   * Pause background syncs (e.g., during form edits or imports)
   */
  pause() {
    console.log('⏸️ [BackgroundSync] Paused');
    this.isPaused = true;
  }

  /**
   * Resume background syncs
   * CRITICAL: Clear any existing timeout and schedule a fresh sync immediately.
   * The old code only scheduled if !currentSyncInterval, which meant if a timeout
   * was already pending (set before the pause), resume would NOT schedule a new one.
   * With a 60-minute default interval, this meant the next sync could be up to
   * 60 minutes after resume — leaving the manager effectively "paused" to the user.
   */
  resume() {
    console.log('▶️ [BackgroundSync] Resumed');
    this.isPaused = false;
    // Always clear pause regardless of isRunning state — if the manager isn't
    // running yet, the pause flag is still correctly cleared for when it does start.
    if (this.isRunning) {
      if (this.currentSyncInterval) {
        clearTimeout(this.currentSyncInterval);
        this.currentSyncInterval = null;
      }
      this.scheduleNextSync();
    }
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
    console.log('⚙️ [BackgroundSync] Configuration updated:', this.config);
    
    // Restart if running to apply new interval
    if (this.isRunning) {
      this.stop();
      this.start();
    }
  }

  /**
   * Schedule the next sync cycle
   */
  scheduleNextSync() {
    if (!this.isRunning) return;

    this.currentSyncInterval = setTimeout(() => {
      this.runSyncCycle();
    }, this.config.syncInterval);
  }

  /**
   * Run a complete sync cycle
   */
  async runSyncCycle() {
    if (!this.config.enabled || this.isPaused || !this.isRunning) {
      console.log('⏭️ [BackgroundSync] Skipping cycle - disabled, paused, or stopped');
      this.scheduleNextSync();
      return;
    }

    console.log('🔄 [BackgroundSync] Starting sync cycle...');
    this.currentCycleAPICalls = 0;
    
    try {
      // Use requestIdleCallback for non-urgent syncs to avoid blocking UI
      if (typeof window !== 'undefined' && window.requestIdleCallback) {
        window.requestIdleCallback(async () => {
          await this.executeSyncTasks();
        }, { timeout: 30000 }); // 30 second timeout
      } else {
        await this.executeSyncTasks();
      }
    } catch (error) {
      console.error('❌ [BackgroundSync] Sync cycle failed:', error);
      this.notifySubscribers({ type: 'error', error: error.message });
    }

    // Schedule next cycle
    this.scheduleNextSync();
  }

  /**
   * Determine if current local time is within an off-peak window
   */
  isOffPeakNow() {
    const toMinutes = (str) => {
      const [h, m] = str.split(':').map(Number);
      return h * 60 + m;
    };
    const now = new Date();
    const minutesNow = now.getHours() * 60 + now.getMinutes();
    return (this.config.offPeakWindows || []).some(({ start, end }) => {
      const s = toMinutes(start);
      const e = toMinutes(end);
      // window may wrap midnight
      if (s <= e) {
        return minutesNow >= s && minutesNow <= e;
      }
      return minutesNow >= s || minutesNow <= e;
    });
  }

  /**
   * Minutes since app start
   */
  minutesSinceStart() {
    return Math.floor((Date.now() - (this.appStartTime || Date.now())) / 60000);
  }

  /**
   * Execute sync tasks in priority order
   */
  async executeSyncTasks() {
    const tasks = [
      { name: 'deliveries', priority: this.config.priorities.deliveries, fn: () => this.syncHistoricalDeliveries() },
      { name: 'patients', priority: this.config.priorities.patients, fn: () => this.syncPatients() },
      { name: 'appUsers', priority: this.config.priorities.appUsers, fn: () => this.syncAppUsers() },
      { name: 'cities', priority: this.config.priorities.cities, fn: () => this.syncCities() }
    ];

    // Sort by priority (lower number = higher priority)
    tasks.sort((a, b) => a.priority - b.priority);

    // Execute tasks in order, respecting API call limits
    for (const task of tasks) {
      if (this.currentCycleAPICalls >= this.config.maxAPICallsPerCycle) {
        console.log('⚠️ [BackgroundSync] API call limit reached for this cycle');
        break;
      }

      if (this.isPaused || !this.isRunning) {
        console.log('⏸️ [BackgroundSync] Paused or stopped during cycle');
        break;
      }

      try {
        await task.fn();
      } catch (error) {
        console.warn(`⚠️ [BackgroundSync] Task ${task.name} failed:`, error.message);
      }
    }

    console.log(`✅ [BackgroundSync] Cycle complete - ${this.currentCycleAPICalls} API calls used`);
    this.notifySubscribers({ type: 'cycle_complete', apiCalls: this.currentCycleAPICalls });
  }

  /**
   * Sync historical deliveries incrementally
   */
  async syncHistoricalDeliveries() {
    if (this.currentCycleAPICalls >= this.config.maxAPICallsPerCycle) return;

    // Only run historical delivery sync during off-peak hours (10 PM – 8 AM local time)
    if (!this.isOffPeakNow()) {
      console.log('⏸️ [BackgroundSync] Historical deliveries sync skipped (off-peak only)');
      return;
    }

    // CRITICAL: NEVER sync today's date — active edits happen on today's deliveries
    // and a background replace would wipe in-progress changes. Start from yesterday.
    if (this.historicalSyncDateCursor == null) {
      const today = new Date();
      today.setDate(today.getDate() - 1);
      this.historicalSyncDateCursor = today;
    }

    // 365-day window — sync one full year of delivery history
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 365);

    const maxDatesPerCycle = this.config.historicalMaxDatesPerCycleOffpeak || 1;
    let syncedCount = 0;
    let cursor = new Date(this.historicalSyncDateCursor);

    // Work backwards one day at a time (slow & steady). Stop after 1 API call.
    while (cursor >= cutoffDate && syncedCount < maxDatesPerCycle) {
      if (this.isPaused || !this.isRunning) break;
      if (this.currentCycleAPICalls >= this.config.maxAPICallsPerCycle) break;

      const dateStr = format(cursor, 'yyyy-MM-dd');

      try {
        const offlineRecords = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, dateStr);
        const offlineCount = (offlineRecords || []).length;

        const onlineDeliveries = await base44.entities.Delivery.filter({ delivery_date: dateStr }, '-updated_date', 5000);
        const onlineCount = (onlineDeliveries || []).length;
        this.currentCycleAPICalls++;

        if (onlineCount === offlineCount && offlineCount > 0) {
          console.log(`✅ [BackgroundSync] ${dateStr} already synced (${offlineCount} records) — skipping`);
        } else {
          // Historical date — safe to replace (no active edits expected here)
          await offlineDB.replaceRecordsByIndex(offlineDB.STORES.DELIVERIES, 'delivery_date', dateStr, onlineDeliveries || []);
          console.log(`🔄 [BackgroundSync] Synced ${onlineCount} deliveries for ${dateStr} (was ${offlineCount})`);
          syncedCount++;
          this.lastSyncTimes.deliveries = new Date().toISOString();
        }

        // Advance cursor so the next cycle picks up the prior day
        cursor.setDate(cursor.getDate() - 1);
        this.historicalSyncDateCursor = new Date(cursor);
      } catch (error) {
        if (error.response?.status === 429 || error.message?.includes('429')) {
          console.log('⏰ [BackgroundSync] Rate limited - stopping delivery sync');
        } else {
          console.warn(`⚠️ [BackgroundSync] Failed to sync deliveries for ${dateStr}:`, error.message);
        }
        break; // Stop on error for this cycle — try again next cycle
      }
    }

    // If we've reached the 365-day cutoff, reset cursor to yesterday so future
    // runs re-validate the most recent history instead of stalling.
    if (this.historicalSyncDateCursor < cutoffDate) {
      const resetDate = new Date();
      resetDate.setDate(resetDate.getDate() - 1);
      this.historicalSyncDateCursor = resetDate;
      console.log('🔄 [BackgroundSync] Historical sync reached 365-day cutoff — resetting cursor to yesterday');
    }

    // Purge deliveries older than 1 year to keep IndexedDB from growing unbounded
    try {
      const pruneResult = await offlineDB.pruneOldDeliveries();
      if (pruneResult?.removed > 0) {
        console.log(`🧹 [BackgroundSync] Purged ${pruneResult.removed} deliveries older than 1 year`);
      }
    } catch (e) {
      console.warn('⚠️ [BackgroundSync] Purge failed:', e.message);
    }

    this.notifySubscribers({ type: 'deliveries_synced', count: syncedCount });
  }

  /**
   * Sync patient data incrementally — one store per cycle, after 8 PM ONLY.
   * VERY conservative: skips if store has > 50 patients (too expensive). Compares offline count to online count per store.
   */
  async syncPatients() {
    if (this.currentCycleAPICalls >= this.config.maxAPICallsPerCycle) return;

    // CRITICAL: Disable background sync of patients during user sessions
    // Background sync was overwriting user selections and edits
    console.log('⏭️ [BackgroundSync] Patient sync disabled to prevent overwrites of user edits');
    return;

    try {
      const stores = await offlineDB.getAll(offlineDB.STORES.STORES);
      if (!stores || stores.length === 0) return;

      // Resume from last store index saved in localStorage
      const resumeKey = 'rxdeliver_patient_sync_store_index';
      let storeIndex = parseInt(localStorage.getItem(resumeKey) || '0', 10);
      if (storeIndex >= stores.length) storeIndex = 0;

      const store = stores[storeIndex];
      if (!store?.id) return;

      // CRITICAL: Skip stores with > 50 patients to avoid 429s on Patient.filter() calls
      const allOfflinePatients = await offlineDB.getAll(offlineDB.STORES.PATIENTS);
      const offlineCount = (allOfflinePatients || []).filter(p => p?.store_id === store.id).length;

      if (offlineCount > 50) {
        console.log(`⏭️ [BackgroundSync] Skipping store ${store.name} (${offlineCount} patients > 50 limit to avoid rate limits)`);
        // Still advance to next store
        const nextIndex = (storeIndex + 1) >= stores.length ? 0 : storeIndex + 1;
        localStorage.setItem(resumeKey, String(nextIndex));
        return;
      }

      // Only sync stores with < 50 patients (lightweight stores only)
      const onlinePatients = await base44.entities.Patient.filter({ store_id: store.id, status: 'active' });
      const onlineCount = (onlinePatients || []).length;
      this.currentCycleAPICalls++;

      if (onlineCount === offlineCount && offlineCount > 0) {
        console.log(`✅ [BackgroundSync] Store ${store.name} already synced (${offlineCount}) — skipping save`);
      } else {
        await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, onlinePatients || []);
        console.log(`🔄 [BackgroundSync] Synced ${onlineCount} patients for store ${store.name} (was ${offlineCount})`);
        this.lastSyncTimes.patients = new Date().toISOString();
      }

      // Advance to next store for next cycle
      const nextIndex = (storeIndex + 1) >= stores.length ? 0 : storeIndex + 1;
      localStorage.setItem(resumeKey, String(nextIndex));
      this.notifySubscribers({ type: 'patients_synced', storeId: store.id, count: onlineCount });
    } catch (error) {
      if (error.response?.status === 429 || error.message?.includes('429') || error.message?.includes('rate limit')) {
        console.log('⏰ [BackgroundSync] Rate limited - stopping patient sync for this cycle');
        return;
      }
      console.warn('⚠️ [BackgroundSync] Patient sync failed:', error.message);
    }
  }

  /**
   * Sync AppUser data
   */
  async syncAppUsers() {
    if (this.currentCycleAPICalls >= this.config.maxAPICallsPerCycle) return;

    console.log('⏭️ [BackgroundSync] AppUser API sync disabled to avoid 429s');
    return;
  }

  /**
   * Sync city data
   */
  async syncCities() {
    if (this.currentCycleAPICalls >= this.config.maxAPICallsPerCycle) return;

    // Daytime throttle: only run cities sync during off-peak windows
    if (!this.isOffPeakNow()) {
      console.log('\u23f0 [BackgroundSync] Skipping cities sync (daytime)');
      return;
    }

    try {
      const cities = await base44.entities.City.list();
      
      if (cities && cities.length > 0) {
        await offlineDB.bulkSave(offlineDB.STORES.CITIES, cities);
        console.log(`✅ [BackgroundSync] Synced ${cities.length} cities`);
        this.notifySubscribers({ type: 'cities_synced', count: cities.length });
      }

      this.currentCycleAPICalls++;
      this.lastSyncTimes.cities = new Date().toISOString();
    } catch (error) {
      if (error.response?.status === 429 || error.message?.includes('429')) {
        console.log('⏰ [BackgroundSync] Rate limited - skipping cities sync');
        return;
      }
      console.warn('⚠️ [BackgroundSync] Cities sync failed:', error.message);
    }
  }

  /**
   * Force an immediate sync cycle
   */
  async forceSyncNow() {
    if (this.isPaused) {
      console.log('⏸️ [BackgroundSync] Cannot force sync while paused');
      return;
    }

    console.log('🔄 [BackgroundSync] Force syncing now...');
    await this.runSyncCycle();
  }

  /**
   * Subscribe to sync events
   */
  subscribe(callback) {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  /**
   * Notify subscribers of sync events
   */
  notifySubscribers(event) {
    this.subscribers.forEach(callback => {
      try {
        callback(event);
      } catch (error) {
        console.error('Error notifying background sync subscriber:', error);
      }
    });
  }

  /**
   * Get sync statistics
   */
  getStats() {
    return {
      isRunning: this.isRunning,
      isPaused: this.isPaused,
      config: this.config,
      lastSyncTimes: this.lastSyncTimes,
      subscriberCount: this.subscribers.size
    };
  }

  /**
   * Load configuration from AppSettings
   */
  async loadConfig(force = false) {
    const now = Date.now();
    if (!force && this.configLoadedAt && now - this.configLoadedAt < 5 * 60 * 1000) {
      return;
    }
    if (this.configLoadPromise) {
      return this.configLoadPromise;
    }

    this.configLoadPromise = (async () => {
      try {
        const settings = await base44.entities.AppSettings.filter({
          setting_key: 'background_sync_config'
        });

        if (settings && settings.length > 0) {
          const savedConfig = settings[0].setting_value;
          this.updateConfig(savedConfig);
          console.log('⚙️ [BackgroundSync] Loaded config from AppSettings');
        }
        this.configLoadedAt = Date.now();
      } catch (error) {
        if (error?.response?.status === 429 || error?.status === 429 || String(error?.message || '').includes('Rate limit exceeded')) {
          console.warn('⚠️ [BackgroundSync] Rate limited while loading config - using cached defaults');
          return;
        }
        console.warn('⚠️ [BackgroundSync] Failed to load config:', error.message);
      } finally {
        this.configLoadPromise = null;
      }
    })();

    return this.configLoadPromise;
  }

  /**
   * Save configuration to AppSettings
   */
  async saveConfig() {
    try {
      const settings = await base44.entities.AppSettings.filter({
        setting_key: 'background_sync_config'
      });

      const settingData = {
        setting_key: 'background_sync_config',
        setting_value: this.config,
        description: 'Background synchronization configuration'
      };

      if (settings && settings.length > 0) {
        await base44.entities.AppSettings.update(settings[0].id, settingData);
      } else {
        await base44.entities.AppSettings.create(settingData);
      }

      console.log('✅ [BackgroundSync] Config saved to AppSettings');
    } catch (error) {
      console.warn('⚠️ [BackgroundSync] Failed to save config:', error.message);
    }
  }
}

// Export singleton instance
export const backgroundSyncManager = new BackgroundSyncManager();