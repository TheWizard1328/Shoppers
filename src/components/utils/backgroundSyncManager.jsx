import { base44 } from '@/api/base44Client';
import { offlineDB } from './offlineDatabase';
import { format } from 'date-fns';
import { syncHistoricalDateCityScoped, loadHistoricalCursor, saveHistoricalCursor, getCityIdsHash } from './historicalDeliverySync';
import { queueEntityRequest, requestQueue } from './requestQueue';

// ── Future-date TTL cache ───────────────────────────────────────────────
// Per-date cache so a future date that returned 0 deliveries is skipped for
// 6 hours instead of being re-fetched every cycle. Dates with >0 deliveries
// are re-checked every cycle so newly-added stops appear promptly.
const FUTURE_CACHE_PREFIX = 'rxdeliver_future_sync_cache_';
const FUTURE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

const readFutureCache = (dateStr) => {
  try {
    const raw = localStorage.getItem(FUTURE_CACHE_PREFIX + dateStr);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.checkedAt !== 'string') return null;
    return parsed;
  } catch (_) { return null; }
};

const writeFutureCache = (dateStr, count) => {
  try {
    localStorage.setItem(FUTURE_CACHE_PREFIX + dateStr, JSON.stringify({ count, checkedAt: new Date().toISOString() }));
  } catch (_) {}
};

// Returns true if this date should be SKIPPED (cached as 0 within the TTL window)
const isFutureDateCachedEmpty = (dateStr) => {
  const cached = readFutureCache(dateStr);
  if (!cached) return false;
  if (cached.count > 0) return false; // active date — always re-check
  const age = Date.now() - new Date(cached.checkedAt).getTime();
  return age < FUTURE_TTL_MS; // 0 deliveries and within 6h → skip
};

