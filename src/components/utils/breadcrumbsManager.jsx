import { offlineDB } from '@/components/utils/offlineDatabase';

export async function loadBreadcrumbsForDriver(driverId, selectedDateStr, appUsers = []) {
  if (!driverId || !selectedDateStr) {
    return { historical: [], current: [] };
  }

  const deliveriesForBreadcrumbs = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, selectedDateStr);
  const cachedAppUsers = (appUsers && appUsers.length > 0) ? appUsers : await offlineDB.getAll(offlineDB.STORES.APP_USERS);
  const driverAppUser = (cachedAppUsers || []).find((user) => user?.user_id === driverId);

  const historical = (deliveriesForBreadcrumbs || [])
    .filter((delivery) => delivery && delivery.driver_id === driverId && delivery.delivery_date === selectedDateStr && delivery.delivery_route_breadcrumbs)
    .map((delivery) => {
      try {
        const breadcrumbs = JSON.parse(delivery.delivery_route_breadcrumbs);
        return Array.isArray(breadcrumbs) && breadcrumbs.length ? { id: delivery.id, driver_id: delivery.driver_id, breadcrumbs } : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const currentRecord = driverAppUser?.id ? await offlineDB.getById(offlineDB.STORES.PENDING_BREADCRUMBS, driverAppUser.id) : null;
  const current = Array.isArray(currentRecord?.breadcrumbs)
    ? currentRecord.breadcrumbs.map(([lat, lng, timestamp]) => ({ lat, lng, timestamp })).filter((point) => typeof point.lat === 'number' && typeof point.lng === 'number')
    : [];

  return { historical, current };
}