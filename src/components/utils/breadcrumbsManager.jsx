import { base44 } from '@/api/base44Client';
import { offlineDB } from '@/components/utils/offlineDatabase';

export async function loadBreadcrumbsForDriver(driverId, selectedDateStr, appUsers = []) {
  if (!driverId || !selectedDateStr) {
    return { historical: [], current: [] };
  }

  const deliveriesForBreadcrumbs = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, selectedDateStr);
  const driverAppUser = (appUsers || []).find((user) => user?.user_id === driverId) || (await base44.entities.AppUser.filter({ user_id: driverId }))[0];

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