// ── Post-load deferral ──────────────────────────────────────────────────
// Future sync waits 5 minutes after app start so it never competes with
// boot-time priority syncs.
const FUTURE_DEFERRAL_MS = 5 * 60 * 1000;

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
      syncInterval: 5 * 60 * 1000, // 5 minutes — gentle cycle so the server has breathing room
      historicalDaysToSync: 90, // Sync past 90 days
      batchSize: 50, // Number of records per batch
      maxAPICallsPerCycle: 15, // Hard cap per cycle — keeps well under rate limits
      // Historical sync: daytime trickle (1 date/cycle) + fast off-peak batch (20 dates/cycle)
      deferHistoricalOnLoad: true,
      historicalDeferMinutes: 15,
      offPeakWindows: [
        // 10 PM until 8 AM local time — fast batch window
        { start: '22:00', end: '08:00' }
      ],
      historicalMaxDatesPerCycleDaytime: 1,   // 1 date per cycle during daytime (gentle trickle)
      historicalMaxDatesPerCycleOffpeak: 20,  // 20 dates per cycle off-peak (capped to respect rate limits)
      throttleBetweenCallsMsDaytime: 2000,
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
    this.historicalSyncDateCursor = null; // Persisted in IndexedDB — resumes across app restarts
    this.currentUser = null;
    this.cityIdsHash = '';
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
   * CRITICAL: Clear any existing timeout and schedule a fresh sync with a
   * deferred delay so we don't jank the UI immediately after a dialog/form closes.
   * The old code only scheduled if !currentSyncInterval, which meant if a timeout
   * was already pending (set before the pause), resume would NOT schedule a new one.
   * With a 60-minute default interval, this meant the next sync could be up to
   * 60 minutes after resume — leaving the manager effectively "paused" to the user.
   *
   * Fix: resume() now schedules the next sync after a 60-second grace period,
   * giving the UI time to settle after dialog/form interactions.
   */
  resume() {
    console.log('▶️ [BackgroundSync] Resumed (next sync in 60s)');
    this.isPaused = false;
    // Always clear pause regardless of isRunning state — if the manager isn't
    // running yet, the pause flag is still correctly cleared for when it does start.
    if (this.isRunning) {
      if (this.currentSyncInterval) {
        clearTimeout(this.currentSyncInterval);
        this.currentSyncInterval = null;
      }
      // Deferred resume — 60s grace period to avoid janking the UI
      // immediately after a dialog/form close.
      this.currentSyncInterval = setTimeout(() => {
        this.runSyncCycle();
      }, 60 * 1000);
    }
  }

  /**
   * Set the current user — needed for city-scoped historical backfill.
   * Called from useLayoutInit when the user is confirmed and data is loaded.
   */
  setCurrentUser(user) {
    this.currentUser = user;
    this.cityIdsHash = getCityIdsHash(user);
    // Reset in-memory cursor so the new user's persisted cursor loads on next cycle
    this.historicalSyncDateCursor = null;
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

    // Role-aware idle/duty gate — historical sync must not run while a driver is
    // actively on a route or a dispatcher is actively interacting with the app.
    //   • Drivers: must be off_duty or on_break (no active route in progress)
    //   • Dispatchers: no user interaction for at least 5 minutes
    //   • Admins: generally idle (2-min background-sync idle threshold)
    try {
      const { userActivityMonitor } = await import('./userActivityMonitor');
      const roles = this.currentUser?.app_roles || [];
      const isDriver = Array.isArray(roles) && roles.includes('driver');
      const isDispatcher = Array.isArray(roles) && roles.includes('dispatcher');
      const isAdmin = Array.isArray(roles) && roles.includes('admin');
      let allowed = true;
      if (isAdmin) {
        allowed = userActivityMonitor.isBackgroundSyncIdle();
      } else if (isDispatcher) {
        allowed = userActivityMonitor.getIdleDuration() >= (5 * 60 * 1000);
      } else if (isDriver) {
        // driver_status lives on the AppUser record — resolve from offline DB if missing
        let driverStatus = this.currentUser?.driver_status || null;
        if (!driverStatus && this.currentUser?.id) {
          try {
            const appUsers = await offlineDB.getByIndex(offlineDB.STORES.APP_USERS, 'user_id', this.currentUser.id);
            driverStatus = appUsers?.[0]?.driver_status;
          } catch (_) {}
        }
        allowed = driverStatus === 'off_duty' || driverStatus === 'on_break';
      } else {
        allowed = userActivityMonitor.isBackgroundSyncIdle();
      }
      if (!allowed) {
        console.log('⏭️ [BackgroundSync] Skipping cycle - role/idle gate not satisfied');
        this.scheduleNextSync();
        return;
      }
    } catch (_) {
      // userActivityMonitor not available — proceed without idle check
    }

    // GLOBAL RATE-LIMIT GATE: if the shared requestQueue is in a 429 backoff
    // window, skip this entire cycle. Without this, the per-date loops below
    // would each hit the queue, get paused, and stack up a burst of deferred
    // requests that all fire at once the moment the window clears.
    if (requestQueue.isRateLimited()) {
      const wait = Math.ceil((requestQueue.rateLimitUntil - Date.now()) / 1000);
      console.log(`⏰ [BackgroundSync] Skipping cycle — global rate-limit backoff active (${wait}s remaining)`);
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
   * Sync future-dated deliveries (+1 to +7 days, city-scoped) on the background
   * cycle — works backwards from +7 toward +1 so that if +7 is empty the loop
   * stops early (future dates further out are less likely to have stops).
   * Cycling markers are never created on future dates, so they are not fetched.
   * Gated by the same idle/duty + rate-limit checks as the rest of the cycle.
   *
   * Persisted cursor (`futureSyncDateCursor`) resumes across restarts; a fresh
   * completeness pass resets to +7 once the loop reaches +1.
   */
  async syncFutureDeliveries() {
    if (this.currentCycleAPICalls >= this.config.maxAPICallsPerCycle) return;
    if (!this.currentUser) return;

    // POST-LOAD DEFERRAL: don't run future sync within 5 minutes of app start so
    // it never competes with boot-time priority syncs.
    const minutesSinceStartVal = Date.now() - (this.appStartTime || Date.now());
    if (minutesSinceStartVal < FUTURE_DEFERRAL_MS) {
      console.log('⏳ [BackgroundSync] Future sync deferred — within 5-min post-load window');
      return;
    }

    const stores = await offlineDB.getAll(offlineDB.STORES.STORES);
    if (!stores || stores.length === 0) return;

    const cityStoreIds = (this.currentUser?.city_id)
      ? (stores || []).filter((s) => s?.city_id === this.currentUser.city_id).map((s) => s.id).filter(Boolean)
      : [];
    const deliveryFilter = cityStoreIds.length > 0 ? { store_id: { $in: cityStoreIds } } : {};

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Cursor walks +7 → +1 (decrementing), then resets to +7. Persisted across
    // restarts so a partial pass resumes. We do NOT cap future dates per cycle —
    // the TTL cache skips empty dates in O(1) so a full +1..+7 pass is cheap
    // (only dates with >0 deliveries, or expired TTL entries, cost an API call).
    const FUTURE_CURSOR_KEY = 'rxdeliver_future_sync_cursor';
    let cursorDate;
    try {
      const persisted = localStorage.getItem(FUTURE_CURSOR_KEY);
      if (persisted) {
        cursorDate = new Date(persisted + 'T00:00:00');
        const offset = Math.round((cursorDate - today) / 86400000);
        if (offset < 1 || offset > 7) cursorDate = null;
      }
    } catch (_) { cursorDate = null; }
    if (!cursorDate) {
      cursorDate = new Date(today);
      cursorDate.setDate(cursorDate.getDate() + 7);
    }

    let fetchedCount = 0;
    let skippedByTtl = 0;

    try {
      while (true) {
        if (this.isPaused || !this.isRunning) break;
        if (this.currentCycleAPICalls >= this.config.maxAPICallsPerCycle) break;

        // GLOBAL RATE-LIMIT GATE inside the loop — break immediately if the
        // shared queue armed a backoff window mid-pass.
        if (requestQueue.isRateLimited()) {
          console.log('⏰ [BackgroundSync] Future sync paused — global rate-limit backoff');
          break;
        }

        const offset = Math.round((cursorDate - today) / 86400000);
        if (offset < 1) break; // reached +1 — pass complete

        const dateStr = format(cursorDate, 'yyyy-MM-dd');

        // TTL CACHE: skip this date entirely (no API call) if it was checked
        // within 6h and returned 0 deliveries.
        if (isFutureDateCachedEmpty(dateStr)) {
          skippedByTtl++;
          cursorDate.setDate(cursorDate.getDate() - 1);
          try { localStorage.setItem(FUTURE_CURSOR_KEY, format(cursorDate, 'yyyy-MM-dd')); } catch (_) {}
          continue;
        }

        try {
          const futureDeliveries = await queueEntityRequest(
            () => base44.entities.Delivery.filter(
              { delivery_date: dateStr, ...deliveryFilter },
              '-updated_date',
              5000
            ),
            `FutureDelivery.filter(${dateStr})`
          ).catch(() => []);
          this.currentCycleAPICalls++;
          fetchedCount++;

          const count = futureDeliveries?.length || 0;
          // Cache the result. Only write on a successful fetch — a 429 or error
          // above falls through to the catch WITHOUT writing, so the next cycle
          // retries instead of skipping the date for 6h.
          writeFutureCache(dateStr, count);

          if (count > 0) {
            // Filter out any locally-deleted delivery IDs before writing to IDB
            let toSave = futureDeliveries;
            try {
              const storedDeleted = JSON.parse(sessionStorage.getItem('__deletedDeliveryIds') || '[]');
              if (storedDeleted.length > 0) {
                const deletedSet = new Set(storedDeleted);
                toSave = futureDeliveries.filter((d) => d?.id && !deletedSet.has(d.id));
              }
            } catch (_) {}
            if (toSave.length > 0) {
              await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, toSave).catch(() => {});
            }
            // Prune offline records for this date that the server no longer returns
            const incomingIds = new Set((futureDeliveries || []).map((d) => d?.id).filter(Boolean));
            const offlineForDate = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, dateStr).catch(() => []);
            const toDelete = (offlineForDate || []).filter((d) => d?.id && !d.id.startsWith('temp_') && !incomingIds.has(d.id));
            if (toDelete.length > 0) {
              await Promise.all(toDelete.map((d) => offlineDB.deleteRecord(offlineDB.STORES.DELIVERIES, d.id).catch(() => {})));
            }
            this.lastSyncTimes.deliveries = new Date().toISOString();
            console.log(`📅 [BackgroundSync] Future sync: ${count} deliveries for ${dateStr}`);
          }

          // Advance cursor toward +1
          cursorDate.setDate(cursorDate.getDate() - 1);
          try { localStorage.setItem(FUTURE_CURSOR_KEY, format(cursorDate, 'yyyy-MM-dd')); } catch (_) {}
        } catch (error) {
          if (error?.response?.status === 429 || error?.message?.includes('429')) {
            console.log('⏰ [BackgroundSync] Rate limited - stopping future-date sync');
          } else {
            console.warn(`⚠️ [BackgroundSync] Future sync failed for ${dateStr}:`, error?.message);
          }
          break;
        }
      }
    } finally {
      // If we reached +1, reset cursor to +7 for the next pass
      const offset = Math.round((cursorDate - today) / 86400000);
      if (offset < 1) {
        const reset = new Date(today);
        reset.setDate(reset.getDate() + 7);
        try { localStorage.setItem(FUTURE_CURSOR_KEY, format(reset, 'yyyy-MM-dd')); } catch (_) {}
      }
    }

    if (fetchedCount > 0 || skippedByTtl > 0) {
      console.log(`✅ [BackgroundSync] Future sync pass: ${fetchedCount} fetched, ${skippedByTtl} skipped by TTL`);
    }
    this.notifySubscribers({ type: 'future_deliveries_synced', count: fetchedCount });
  }

  /**
   * Execute sync tasks in priority order
   */
  async executeSyncTasks() {
    const tasks = [
      { name: 'deliveries', priority: this.config.priorities.deliveries, fn: () => this.syncHistoricalDeliveries() },
      { name: 'futureDeliveries', priority: this.config.priorities.deliveries + 0.5, fn: () => this.syncFutureDeliveries() },
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
   * Sync historical deliveries incrementally (city-scoped, runs day and night).
   * Daytime: 1 date per cycle (gentle trickle). Off-peak: 60 dates per cycle (fast batch).
   * Cursor persisted to IndexedDB keyed by the user's city assignment.
   */
  async syncHistoricalDeliveries() {
    if (this.currentCycleAPICalls >= this.config.maxAPICallsPerCycle) return;
    if (!this.currentUser) {
      console.log('⏭️ [BackgroundSync] Historical sync skipped — no current user set');
      return;
    }

    // Load latest stores from offline DB (cheap local read — ensures fresh city→store mapping)
    const stores = await offlineDB.getAll(offlineDB.STORES.STORES);
    if (!stores || stores.length === 0) {
      console.log('⏭️ [BackgroundSync] Historical sync skipped — no stores loaded');
      return;
    }

    // Rate: fast batch off-peak, gentle trickle during the day
    const isOffPeak = this.isOffPeakNow();
    const maxDatesPerCycle = isOffPeak
      ? (this.config.historicalMaxDatesPerCycleOffpeak || 60)
      : (this.config.historicalMaxDatesPerCycleDaytime || 1);
    const throttleMs = isOffPeak
      ? (this.config.throttleBetweenCallsMsOffpeak || 500)
      : (this.config.throttleBetweenCallsMsDaytime || 2000);

    // CRITICAL: NEVER sync today — active edits happen on today's deliveries.
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    // 365-day backfill window
    const cutoffDate = new Date(today);
    cutoffDate.setDate(cutoffDate.getDate() - 365);

    // Load persisted cursor (city-scoped) — resume from where we left off across restarts
    if (this.historicalSyncDateCursor == null) {
      const persisted = await loadHistoricalCursor(this.cityIdsHash);
      if (persisted && persisted >= cutoffDate && persisted <= yesterday) {
        this.historicalSyncDateCursor = persisted;
      } else {
        this.historicalSyncDateCursor = yesterday;
      }
    }

    let syncedCount = 0;
    let skippedDates = 0; // aggregate — per-date 'already synced' logs were flooding RemoteLogEntry (~200k rows/day)
    let cursor = new Date(this.historicalSyncDateCursor);
    cursor.setHours(0, 0, 0, 0);

    // Signal the UI that the historical delivery backfill is actively running
    // so the Offline DB indicator can reflect it (blue HardDrive icon).
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('historicalDeliverySyncProgress', { detail: { active: true, cursor: cursor.toISOString() } }));
    }

    try {
      while (cursor >= cutoffDate && syncedCount < maxDatesPerCycle) {
        if (this.isPaused || !this.isRunning) break;
        if (this.currentCycleAPICalls >= this.config.maxAPICallsPerCycle) break;

        const dateStr = format(cursor, 'yyyy-MM-dd');

        try {
          // GLOBAL RATE-LIMIT GATE inside the loop — break immediately if the shared
      // queue armed a backoff window mid-pass. This complements the per-request
      // 429 catch below and stops the cursor from queuing a burst of deferred
      // requests that all fire when the window clears.
      if (requestQueue.isRateLimited()) {
        console.log('⏰ [BackgroundSync] Historical sync paused — global rate-limit backoff');
        break;
      }

      const result = await syncHistoricalDateCityScoped(dateStr, this.currentUser, stores);
          this.currentCycleAPICalls++;

          if (result.synced) {
            console.log(`🔄 [BackgroundSync] Synced ${result.onlineCount} deliveries for ${dateStr} (was ${result.offlineCount}, pruned ${result.pruned})`);
            syncedCount++;
            this.lastSyncTimes.deliveries = new Date().toISOString();
          } else {
            // No per-date log — the 365-day backfill re-walks the whole year on
            // every device after the cursor resets, and one line per date
            // flooded RemoteLogEntry. One summary line per cycle instead.
            skippedDates++;
          }

          // Advance cursor + persist so restarts resume here
          cursor.setDate(cursor.getDate() - 1);
          this.historicalSyncDateCursor = new Date(cursor);
          await saveHistoricalCursor(this.historicalSyncDateCursor, this.cityIdsHash);

          if (throttleMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, throttleMs));
          }
        } catch (error) {
          if (error.response?.status === 429 || error.message?.includes('429')) {
            console.log('⏰ [BackgroundSync] Rate limited - stopping delivery sync');
          } else {
            console.warn(`⚠️ [BackgroundSync] Failed to sync deliveries for ${dateStr}:`, error.message);
          }
          break;
        }
      }
    } finally {
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('historicalDeliverySyncProgress', { detail: { active: false, count: syncedCount } }));
      }
      if (skippedDates > 0) {
        console.log(`✅ [BackgroundSync] Backfill check: ${syncedCount} synced, ${skippedDates} already up to date`);
      }
    }

    // Reached the 365-day floor → reset cursor to yesterday for re-validation pass
    const reachedFloor = this.historicalSyncDateCursor < cutoffDate;
    if (reachedFloor) {
      this.historicalSyncDateCursor = yesterday;
      await saveHistoricalCursor(yesterday, this.cityIdsHash);
      console.log('🔄 [BackgroundSync] Historical sync reached 365-day cutoff — resetting cursor to yesterday');
    }

    // Only purge expired deliveries when we've completed a full backfill pass
    // (cursor reached the 365-day floor). Running prune on every 3-minute
    // cycle is wasteful and causes unnecessary IDB churn.
    if (reachedFloor) {
      try {
        const pruneResult = await offlineDB.pruneOldDeliveries();
        if (pruneResult?.removed > 0) {
          console.log(`🧹 [BackgroundSync] Purged ${pruneResult.removed} deliveries older than 1 year`);
        }
      } catch (e) {
        console.warn('⚠️ [BackgroundSync] Purge failed:', e.message);
      }
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
        // silent skip — per-store 'already synced' lines are remote-log spam
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
      const cities = await queueEntityRequest(
        () => base44.entities.City.list(),
        'City.list(background)'
      );
      
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