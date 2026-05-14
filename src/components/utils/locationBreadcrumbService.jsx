import { base44 } from '@/api/base44Client';
import { getLocalDateString } from './localTimeHelper';

// Polyline encoding (Google format) for compact storage
function encodePolylineValue(value) {
  let v = Math.round(value * 1e5);
  v = v < 0 ? ~(v << 1) : v << 1;
  let result = '';
  while (v >= 0x20) {
    result += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
    v >>= 5;
  }
  result += String.fromCharCode(v + 63);
  return result;
}

function encodePolyline(points) {
  let prevLat = 0, prevLon = 0, result = '';
  for (const point of points) {
    result += encodePolylineValue(point[0] - prevLat);
    result += encodePolylineValue(point[1] - prevLon);
    prevLat = point[0];
    prevLon = point[1];
  }
  return result;
}

function decodePolyline(encoded) {
  if (!encoded || typeof encoded !== 'string') return [];
  let index = 0, lat = 0, lng = 0;
  const coordinates = [];
  while (index < encoded.length) {
    let shift = 0, result = 0, byte;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    coordinates.push([lat / 1e5, lng / 1e5]);
  }
  return coordinates;
}

export const collectBreadcrumbForTracker = async ({
  driverStatus,
  appUserId,
  currentUser,
  currentDeliveryDate,
  latitude,
  longitude,
  timestamp
}) => {
  if (driverStatus !== 'on_duty' || !appUserId || !currentUser?.id) {
    return null;
  }

  const { offlineDB } = await import('./offlineDatabase');

  const deliveryDate = currentDeliveryDate || getLocalDateString();
  const deliveries = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, deliveryDate);
  const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
  const driverDeliveries = (deliveries || []).filter((delivery) => delivery?.driver_id === currentUser.id);
  const activeDelivery = driverDeliveries.find((delivery) => delivery?.isNextDelivery === true)
    || driverDeliveries
      .filter((delivery) => !finishedStatuses.includes(delivery?.status) && delivery?.status !== 'pending')
      .sort((a, b) => Number(a?.stop_order || 0) - Number(b?.stop_order || 0))[0];

  if (!activeDelivery?.id) {
    return null;
  }

  const stopOrder = Number(activeDelivery?.stop_order || activeDelivery?.display_stop_order || 0);
  // Use a stable local key for the offline record
  const offlineKey = `${currentUser.id}__stop_${stopOrder}__${deliveryDate}`;

  // Load existing offline DeliveryBreadcrumbs record for this leg
  const existingOfflineRecord = await offlineDB.getById(offlineDB.STORES.DELIVERY_BREADCRUMBS, offlineKey);
  const breadcrumbPoint = [latitude, longitude, timestamp];

  // Reconstruct existing points from encoded polyline + timestamps
  let existingPoints = [];
  if (existingOfflineRecord?.encoded_polyline && existingOfflineRecord?.timestamps) {
    const coords = decodePolyline(existingOfflineRecord.encoded_polyline);
    const tsArr = existingOfflineRecord.timestamps.split(',').map(Number);
    existingPoints = coords.map((coord, i) => [coord[0], coord[1], tsArr[i] || 0]);
  }

  // On first point for this stop, seed with origin from previous finished stop
  let initialPoints = [];
  if (existingPoints.length === 0) {
    const previousFinishedStop = driverDeliveries
      .filter((d) => finishedStatuses.includes(d?.status) && (d?.stop_order || 0) < stopOrder)
      .sort((a, b) => Number(b?.stop_order || 0) - Number(a?.stop_order || 0))[0];

    if (previousFinishedStop) {
      let prevLat = null;
      let prevLon = null;

      if (previousFinishedStop.patient_id) {
        const patients = await offlineDB.getAll(offlineDB.STORES.PATIENTS);
        const prevPatient = (patients || []).find((p) => p?.id === previousFinishedStop.patient_id);
        prevLat = prevPatient?.latitude;
        prevLon = prevPatient?.longitude;
      } else if (previousFinishedStop.store_id) {
        const stores = await offlineDB.getAll(offlineDB.STORES.STORES);
        const prevStore = (stores || []).find((s) => s?.id === previousFinishedStop.store_id);
        prevLat = prevStore?.latitude;
        prevLon = prevStore?.longitude;
      }

      if (prevLat && prevLon) {
        const originTimestamp = previousFinishedStop.actual_delivery_time
          ? new Date(previousFinishedStop.actual_delivery_time).getTime()
          : timestamp - 60000;
        initialPoints.push([prevLat, prevLon, originTimestamp]);
      }
    }
  }

  const allPoints = existingPoints.length > 0
    ? [...existingPoints, breadcrumbPoint]
    : [...initialPoints, breadcrumbPoint];

  const encodedPolyline = encodePolyline(allPoints);
  const timestamps = allPoints.map((p) => p[2] || 0).join(',');

  // Save to offline DeliveryBreadcrumbs store
  const offlineRecord = {
    id: offlineKey,
    driver_id: currentUser.id,
    delivery_id: activeDelivery.id,
    delivery_date: deliveryDate,
    stop_order: stopOrder,
    encoded_polyline: encodedPolyline,
    timestamps,
    transport_mode: activeDelivery.transport_mode || 'driving',
    point_count: allPoints.length,
  };
  await offlineDB.save(offlineDB.STORES.DELIVERY_BREADCRUMBS, offlineRecord);

  // Sync to backend DeliveryBreadcrumbs entity
  try {
    const existingRecords = await base44.entities.DeliveryBreadcrumbs.filter({
      driver_id: currentUser.id,
      delivery_date: deliveryDate,
      stop_order: stopOrder,
    });
    const existingBackendRecord = existingRecords?.[0] || null;

    const breadcrumbPayload = {
      driver_id: currentUser.id,
      delivery_date: deliveryDate,
      stop_order: stopOrder,
      delivery_id: activeDelivery.id,
      encoded_polyline: encodedPolyline,
      timestamps,
      transport_mode: activeDelivery.transport_mode || 'driving',
      point_count: allPoints.length,
    };

    if (existingBackendRecord?.id) {
      await base44.entities.DeliveryBreadcrumbs.update(existingBackendRecord.id, breadcrumbPayload);
    } else {
      await base44.entities.DeliveryBreadcrumbs.create(breadcrumbPayload);
    }
  } catch (error) {
    const isRateLimited = error?.response?.status === 429 || error?.status === 429 || error?.message?.includes('429') || error?.message?.toLowerCase?.().includes('rate limit');
    if (!isRateLimited) {
      console.warn(`⚠️ [LocationTracker] DeliveryBreadcrumbs write skipped:`, error.message);
    } else {
      console.warn(`⚠️ [LocationTracker] DeliveryBreadcrumbs rate-limited, skipping this point`);
    }
  }

  window.dispatchEvent(new CustomEvent('breadcrumbCollected', {
    detail: {
      driverId: currentUser?.id,
      appUserId,
      deliveryId: activeDelivery.id,
      deliveryDate,
      stopOrder,
      point: { lat: latitude, lng: longitude, timestamp }
    }
  }));

  return { pendingKey: offlineKey, activeDelivery, stopOrder };
};