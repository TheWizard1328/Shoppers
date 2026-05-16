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
      // Historical sync: after 8 PM only, incremental count-based
      deferHistoricalOnLoad: true,
      historicalDeferMinutes: 15,
      offPeakWindows: [
        // After 8 PM until 6 AM local time
        { start: '20:00', end: '06:00' }
      ],
      historicalMaxDatesPerCycleDaytime: 0,   // Never run during daytime
      historicalMaxDatesPerCycleOffpeak: 3,   // 3 dates per cycle off-peak (conservative)
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
   */
  resume() {
    console.log('▶️ [BackgroundSync] Resumed');
    this.isPaused = false;

    if (this.isRunning && !this.currentSyncInterval) {
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

    // Defer historical sync on initial load
    if (this.config.deferHistoricalOnLoad && this.minutesSinceStart() < this.config.historicalDeferMinutes) {
      console.log('⏭️ [BackgroundSync] Deferring historical deliveries sync during initial load window');
      return;
    }

    // GATE: Only run historical delivery sync after 8 PM local time
    const nowHour = new Date().getHours();
    if (nowHour < 20) {
      console.log('🌙 [BackgroundSync] Skipping historical deliveries sync (before 8 PM)');
      return;
    }

    // Build list of historical dates: yesterday back to Jan 1 of current year
    const today = new Date();
    const jan1 = new Date(today.getFullYear(), 0, 1);
    const allDates = [];
    let cursor = new Date(today);
    cursor.setDate(cursor.getDate() - 1); // start from yesterday
    while (cursor >= jan1) {
      allDates.push(format(cursor, 'yyyy-MM-dd'));
      cursor.setDate(cursor.getDate() - 1);
    }

    // Find next date that needs syncing using count-based validation
    let syncedCount = 0;
    const maxDatesPerCycle = this.config.historicalMaxDatesPerCycleOffpeak || 3;

    for (const dateStr of allDates) {
      if (this.isPaused || !this.isRunning) break;
      if (syncedCount >= maxDatesPerCycle) break;
      if (this.currentCycleAPICalls >= this.config.maxAPICallsPerCycle) break;

      try {
        // Count offline records for this date
        const offlineRecords = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, dateStr);
        const offlineCount = (offlineRecords || []).length;

        // Fetch online records (also reused for save if counts differ)
        const onlineDeliveries = await base44.entities.Delivery.filter({ delivery_date: dateStr }, '-updated_date', 5000);
        const onlineCount = (onlineDeliveries || []).length;
        this.currentCycleAPICalls++;

        // Skip if counts match and we have data — already synced
        if (onlineCount === offlineCount && offlineCount > 0) {
          console.log(`✅ [BackgroundSync] ${dateStr} already synced (${offlineCount} records) — skipping`);
          continue;
        }

        // Counts differ — save the online data to offline DB
        await offlineDB.replaceRecordsByIndex(offlineDB.STORES.DELIVERIES, 'delivery_date', dateStr, onlineDeliveries || []);
        console.log(`🔄 [BackgroundSync] Synced ${onlineCount} deliveries for ${dateStr} (was ${offlineCount})`);
        syncedCount++;
        this.lastSyncTimes.deliveries = new Date().toISOString();
      } catch (error) {
        if (error.response?.status === 429 || error.message?.includes('429')) {
          console.log('⏰ [BackgroundSync] Rate limited - stopping delivery sync');
          break;
        }
        console.warn(`⚠️ [BackgroundSync] Failed to sync deliveries for ${dateStr}:`, error.message);
      }

      // Throttle between dates to avoid rate limits
      await new Promise(resolve => setTimeout(resolve, this.config.throttleBetweenCallsMsOffpeak || 500));
    }

    this.notifySubscribers({ type: 'deliveries_synced', count: syncedCount });
  }

  /**
   * Sync patient data incrementally — one store per cycle, after 8 PM ONLY.
   * VERY conservative: skips if store has > 50 patients (too expensive). Compares offline count to online count per store.
   */
  async syncPatients() {
    if (this.currentCycleAPICalls >= this.config.maxAPICallsPerCycle) return;

    // GATE: Only run after 8 PM local time (strict limit)
    if (new Date().getHours() < 20) {
      console.log('🌙 [BackgroundSync] Skipping patient sync (before 8 PM)');
      return;
    }

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