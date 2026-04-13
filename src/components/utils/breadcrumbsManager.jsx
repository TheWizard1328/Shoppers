import { base44 } from '@/api/base44Client';
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

  let current = [];

  try {
    const liveRecords = await base44.entities.PendingBreadcrumbLive.filter({ driver_id: driverId });
    current = (liveRecords || [])
      .filter((record) => getEdmontonDateString((Array.isArray(record?.breadcrumbs) && record.breadcrumbs[0]?.[2]) || Date.now()) === selectedDateStr)
      .sort((a, b) => Number(a?.stop_order || 0) - Number(b?.stop_order || 0))
      .flatMap((record) => Array.isArray(record?.breadcrumbs) ? record.breadcrumbs : [])
      .map(([lat, lng, timestamp]) => ({ lat: Number(lat), lng: Number(lng), timestamp }))
      .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng));
  } catch (_) {}

  if (current.length === 0) {
    const pendingRecords = await listPendingBreadcrumbRecordsForDriver({ driverUserId: driverId, appUsers });
    current = pendingRecords
      .filter((record) => getEdmontonDateString((Array.isArray(record?.breadcrumbs) && record.breadcrumbs[0]?.[2]) || record?.timestamp || Date.now()) === selectedDateStr)
      .flatMap((record) => Array.isArray(record?.breadcrumbs) ? record.breadcrumbs : [])
      .map(([lat, lng, timestamp]) => ({ lat: Number(lat), lng: Number(lng), timestamp }))
      .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng));
  }

  return { historical, current };
}