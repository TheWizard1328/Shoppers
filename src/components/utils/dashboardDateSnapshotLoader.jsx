import { performBackgroundSync } from './offlineSync';

export async function loadDashboardDateSnapshot({
  offlineDB,
  selectedDate,
  selectedCityId,
  setStores,
  setAppUsers,
  setPatients,
  setDeliveries,
  setDataLoaded
}) {
  const [offlineDeliveriesForDate, offlinePatients, offlineStores, offlineAppUsers] = await Promise.all([
    offlineDB.getByDate(offlineDB.STORES.DELIVERIES, selectedDate).catch(() => []),
    offlineDB.getAll(offlineDB.STORES.PATIENTS).catch(() => []),
    offlineDB.getAll(offlineDB.STORES.STORES).catch(() => []),
    offlineDB.getAll(offlineDB.STORES.APP_USERS).catch(() => [])
  ]);

  const cityStoreIds = new Set(
    (offlineStores || []).filter((store) => store?.city_id === selectedCityId).map((store) => store.id)
  );

  const scopedDeliveries = cityStoreIds.size > 0
    ? (offlineDeliveriesForDate || []).filter((delivery) => cityStoreIds.has(delivery?.store_id))
    : (offlineDeliveriesForDate || []);

  setStores(Array.isArray(offlineStores) ? offlineStores : []);
  setAppUsers(Array.isArray(offlineAppUsers) ? offlineAppUsers : []);
  setPatients(Array.isArray(offlinePatients) ? offlinePatients : []);
  setDeliveries(Array.isArray(scopedDeliveries) ? scopedDeliveries : []);
  setDataLoaded(true);

  return {
    stores: offlineStores || [],
    appUsers: offlineAppUsers || [],
    patients: offlinePatients || [],
    deliveries: scopedDeliveries || []
  };
}

export function refreshDashboardDateSnapshotInBackground({ selectedDate, selectedCityId, stores }) {
  const cityStoreIds = (stores || [])
    .filter((store) => store?.city_id === selectedCityId)
    .map((store) => store.id);

  performBackgroundSync(selectedDate, cityStoreIds).catch(() => {});
}