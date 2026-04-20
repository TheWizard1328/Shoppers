export const createOfflineSyncBackgroundService = ({
  offlineDB,
  Delivery,
  syncPatientsByIds,
  invalidateEntityCache,
  shouldRunMobileHistoricalSync,
  getHistoricalSyncMeta,
  getNextDeliveryDateToSync,
  syncHistoricalPatientsByStore,
  updateHistoricalSyncMeta,
  getSyncInProgress,
  getSyncPaused,
  setSyncInProgress,
  getLastBackgroundSyncAt,
  setLastBackgroundSyncAt,
  notifySyncStatus,
  BATCH_COOLDOWN,
  DELIVERY_DATE_RANGE_DAYS,
  BACKGROUND_SYNC_MIN_INTERVAL_MS,
  format,
  subDays
}) => {
  const performBackgroundSync = async (selectedDateStr, storeIds = null) => {
    if (getSyncInProgress() || getSyncPaused()) {
      return { skipped: true };
    }

    const now = Date.now();
    if ((now - getLastBackgroundSyncAt()) < BACKGROUND_SYNC_MIN_INTERVAL_MS) {
      return { skipped: true, reason: 'background_cooldown' };
    }

    if (!(await shouldRunMobileHistoricalSync())) {
      return { skipped: true, reason: 'not_idle_or_not_due' };
    }

    if (!selectedDateStr) {
      return { skipped: true, reason: 'missing_selected_date' };
    }

    setSyncInProgress(true);
    setLastBackgroundSyncAt(now);
    notifySyncStatus({ status: 'background_syncing' });

    try {
      await new Promise((r) => setTimeout(r, BATCH_COOLDOWN));

      const selectedDateFilter = { delivery_date: selectedDateStr, ...(storeIds && storeIds.length > 0 ? { store_id: { $in: storeIds } } : {}) };
      const selectedDateDeliveries = await Delivery.filter(selectedDateFilter, '-updated_date', 5000);
      if (selectedDateDeliveries && selectedDateDeliveries.length > 0) {
        await offlineDB.replaceRecordsByIndex(offlineDB.STORES.DELIVERIES, 'delivery_date', selectedDateStr, selectedDateDeliveries);
        invalidateEntityCache('Delivery');

        const selectedDatePatientIds = Array.from(new Set(selectedDateDeliveries.filter((delivery) => delivery?.patient_id).map((delivery) => delivery.patient_id)));
        if (selectedDatePatientIds.length > 0) {
          await syncPatientsByIds(selectedDatePatientIds);
        }
      }

      const historicalMeta = await getHistoricalSyncMeta();
      const deliveryPhaseComplete = Number(historicalMeta?.delivery_cycle_index || 1) === 1 && historicalMeta?.delivery_last_synced_date === format(subDays(new Date(), DELIVERY_DATE_RANGE_DAYS), 'yyyy-MM-dd');

      if (!deliveryPhaseComplete) {
        const deliveryDateToSync = await getNextDeliveryDateToSync();
        if (!deliveryDateToSync || deliveryDateToSync === selectedDateStr) {
          notifySyncStatus({ status: 'complete', skippedHistorical: true });
          window.dispatchEvent(new CustomEvent('offlineSyncComplete'));
          return { success: true, skippedHistorical: true };
        }

        const deliveryFilter = { delivery_date: deliveryDateToSync };
        if (storeIds && storeIds.length > 0) {
          deliveryFilter.store_id = { $in: storeIds };
        }

        const deliveries = await Delivery.filter(deliveryFilter, '-updated_date', 500);
        if (deliveries.length > 0) {
          await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, deliveries);
          invalidateEntityCache('Delivery');
        }

        await offlineDB.updateSyncMetadata('Delivery', null, new Date().toISOString());
        const nextMeta = await getHistoricalSyncMeta();
        const completedDeliveries = nextMeta?.delivery_cycle_index > DELIVERY_DATE_RANGE_DAYS;
        if (completedDeliveries) {
          await updateHistoricalSyncMeta({ patient_phase_complete: false, patient_store_index: 0 });
        }

        notifySyncStatus({ status: 'complete', phase: 'deliveries', date: deliveryDateToSync });
        window.dispatchEvent(new CustomEvent('offlineSyncComplete'));
        return { success: true, phase: 'deliveries', date: deliveryDateToSync };
      }

      const patientSyncResult = await syncHistoricalPatientsByStore(storeIds);
      if (patientSyncResult?.completed) {
        await updateHistoricalSyncMeta({
          last_completed_at: new Date().toISOString(),
          delivery_cycle_index: 1,
          patient_phase_complete: false,
          patient_store_index: 0
        });
      }

      notifySyncStatus({ status: 'complete', phase: 'patients' });
      window.dispatchEvent(new CustomEvent('offlineSyncComplete'));
      return { success: true, phase: 'patients', ...patientSyncResult };
    } catch (error) {
      notifySyncStatus({ status: 'error', error: error.message });
      return { error: error.message };
    } finally {
      setSyncInProgress(false);
    }
  };

  return { performBackgroundSync };
};