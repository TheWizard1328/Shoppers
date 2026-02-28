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
      syncInterval: 5 * 60 * 1000, // 5 minutes
      historicalDaysToSync: 90, // Sync past 90 days
      batchSize: 50, // Number of records per batch
      maxAPICallsPerCycle: 10, // Limit API calls per sync cycle
      // New: control historical sync behavior
      deferHistoricalOnLoad: true, // Do NOT run historical sync immediately on app load
      historicalDeferMinutes: 15,   // Wait 15 minutes after load before allowing historical sync
      offPeakWindows: [
        // 24h HH:mm local time windows considered low traffic
        { start: '21:00', end: '06:00' }
      ],
      historicalMaxDatesPerCycleDaytime: 1,  // If allowed in daytime (rare), use tiny chunks
      historicalMaxDatesPerCycleOffpeak: 5,  // Larger chunks in off-peak
      throttleBetweenCallsMsDaytime: 1500,
      throttleBetweenCallsMsOffpeak: 300,
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

    // Only run historical sync during off-peak windows
    if (!this.isOffPeakNow()) {
      console.log('🌙 [BackgroundSync] Skipping historical deliveries sync (outside off-peak window)');
      return;
    }

    // Get dates that need syncing (check last sync time per date)
    const datesToSync = [];
    for (let i = 1; i <= this.config.historicalDaysToSync; i++) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dateStr = format(date, 'yyyy-MM-dd');
      
      // Check if we have data for this date in offline DB
      const existingData = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, dateStr);
      
      // Sync if no data or data is older than 1 hour
      if (!existingData || existingData.length === 0) {
        datesToSync.push(dateStr);
      }
    }

    if (datesToSync.length === 0) {
      console.log('✅ [BackgroundSync] Historical deliveries up to date');
      return;
    }

    // Sync oldest dates first, but limit to available API calls
    const maxDates = this.isOffPeakNow()
      ? (this.config.historicalMaxDatesPerCycleOffpeak || 5)
      : (this.config.historicalMaxDatesPerCycleDaytime || 1);
    const datesToSyncNow = datesToSync.slice(0, Math.min(maxDates, this.config.maxAPICallsPerCycle - this.currentCycleAPICalls));
    
    console.log(`🔄 [BackgroundSync] Syncing ${datesToSyncNow.length} historical dates`);

    for (const dateStr of datesToSyncNow) {
      if (this.isPaused || !this.isRunning) break;

      try {
        const deliveries = await base44.entities.Delivery.filter({ delivery_date: dateStr });
        if (deliveries && deliveries.length > 0) {
          await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, deliveries);
          console.log(`✅ [BackgroundSync] Synced ${deliveries.length} deliveries for ${dateStr}`);
        }
        this.currentCycleAPICalls++;
        this.lastSyncTimes.deliveries = new Date().toISOString();
      } catch (error) {
        // Silently fail on rate limits
        if (error.response?.status === 429 || error.message?.includes('429')) {
          console.log('⏰ [BackgroundSync] Rate limited - stopping delivery sync');
          break;
        }
        console.warn(`⚠️ [BackgroundSync] Failed to sync deliveries for ${dateStr}:`, error.message);
      }

      // Small delay between dates to avoid rate limits
      const throttle = this.isOffPeakNow()
        ? (this.config.throttleBetweenCallsMsOffpeak || 300)
        : (this.config.throttleBetweenCallsMsDaytime || 1500);
      await new Promise(resolve => setTimeout(resolve, throttle));
    }

    this.notifySubscribers({ type: 'deliveries_synced', count: datesToSyncNow.length });
  }

  /**
   * Sync patient data incrementally
   */
  async syncPatients() {
    if (this.currentCycleAPICalls >= this.config.maxAPICallsPerCycle) return;

    try {
      // Get patients updated in the last 7 days
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      const sevenDaysAgoISO = sevenDaysAgo.toISOString();

      const recentPatients = await base44.entities.Patient.filter({
        updated_date: { $gte: sevenDaysAgoISO }
      });

      if (recentPatients && recentPatients.length > 0) {
        await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, recentPatients);
        console.log(`✅ [BackgroundSync] Synced ${recentPatients.length} recently updated patients`);
        this.notifySubscribers({ type: 'patients_synced', count: recentPatients.length });
      }

      this.currentCycleAPICalls++;
      this.lastSyncTimes.patients = new Date().toISOString();
    } catch (error) {
      if (error.response?.status === 429 || error.message?.includes('429')) {
        console.log('⏰ [BackgroundSync] Rate limited - skipping patient sync');
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

    try {
      const appUsers = await base44.entities.AppUser.list();
      
      if (appUsers && appUsers.length > 0) {
        await offlineDB.bulkSave(offlineDB.STORES.APP_USERS, appUsers);
        console.log(`✅ [BackgroundSync] Synced ${appUsers.length} app users`);
        this.notifySubscribers({ type: 'appUsers_synced', count: appUsers.length });
      }

      this.currentCycleAPICalls++;
      this.lastSyncTimes.appUsers = new Date().toISOString();
    } catch (error) {
      if (error.response?.status === 429 || error.message?.includes('429')) {
        console.log('⏰ [BackgroundSync] Rate limited - skipping appUsers sync');
        return;
      }
      console.warn('⚠️ [BackgroundSync] AppUser sync failed:', error.message);
    }
  }

  /**
   * Sync city data
   */
  async syncCities() {
    if (this.currentCycleAPICalls >= this.config.maxAPICallsPerCycle) return;

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
  async loadConfig() {
    try {
      const settings = await base44.entities.AppSettings.filter({
        setting_key: 'background_sync_config'
      });

      if (settings && settings.length > 0) {
        const savedConfig = settings[0].setting_value;
        this.updateConfig(savedConfig);
        console.log('⚙️ [BackgroundSync] Loaded config from AppSettings');
      }
    } catch (error) {
      console.warn('⚠️ [BackgroundSync] Failed to load config:', error.message);
    }
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