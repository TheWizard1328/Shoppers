import { format, subDays, addDays } from 'date-fns';
import { offlineDB } from './offlineDatabase';
import { invalidate as invalidateEntityCache } from './dataManager';
import { entities } from './dataManagerEntities';
import { getSyncPaused } from './offlineSyncState';
import { notifySyncStatus } from './offlineSyncStatus';
import { userActivityMonitor } from './userActivityMonitor';

// Historical sync only runs once per session cycle (triggered by shouldRunMobileHistoricalSync gate)
export const HISTORICAL_SYNC_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours between full cycles

/**
 * Returns true if the current local device time is within the off-peak window:
 * after 8 PM (20:00) OR before 9 AM (09:00).
 * Historical syncs are restricted to off-peak hours to avoid 429 rate limits.
 */
export const isOffPeakHours = () => {
  const h = new Date().getHours();
  return h >= 20 || h < 9;
};

/**
 * Get the earliest historical date to sync back to: Jan 1 of the current year
 */
const getHistoricalStartDate = () => {
  const now = new Date();
  return new Date(now.getFullYear(), 0, 1); // Jan 1 of current year
};

export const createOfflineSyncHistoricalHelpers = ({
  HISTORICAL_PATIENT_STORE_BATCH_SIZE,
  HISTORICAL_SYNC_COOLDOWN_MS,
  DELIVERY_DATE_RANGE_DAYS,
  updateHistoricalSyncMeta,
  getHistoricalSyncMeta
}) => {
  const shouldRunMobileHistoricalSync = async (isDriverWithNoActiveStops = false) => {
    // GATE 1: Off-peak window (8 PM–9 AM) OR driver with no active stops (can run any time)
    if (!isOffPeakHours() && !isDriverWithNoActiveStops) return false;
    // GATE 2: Device must be idle — UNLESS driver is actively on the app with 0 active stops
    if (!isDriverWithNoActiveStops && !userActivityMonitor.isBackgroundSyncIdle()) return false;
    // GATE 3: Minimum interval between full cycles
    const metadata = await getHistoricalSyncMeta();
    const lastCompletedAt = metadata?.last_completed_at ? new Date(metadata.last_completed_at).getTime() : 0;
    return !lastCompletedAt || (Date.now() - lastCompletedAt) >= HISTORICAL_SYNC_INTERVAL_MS;
  };

  const getHistoricalDeliveryIndex = async () => {
    const metadata = await getHistoricalSyncMeta();
    return Number.isInteger(metadata?.delivery_cycle_index) ? metadata.delivery_cycle_index : 1;
  };

  const getHistoricalPatientStoreIndex = async () => {
    const metadata = await getHistoricalSyncMeta();
    return Number.isInteger(metadata?.patient_store_index) ? metadata.patient_store_index : 0;
  };

  const syncHistoricalPatientsByStore = async (storeIds = null) => {
    const allStores = await offlineDB.getAll(offlineDB.STORES.STORES);
    const targetStores = (allStores || []).filter((store) => store && (!storeIds?.length || storeIds.includes(store.id)));
    if (targetStores.length === 0) {
      return { success: true, completed: true, count: 0 };
    }

    // Resume from last store index so we continue progress across cycles
    const startStoreIndex = await getHistoricalPatientStoreIndex();
    let totalPatients = 0;
    let lastStoreSynced = null;
    let i = startStoreIndex;

    for (; i < targetStores.length; i++) {
      const targetStore = targetStores[i];
      if (!targetStore?.id) continue;

      // Pause check between stores
      if (getSyncPaused() || !userActivityMonitor.isBackgroundSyncIdle()) {
        await updateHistoricalSyncMeta({
          patient_store_index: i,
          patient_phase_complete: false,
          patient_last_store_id: targetStore.id,
          patient_last_synced_at: new Date().toISOString()
        });
        return { success: true, paused: true, count: totalPatients };
      }

      let offset = 0;
      while (true) {
        const batchPatients = await entities.Patient.filter({ store_id: targetStore.id }, '-updated_date', HISTORICAL_PATIENT_STORE_BATCH_SIZE, offset);
        if (!batchPatients || batchPatients.length === 0) break;

        await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, batchPatients);
        invalidateEntityCache('Patient');
        totalPatients += batchPatients.length;

        notifySyncStatus({ status: 'background_syncing', phase: 'patients', storeId: targetStore.id, count: totalPatients });

        if (batchPatients.length < HISTORICAL_PATIENT_STORE_BATCH_SIZE) break;
        offset += HISTORICAL_PATIENT_STORE_BATCH_SIZE;
        await new Promise((resolve) => setTimeout(resolve, HISTORICAL_SYNC_COOLDOWN_MS));
      }

      lastStoreSynced = targetStore.id;
      await new Promise((resolve) => setTimeout(resolve, HISTORICAL_SYNC_COOLDOWN_MS));
    }

    const completed = i >= targetStores.length;
    await updateHistoricalSyncMeta({
      patient_store_index: 0, // reset for next cycle
      patient_phase_complete: completed,
      patient_last_store_id: lastStoreSynced,
      patient_last_synced_at: new Date().toISOString()
    });

    return { success: true, completed, count: totalPatients };
  };

  /**
   * Get the next historical delivery date that needs syncing.
   * 
   * Strategy:
   * - Works backwards from yesterday toward Jan 1 of the current year
   * - Skips dates where offline count already matches online count (count-based validation)
   * - Once all historical dates are synced, resets cycle for next pass
   * 
   * Returns null if everything is synced (rely on WebSockets for live updates).
   */
  const getNextDeliveryDateToSync = async (storeIds = null) => {
    try {
      const today = new Date();
      const historicalStart = getHistoricalStartDate();
      const yesterday = subDays(today, 1);

      // Build sorted list: future dates first (today+1 to today+14, only if they have deliveries),
      // then historical dates from yesterday back to Jan 1
      const futureDates = [];
      for (let i = 1; i <= 14; i++) {
        const futureDate = format(addDays(today, i), 'yyyy-MM-dd');
        try {
          const onlineFilter = { delivery_date: futureDate };
          if (storeIds && storeIds.length > 0) onlineFilter.store_id = { $in: storeIds };
          const futureSample = await entities.Delivery.filter(onlineFilter, '-updated_date', 1);
          if (futureSample && futureSample.length > 0) {
            futureDates.push(futureDate);
          }
        } catch (_) { /* skip on error */ }
      }

      const allDates = [...futureDates];
      let cursor = new Date(yesterday);
      while (cursor >= historicalStart) {
        allDates.push(format(cursor, 'yyyy-MM-dd'));
        cursor = subDays(cursor, 1);
      }

      if (allDates.length === 0) return null;

      // Get the last synced date from metadata to resume from where we left off
      const meta = await getHistoricalSyncMeta();
      const lastSyncedDate = meta?.delivery_last_synced_date || null;

      // Find the starting index: resume after last synced date
      let startIndex = 0;
      if (lastSyncedDate) {
        const idx = allDates.indexOf(lastSyncedDate);
        // If found, start from the NEXT date; if not found (finished or reset), start over
        startIndex = idx >= 0 ? idx + 1 : 0;
      }

      // If we've gone through all dates, signal completion (reset for next cycle)
      if (startIndex >= allDates.length) {
        await updateHistoricalSyncMeta({
          delivery_last_synced_date: null, // reset to restart from yesterday next cycle
          last_completed_at: new Date().toISOString()
        });
        return null;
      }

      // Scan forward from startIndex — skip dates where offline count == online count
      for (let i = startIndex; i < allDates.length; i++) {
        const dateStr = allDates[i];

        try {
          // Count offline records for this date
          const offlineRecords = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, dateStr);
          const offlineCount = (offlineRecords || []).length;

          // Count online records for this date (lightweight: just a count via filter with limit 1 trick)
          // We use a small filter + check count to avoid pulling all data
          const onlineFilter = { delivery_date: dateStr };
          if (storeIds && storeIds.length > 0) {
            onlineFilter.store_id = { $in: storeIds };
          }
          const onlineSample = await entities.Delivery.filter(onlineFilter, '-updated_date', 5000);
          const onlineCount = (onlineSample || []).length;

          // If counts match, this date is fully synced — skip it
          if (onlineCount === offlineCount && offlineCount > 0) {
            console.log(`✅ [HistoricalSync] ${dateStr} already synced (${offlineCount} records match) — skipping`);
            await updateHistoricalSyncMeta({ delivery_last_synced_date: dateStr });
            continue;
          }

          // This date needs syncing — return it along with the online data we already fetched
          await updateHistoricalSyncMeta({
            delivery_last_synced_date: dateStr,
            delivery_last_synced_at: new Date().toISOString()
          });

          return { dateStr, onlineDeliveries: onlineSample || [] };
        } catch (err) {
          // On error for a specific date, skip it and continue
          console.warn(`⚠️ [HistoricalSync] Error checking ${dateStr}:`, err.message);
          await updateHistoricalSyncMeta({ delivery_last_synced_date: dateStr });
          continue;
        }
      }

      // All dates scanned and synced
      await updateHistoricalSyncMeta({
        delivery_last_synced_date: null,
        last_completed_at: new Date().toISOString()
      });
      return null;
    } catch (error) {
      console.warn('⚠️ [HistoricalSync] getNextDeliveryDateToSync error:', error.message);
      return null;
    }
  };

  return {
    shouldRunMobileHistoricalSync,
    getHistoricalDeliveryIndex,
    getHistoricalPatientStoreIndex,
    syncHistoricalPatientsByStore,
    getNextDeliveryDateToSync
  };
};