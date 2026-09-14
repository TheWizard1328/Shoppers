import { offlineDB } from '@/components/utils/offlineDatabase';

export async function loadDashboardOfflineDateData({
  selectedDateStr,
  deliveries,
  appUsers,
  updateDeliveriesLocally,
  currentUser,
  drivers,
  stores,
  selectedDate,
  driverLocationPoller,
  showAllDriverMarkers,
}) {
  const mountDeliveries = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, selectedDateStr);
  const mountAppUsers = ((await offlineDB.getAll(offlineDB.STORES.APP_USERS)) || []).filter((u) => u?.user_id && u.user_id !== 'undefined');

  if (updateDeliveriesLocally) {
    const otherDateDeliveries = (deliveries || []).filter((d) => d && d.delivery_date !== selectedDateStr);
    updateDeliveriesLocally([...otherDateDeliveries, ...(mountDeliveries || [])], true);
  }

  const appUsersToProcess = mountAppUsers.length > 0 ? mountAppUsers : appUsers;
  if (appUsersToProcess && appUsersToProcess.length > 0) {
    driverLocationPoller.processLocationData(currentUser, mountDeliveries || [], drivers, stores, appUsersToProcess, selectedDate, true, 'Dashboard', showAllDriverMarkers);
    window.dispatchEvent(new CustomEvent('driverLocationsUpdated', { detail: { appUsers: appUsersToProcess, forceAll: true } }));
  }

  return { mountDeliveries, mountAppUsers };
}

export function mergeDeliveriesForDate({ deliveries, selectedDateStr, freshDeliveries }) {
  const otherDateDeliveries = (deliveries || []).filter((d) => d && d.delivery_date !== selectedDateStr);
  return [...otherDateDeliveries, ...(freshDeliveries || [])];
}

export function hasDeliveryDataForSelection({ deliveries, selectedDateStr, selectedDriverId }) {
  return (deliveries || []).some((d) => d && d.delivery_date === selectedDateStr);
}

/**
 * After dashboard loads, check if RxTempLogs exist in the offline DB for the
 * selected date. If not, fetch them from the server and persist to IDB so the
 * LiveTempBadge and sidebar dispatcher badges have data to display.
 */
// Dates the server CONFIRMED have zero RxTempLogs this session. Without this,
// "no logs in IDB" is indistinguishable from "never fetched", so the dashboard
// re-fired this server fetch on every effect run — for every quiet date, all
// day long (429 storm amplifier, Sep 10 2026). New logs for a verified-empty
// date still arrive via WebSocket → IDB → rxTempLogsUpdated; a reload re-verifies
// each date once. Failed fetches are NOT marked (retry next run).
const _tempLogDatesVerifiedEmpty = new Set();

export async function ensureTempLogsForDate({ selectedDateStr, currentUser }) {
  if (!selectedDateStr || !currentUser?.id) return;
  try {
    const all = await offlineDB.getAll(offlineDB.STORES.RX_TEMP_LOGS);
    const existing = (all || []).filter((l) => l?.delivery_date === selectedDateStr);
    if (existing.length > 0) {
      _tempLogDatesVerifiedEmpty.delete(selectedDateStr); // logs exist again
      return; // already have data — nothing to do
    }
    if (_tempLogDatesVerifiedEmpty.has(selectedDateStr)) return; // server already confirmed empty

    // No data in IDB for this date — pull from server via shared cache
    const { getRxTempLogsForDate } = await import('@/components/utils/rxTempLogsCache');
    const logs = await getRxTempLogsForDate(selectedDateStr);
    if (logs && logs.length > 0) {
      await offlineDB.bulkSave(offlineDB.STORES.RX_TEMP_LOGS, logs);
      // Notify LiveTempBadge and sidebar badges to re-read
      window.dispatchEvent(new CustomEvent('rxTempLogsUpdated', { detail: { delivery_date: selectedDateStr } }));
    } else {
      // Server confirms zero logs for this date — stop refetching until reload
      _tempLogDatesVerifiedEmpty.add(selectedDateStr);
    }
  } catch (_) { /* non-critical — not marked verified, retries next run */ }
}