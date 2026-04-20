import { format, subDays } from 'date-fns';
import { offlineDB } from './offlineDatabase';
import { invalidate as invalidateEntityCache } from './dataManager';
import { Patient } from './dataManagerEntities';
import { getSyncPaused } from './offlineSyncState';
import { notifySyncStatus } from './offlineSyncStatus';
import { userActivityMonitor } from './userActivityMonitor';
import { isMobileDevice } from './deviceUtils';

export const MOBILE_HISTORICAL_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

export const createOfflineSyncHistoricalHelpers = ({
  HISTORICAL_PATIENT_STORE_BATCH_SIZE,
  HISTORICAL_SYNC_COOLDOWN_MS,
  DELIVERY_DATE_RANGE_DAYS,
  updateHistoricalSyncMeta,
  getHistoricalSyncMeta
}) => {
  const shouldRunMobileHistoricalSync = async () => {
    if (!isMobileDevice()) return false;
    if (!userActivityMonitor.isBackgroundSyncIdle()) return false;
    const metadata = await getHistoricalSyncMeta();
    const lastCompletedAt = metadata?.last_completed_at ? new Date(metadata.last_completed_at).getTime() : 0;
    return !lastCompletedAt || (Date.now() - lastCompletedAt) >= MOBILE_HISTORICAL_SYNC_INTERVAL_MS;
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

      const batchPatients = await Patient.filter({ store_id: targetStore.id }, '-updated_date', HISTORICAL_PATIENT_STORE_BATCH_SIZE, offset);
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

  const getNextDeliveryDateToSync = async () => {
    try {
      const cycleIndex = await getHistoricalDeliveryIndex();
      const today = new Date();
      const targetDate = new Date(today);
      targetDate.setDate(targetDate.getDate() - cycleIndex);
      const dateStr = format(targetDate, 'yyyy-MM-dd');
      const nextIndex = cycleIndex >= DELIVERY_DATE_RANGE_DAYS ? 1 : cycleIndex + 1;

      await updateHistoricalSyncMeta({
        delivery_cycle_index: nextIndex,
        delivery_last_synced_date: dateStr,
        delivery_last_synced_at: new Date().toISOString(),
        patient_phase_complete: cycleIndex >= DELIVERY_DATE_RANGE_DAYS ? false : undefined,
        patient_store_index: cycleIndex >= DELIVERY_DATE_RANGE_DAYS ? 0 : undefined
      });

      return dateStr;
    } catch (error) {
      return format(subDays(new Date(), 1), 'yyyy-MM-dd');
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