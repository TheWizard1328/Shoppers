import { base44 } from '@/api/base44Client';
import { offlineDB } from '@/components/utils/offlineDatabase';
import { getEdmontonDateString, listPendingBreadcrumbRecordsForDriver } from '@/components/utils/pendingBreadcrumbsManager';

export async function loadBreadcrumbsForDriver(driverId, selectedDateStr, appUsers = []) {
  if (!driverId || !selectedDateStr) {
    return { historical: [], current: [] };
  }

  // CRITICAL: Try offline DB first, then fall back to API if needed
  let historical = [];
  
  try {
    // Load from offline DeliveryBreadcrumbs first
    const offlineBreadcrumbs = await offlineDB.getByCompoundIndex(
      offlineDB.STORES.DELIVERY_BREADCRUMBS,
      'date_driver',
      [selectedDateStr, driverId]
    );

    if (Array.isArray(offlineBreadcrumbs) && offlineBreadcrumbs.length > 0) {
      historical = offlineBreadcrumbs
        .filter(record => record?.encoded_polyline)
        .map(record => ({
          id: record.delivery_id,
          driver_id: record.driver_id,
          encoded_polyline: record.encoded_polyline,
          timestamps: record.timestamps
        }));
    }

    // Fall back to API if offline DB is empty
    if (historical.length === 0 && base44.entities?.DeliveryBreadcrumbs) {
      const apiBreadcrumbs = await base44.entities.DeliveryBreadcrumbs.filter({
        driver_id: driverId,
        delivery_date: selectedDateStr
      });

      if (Array.isArray(apiBreadcrumbs) && apiBreadcrumbs.length > 0) {
        // Save to offline DB for next time
        await offlineDB.bulkSave(offlineDB.STORES.DELIVERY_BREADCRUMBS, apiBreadcrumbs);
        
        historical = apiBreadcrumbs
          .filter(record => record?.encoded_polyline)
          .map(record => ({
            id: record.delivery_id,
            driver_id: record.driver_id,
            encoded_polyline: record.encoded_polyline,
            timestamps: record.timestamps
          }));
      }
    }
  } catch (e) {
    console.warn('⚠️ Failed to load breadcrumbs:', e.message);
  }

  const pendingRecords = await listPendingBreadcrumbRecordsForDriver({ driverUserId: driverId, appUsers });
  const current = pendingRecords
    .flatMap((record) => Array.isArray(record?.breadcrumbs) ? record.breadcrumbs : [])
    .map(([lat, lng, timestamp]) => ({ lat: Number(lat), lng: Number(lng), timestamp }))
    .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng))
    .filter((point) => getEdmontonDateString(point.timestamp || Date.now()) === selectedDateStr);

  return { historical, current };
}