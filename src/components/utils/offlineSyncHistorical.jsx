import { format, subDays } from 'date-fns';
import { offlineDB } from './offlineDatabase';
import { invalidate as invalidateEntityCache } from './dataManager';
import { entities } from './dataManagerEntities';
import { getSyncPaused } from './offlineSyncState';
import { notifySyncStatus } from './offlineSyncStatus';
import { userActivityMonitor } from './userActivityMonitor';

// Historical sync only runs once per session cycle (triggered by shouldRunMobileHistoricalSync gate)
export const HISTORICAL_SYNC_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours between full cycles

/**
 * Returns true if the current local device time is at or after 8 PM (20:00)
 * Historical syncs are restricted to off-peak hours to avoid 429 rate limits.
 */
const isAfterEightPM = () => {
  const now = new Date();
  return now.getHours() >= 20;
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
  const shouldRunMobileHistoricalSync = async () => {
    // GATE 1: Only run after 8 PM local device time
    if (!isAfterEightPM()) return false;
    // GATE 2: Device must be idle (not actively using the app)
    if (!userActivityMonitor.isBackgroundSyncIdle()) return false;
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

    const storeIndex = await getHistoricalPatientStoreIndex();
    const targetStore = targetStores[storeIndex] || targetStores[0];
    if (!targetStore?.id) {
      return { success: true, completed: true, count: 0 };
    }

    let totalPatients = 0;
    let offset = 0;
    while (true) {
      if (getSyncPaused() || !userActivityMonitor.isBackgroundSyncIdle()) {
        return { success: true, paused: true, count: totalPatients };
      }

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

    const nextStoreIndex = storeIndex + 1;
    const completed = nextStoreIndex >= targetStores.length;
    await updateHistoricalSyncMeta({
      patient_store_index: completed ? 0 : nextStoreIndex,
      patient_phase_complete: completed,
      patient_last_store_id: targetStore.id,
      patient_last_synced_at: new Date().toISOString()
    });

    return { success: true, completed, count: totalPatients, storeId: targetStore.id };
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

      // Build sorted list of dates from yesterday back to Jan 1
      const allDates = [];
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