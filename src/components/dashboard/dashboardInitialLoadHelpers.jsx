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
  setForceRender,
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

  setForceRender((prev) => prev + 1);
  return { mountDeliveries, mountAppUsers };
}

export function mergeDeliveriesForDate({ deliveries, selectedDateStr, freshDeliveries }) {
  const otherDateDeliveries = (deliveries || []).filter((d) => d && d.delivery_date !== selectedDateStr);
  return [...otherDateDeliveries, ...(freshDeliveries || [])];
}

export function hasDeliveryDataForSelection({ deliveries, selectedDateStr, selectedDriverId }) {
  return (deliveries || []).some((d) => d && d.delivery_date === selectedDateStr);
}