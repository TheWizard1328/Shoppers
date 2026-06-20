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
      // CRITICAL: Upsert + scoped prune — never wipe the full date before writing.
      // replaceRecordsByIndex deletes ALL records for the date first, wiping other drivers' data
      // when we only fetched a city-scoped subset. Instead, only delete records that:
      //   1) belong to the same city scope (store_id in storeIds, or no storeIds filter = all)
      //   2) are absent from the server response (i.e. truly deleted on the server)
      {
        const incomingIds = new Set((selectedDateDeliveries || []).map(d => d?.id).filter(Boolean));
        const existingForDate = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, selectedDateStr);
        const staleIds = (existingForDate || [])
          .filter(d => {
            if (!d?.id || d.id.startsWith('temp_')) return false;
            if (incomingIds.has(d.id)) return false; // still on server — keep
            // Only prune if this record is within our fetch scope; leave other-city/other-driver records alone
            if (storeIds && storeIds.length > 0 && !storeIds.includes(d.store_id) && !d.is_cycling_marker) return false;
            return true;
          })
          .map(d => d.id);
        if (selectedDateDeliveries && selectedDateDeliveries.length > 0) {
          await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, selectedDateDeliveries);
        }
        if (staleIds.length > 0) {
          await Promise.all(staleIds.map(id => offlineDB.deleteRecord(offlineDB.STORES.DELIVERIES, id).catch(() => {})));
        }
      }
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

        // We already have the online deliveries from the count-check — reuse them.
        // CRITICAL: Upsert + scoped prune — never wipe the full date first.
        // replaceRecordsByIndex deletes all records for the date before writing, which wipes
        // other drivers' data when we only fetched a city-scoped subset.
        {
          const histIncomingIds = new Set((onlineDeliveries || []).map(d => d?.id).filter(Boolean));
          const histExisting = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, deliveryDateToSync);
          const histStaleIds = (histExisting || [])
            .filter(d => {
              if (!d?.id || d.id.startsWith('temp_')) return false;
              if (histIncomingIds.has(d.id)) return false;
              if (storeIds && storeIds.length > 0 && !storeIds.includes(d.store_id) && !d.is_cycling_marker) return false;
              return true;
            })
            .map(d => d.id);
          if (onlineDeliveries && onlineDeliveries.length > 0) {
            await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, onlineDeliveries);
          }
          if (histStaleIds.length > 0) {
            await Promise.all(histStaleIds.map(id => offlineDB.deleteRecord(offlineDB.STORES.DELIVERIES, id).catch(() => {})));
          }
        }
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