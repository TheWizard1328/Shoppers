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
export async function ensureTempLogsForDate({ selectedDateStr, currentUser }) {
  if (!selectedDateStr || !currentUser?.id) return;
  try {
    const all = await offlineDB.getAll(offlineDB.STORES.RX_TEMP_LOGS);
    const existing = (all || []).filter((l) => l?.delivery_date === selectedDateStr);
    if (existing.length > 0) return; // already have data — nothing to do

    // No data in IDB for this date — pull from server
    const { base44 } = await import('@/api/base44Client');
    const logs = await base44.entities.RxTempLogs.filter({ delivery_date: selectedDateStr });
    if (logs && logs.length > 0) {
      await offlineDB.bulkSave(offlineDB.STORES.RX_TEMP_LOGS, logs);
      // Notify LiveTempBadge and sidebar badges to re-read
      window.dispatchEvent(new CustomEvent('rxTempLogsUpdated', { detail: { delivery_date: selectedDateStr } }));
    }
  } catch (_) { /* non-critical */ }
}