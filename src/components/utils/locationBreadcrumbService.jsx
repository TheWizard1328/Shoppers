import { base44 } from '@/api/base44Client';
import { getLocalDateString } from './localTimeHelper';

// Per-leg online sync throttle: track last online sync time keyed by offlineKey
const _lastOnlineSyncTime = {};
const ONLINE_SYNC_INTERVAL_MS = 15000; // 15 seconds

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

  // MAX DISTANCE FILTER: 250m max between consecutive breadcrumb points
  // At 110 km/h over 5 seconds, max legitimate travel is ~153m. 250m gives a safe buffer.
  // Exception: if > 5 minutes have passed since the last point, always accept (heartbeat).
  const MAX_BREADCRUMB_DISTANCE_M = 250;
  const MAX_BREADCRUMB_STALENESS_MS = 5 * 60 * 1000; // 5 minutes

  if (existingPoints.length > 0) {
    const lastPoint = existingPoints[existingPoints.length - 1];
    const lastLat = lastPoint[0];
    const lastLon = lastPoint[1];
    const lastTs = lastPoint[2] || 0;
    const timeSinceLast = timestamp - lastTs;

    // Only apply distance filter if we're within the staleness window
    if (timeSinceLast < MAX_BREADCRUMB_STALENESS_MS) {
      const R = 6371000;
      const dLat = (latitude - lastLat) * Math.PI / 180;
      const dLon = (longitude - lastLon) * Math.PI / 180;
      const a = Math.sin(dLat / 2) ** 2 + Math.cos(lastLat * Math.PI / 180) * Math.cos(latitude * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
      const distanceM = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

      if (distanceM > MAX_BREADCRUMB_DISTANCE_M) {
        console.warn(`🍞 [Breadcrumbs] REJECTED point — GPS jump detected: ${distanceM.toFixed(0)}m > ${MAX_BREADCRUMB_DISTANCE_M}m threshold`);
        return null;
      }
    } else {
      console.log(`🍞 [Breadcrumbs] Heartbeat breadcrumb accepted — ${Math.round(timeSinceLast / 1000)}s since last point`);
    }
  }

  const allPoints = existingPoints.length > 0
    ? [...existingPoints, breadcrumbPoint]
    : [breadcrumbPoint];

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

  // Sync to backend DeliveryBreadcrumbs entity — throttled to once every 15 seconds per leg
  const now = Date.now();
  const lastSync = _lastOnlineSyncTime[offlineKey] || 0;
  if (now - lastSync >= ONLINE_SYNC_INTERVAL_MS) {
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

      _lastOnlineSyncTime[offlineKey] = now;
      console.log(`☁️ [Breadcrumbs] Online sync for leg ${offlineKey} (${allPoints.length} points)`);
    } catch (error) {
      const isRateLimited = error?.response?.status === 429 || error?.status === 429 || error?.message?.includes('429') || error?.message?.toLowerCase?.().includes('rate limit');
      if (!isRateLimited) {
        console.warn(`⚠️ [LocationTracker] DeliveryBreadcrumbs write skipped:`, error.message);
      } else {
        console.warn(`⚠️ [LocationTracker] DeliveryBreadcrumbs rate-limited, skipping this point`);
      }
    }
  } else {
    console.log(`🍞 [Breadcrumbs] Offline-only save for leg ${offlineKey} — online sync in ${Math.ceil((ONLINE_SYNC_INTERVAL_MS - (now - lastSync)) / 1000)}s`);
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