import { offlineDB } from '@/components/utils/offlineDatabase';
import { getEdmontonDateString, listPendingBreadcrumbRecordsForDriver } from '@/components/utils/pendingBreadcrumbsManager';

export async function loadBreadcrumbsForDriver(driverId, selectedDateStr, appUsers = []) {
  if (!driverId || !selectedDateStr) {
    return { historical: [], current: [] };
  }

  const deliveriesForBreadcrumbs = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, selectedDateStr);

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

  const pendingRecords = await listPendingBreadcrumbRecordsForDriver({ driverUserId: driverId, appUsers });
  const current = pendingRecords
    .filter((record) => getEdmontonDateString(record?.timestamp || Date.now()) === selectedDateStr)
    .flatMap((record) => Array.isArray(record?.breadcrumbs) ? record.breadcrumbs : [])
    .map(([lat, lng, timestamp]) => ({ lat, lng, timestamp }))
    .filter((point) => typeof point.lat === 'number' && typeof point.lng === 'number');

  return { historical, current };
}