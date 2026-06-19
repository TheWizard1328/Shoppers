// Returns true if current local time is within the off-peak window (8 PM–9 AM)
const isOffPeakHours = () => {
  const h = new Date().getHours();
  return h >= 19 || h < 10;
};


export const createOfflineSyncBackgroundService = ({
  offlineDB,
  Delivery,
  RxTempLogs,
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

    // Determine if this is a driver with no active stops for today (can run historical sync any time)
    const isDriverWithNoActiveStops = await (async () => {
      try {
        const cache = sessionStorage.getItem('effectiveUserCache');
        if (!cache) return false;
        const parsed = JSON.parse(cache);
        const roles = parsed?.appUser?.app_roles || parsed?.user?.app_roles || [];
        if (!roles.includes('driver')) return false;
        const userId = parsed?.user?.id || parsed?.user?.user_id;
        if (!userId || !selectedDateStr) return false;
        // Check offline DB for active stops today for this driver
        const todayDeliveries = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, selectedDateStr);
        const activeStatuses = new Set(['pending', 'in_transit', 'en_route']);
        const activeStops = (todayDeliveries || []).filter(
          (d) => d && d.driver_id === userId && activeStatuses.has(d.status)
        );
        return activeStops.length === 0;
      } catch (_) {
        return false;
      }
    })();

    if (!(await shouldRunMobileHistoricalSync(isDriverWithNoActiveStops))) {
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

      // Sync today's RxTempLogs for all drivers (current date — always, part of priority)
      try {
        if (RxTempLogs) {
          const todayTempLogs = await RxTempLogs.filter({ delivery_date: selectedDateStr });
          if (todayTempLogs && todayTempLogs.length > 0) {
            await offlineDB.bulkSave(offlineDB.STORES.RX_TEMP_LOGS, todayTempLogs);
          }
        }
      } catch (_) {}

      // Delivery history sync is allowed any time (incremental, low-cost per cycle).
      // Patient store-by-store sync is restricted to off-peak hours to avoid rate limits.

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

        // Also sync RxTempLogs for this historical date (silent — no status notification)
        try {
          if (RxTempLogs) {
            const historicalTempLogs = await RxTempLogs.filter({ delivery_date: deliveryDateToSync });
            if (historicalTempLogs && historicalTempLogs.length > 0) {
              await offlineDB.bulkSave(offlineDB.STORES.RX_TEMP_LOGS, historicalTempLogs);
            }
          }
        } catch (_) {}

        // CRITICAL: Do NOT fire offlineSyncComplete for historical background phases —
        // Layout's handler calls invalidate+getData which overwrites the user's active UI state.
        return { success: true, phase: 'deliveries', date: deliveryDateToSync };
      }

      // All historical delivery dates are synced — proceed to patient phase (off-peak only)
      if (!isOffPeakHours() && !isDriverWithNoActiveStops) {
        notifySyncStatus({ status: 'complete', skippedPatients: true, reason: 'outside_offpeak_window' });
        return { success: true, skippedPatients: true };
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