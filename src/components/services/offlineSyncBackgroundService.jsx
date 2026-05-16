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

      // PRIORITY: Always sync the current/selected date regardless of time of day
      const selectedDateFilter = { delivery_date: selectedDateStr, ...(storeIds && storeIds.length > 0 ? { store_id: { $in: storeIds } } : {}) };
      const selectedDateDeliveries = await Delivery.filter(selectedDateFilter, '-updated_date', 5000);
      // CRITICAL: Always replace the offline DB for this date scope, even when server returns 0 records.
      // An empty result IS authoritative — it means all local records for this date should be removed.
      await offlineDB.replaceRecordsByIndex(offlineDB.STORES.DELIVERIES, 'delivery_date', selectedDateStr, selectedDateDeliveries || []);
      invalidateEntityCache('Delivery');

      // CRITICAL: Sync patients for selected date BEFORE marking deliveries as complete
      if (selectedDateDeliveries && selectedDateDeliveries.length > 0) {
        const selectedDatePatientIds = Array.from(new Set(selectedDateDeliveries.filter((delivery) => delivery?.patient_id).map((delivery) => delivery.patient_id)));
        if (selectedDatePatientIds.length > 0) {
          await syncPatientsByIds(selectedDatePatientIds);
          invalidateEntityCache('Patient');
        }
      }

      // GATE: Historical sync (deliveries prior to selected date + patient store sync)
      // Only runs after 8 PM local device time to avoid rate limits during peak hours
      const currentHour = new Date().getHours();
      if (currentHour < 20) {
        notifySyncStatus({ status: 'complete', skippedHistorical: true, reason: 'before_8pm' });
        return { success: true, skippedHistorical: true, reason: 'before_8pm' };
      }

      // Get the next historical date that needs syncing (count-based, backwards from yesterday)
      // Returns { dateStr, onlineDeliveries } or null if everything is synced
      const nextToSync = await getNextDeliveryDateToSync(storeIds);

      if (nextToSync) {
        const { dateStr: deliveryDateToSync, onlineDeliveries } = nextToSync;

        // We already have the online deliveries from the count-check — reuse them
        // CRITICAL: Always replace local records for this historical date — empty = 0 stops on server
        await offlineDB.replaceRecordsByIndex(offlineDB.STORES.DELIVERIES, 'delivery_date', deliveryDateToSync, onlineDeliveries || []);
        invalidateEntityCache('Delivery');

        notifySyncStatus({ status: 'complete', phase: 'deliveries', date: deliveryDateToSync, count: (onlineDeliveries || []).length });
        // CRITICAL: Do NOT fire offlineSyncComplete for historical background phases —
        // Layout's handler calls invalidate+getData which overwrites the user's active UI state.
        return { success: true, phase: 'deliveries', date: deliveryDateToSync };
      }

      // All historical delivery dates are synced — proceed to patient phase

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
      // CRITICAL: Do NOT fire offlineSyncComplete for historical background phases —
      // Layout's handler calls invalidate+getData which overwrites the user's active UI state.
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