import { format } from 'date-fns';

export default async function primeOfflineDashboardData({
  offlineDB,
  manifest,
  globalFilters,
  setDeliveries,
  setPatients,
  setAppUsers,
  setStores
}) {
  const today = new Date();
  const todayStr = format(today, 'yyyy-MM-dd');
  const initialDateStr = globalFilters.getSelectedDate() || todayStr;

  const deliveriesForDate = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, initialDateStr).catch(() => []);
  const patients = await offlineDB.getAll(offlineDB.STORES.PATIENTS).catch(() => []);
  const appUsers = Array.isArray(manifest.appUsers) ? manifest.appUsers : [];
  const stores = Array.isArray(manifest.stores) ? [...manifest.stores] : [];

  if (deliveriesForDate?.length) {
    setDeliveries(deliveriesForDate);
  }

  if (patients?.length) {
    await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, patients);
    setPatients(patients);
  }

  if (appUsers?.length) {
    await offlineDB.bulkSave(offlineDB.STORES.APP_USERS, appUsers);
    setAppUsers(appUsers);
  }

  if (stores?.length) {
    stores.sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity));
    await offlineDB.bulkSave(offlineDB.STORES.STORES, stores);
    setStores(stores);
  }

  if (!deliveriesForDate?.length || !patients?.length || !appUsers?.length) {
    window.dispatchEvent(new CustomEvent('triggerOfflineSyncNow'));
  }
}