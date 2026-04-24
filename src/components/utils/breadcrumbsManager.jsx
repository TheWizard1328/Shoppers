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
    const liveRecords = await base44.entities.PendingBreadcrumbLive.filter({ driver_id: driverId, delivery_date: selectedDateStr });
    current = (liveRecords || [])
      .sort((a, b) => String(a?.delivery_start_time || '').localeCompare(String(b?.delivery_start_time || '')))
      .flatMap((record) => Array.isArray(record?.breadcrumbs) ? record.breadcrumbs : [])
      .map(([lat, lng, timestamp]) => ({ lat: Number(lat), lng: Number(lng), timestamp }))
      .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng))
      .filter((point) => getEdmontonDateString(point.timestamp || Date.now()) === selectedDateStr);
  } catch (_) {}

  if (current.length === 0) {
    const pendingRecords = await listPendingBreadcrumbRecordsForDriver({ driverUserId: driverId, appUsers });
    current = pendingRecords
      .flatMap((record) => Array.isArray(record?.breadcrumbs) ? record.breadcrumbs : [])
      .map(([lat, lng, timestamp]) => ({ lat: Number(lat), lng: Number(lng), timestamp }))
      .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng))
      .filter((point) => getEdmontonDateString(point.timestamp || Date.now()) === selectedDateStr);
  }

  return { historical, current };
}