import { offlineDB } from '@/components/utils/offlineDatabase';
import { base44 } from '@/api/base44Client';

const FINISHED_STATUSES = new Set(['completed', 'failed', 'cancelled', 'returned']);

// Polyline encoding (Google format)
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

const parseTimestamp = (value) => {
  if (!value) return Date.now();
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? ts : Date.now();
};

const getStopCoords = async ({ delivery, patients, stores }) => {
  if (delivery?.patient_id) {
    const patient = (patients || []).find((p) => p?.id === delivery.patient_id);
    if (Number.isFinite(Number(patient?.latitude)) && Number.isFinite(Number(patient?.longitude))) {
      return [Number(patient.latitude), Number(patient.longitude)];
    }
  }
  const store = (stores || []).find((s) => s?.id === delivery?.store_id);
  if (Number.isFinite(Number(store?.latitude)) && Number.isFinite(Number(store?.longitude))) {
    return [Number(store.latitude), Number(store.longitude)];
  }
  return null;
};

async function appendPointToDeliveryBreadcrumbs({ driverId, delivery, deliveryDate, stopOrder, boundaryPoint }) {
  const offlineKey = `${driverId}__stop_${stopOrder}__${deliveryDate}`;
  const existingOfflineRecord = await offlineDB.getById(offlineDB.STORES.DELIVERY_BREADCRUMBS, offlineKey);

  let existingPoints = [];
  if (existingOfflineRecord?.encoded_polyline && existingOfflineRecord?.timestamps) {
    const coords = decodePolyline(existingOfflineRecord.encoded_polyline);
    const tsArr = existingOfflineRecord.timestamps.split(',').map(Number);
    existingPoints = coords.map((coord, i) => [coord[0], coord[1], tsArr[i] || 0]);
  }

  const allPoints = [...existingPoints, boundaryPoint];
  const encodedPolyline = encodePolyline(allPoints);
  const timestamps = allPoints.map((p) => p[2] || 0).join(',');

  const offlineRecord = {
    id: offlineKey,
    driver_id: driverId,
    delivery_id: delivery.id,
    delivery_date: deliveryDate,
    stop_order: stopOrder,
    encoded_polyline: encodedPolyline,
    timestamps,
    transport_mode: delivery.transport_mode || 'driving',
    point_count: allPoints.length,
  };
  await offlineDB.save(offlineDB.STORES.DELIVERY_BREADCRUMBS, offlineRecord);

  // Sync to backend
  try {
    const existingRecords = await base44.entities.DeliveryBreadcrumbs.filter({
      driver_id: driverId,
      delivery_date: deliveryDate,
      stop_order: stopOrder,
    }).catch(() => []);
    const existingBackendRecord = existingRecords?.[0] || null;

    const payload = {
      driver_id: driverId,
      delivery_date: deliveryDate,
      stop_order: stopOrder,
      delivery_id: delivery.id,
      encoded_polyline: encodedPolyline,
      timestamps,
      transport_mode: delivery.transport_mode || 'driving',
      point_count: allPoints.length,
    };

    if (existingBackendRecord?.id) {
      await base44.entities.DeliveryBreadcrumbs.update(existingBackendRecord.id, payload);
    } else {
      await base44.entities.DeliveryBreadcrumbs.create(payload);
    }
  } catch (_) {}

  return offlineRecord;
}

export async function appendBoundaryBreadcrumbPoints({
  driverId,
  delivery,
  allDeliveries,
  patients,
  stores,
  appUsers,
  terminalStatus,
  completedAt
}) {
  if (!driverId || !delivery?.id || !delivery?.delivery_date) return;
  if (!FINISHED_STATUSES.has(terminalStatus)) return;

  const currentStopCoords = await getStopCoords({ delivery, patients, stores });
  if (!currentStopCoords) return;

  const boundaryTimestamp = parseTimestamp(completedAt);
  const boundaryPoint = [currentStopCoords[0], currentStopCoords[1], boundaryTimestamp];

  const currentStopOrder = Number(delivery?.stop_order || 0);
  const deliveryDate = delivery.delivery_date;

  // Append boundary point to the current stop's breadcrumbs
  await appendPointToDeliveryBreadcrumbs({
    driverId,
    delivery,
    deliveryDate,
    stopOrder: currentStopOrder,
    boundaryPoint
  });

  // Seed the next active stop's breadcrumbs with this boundary point as origin
  const sameRouteDeliveries = (allDeliveries || [])
    .filter((item) => item?.driver_id === driverId && item?.delivery_date === deliveryDate);

  const nextDelivery = sameRouteDeliveries
    .filter((item) => item && item.id !== delivery.id && !FINISHED_STATUSES.has(item.status) && item.status !== 'pending' && Number(item?.stop_order || 0) > currentStopOrder)
    .sort((a, b) => Number(a?.stop_order || 0) - Number(b?.stop_order || 0))[0];

  if (!nextDelivery?.id) return;

  const nextStopOrder = Number(nextDelivery?.stop_order || 0);
  const nextOfflineKey = `${driverId}__stop_${nextStopOrder}__${deliveryDate}`;
  const nextExistingRecord = await offlineDB.getById(offlineDB.STORES.DELIVERY_BREADCRUMBS, nextOfflineKey);

  // Only seed the next stop's origin if it has no breadcrumbs yet
  if (nextExistingRecord?.point_count > 0) return;

  await appendPointToDeliveryBreadcrumbs({
    driverId,
    delivery: nextDelivery,
    deliveryDate,
    stopOrder: nextStopOrder,
    boundaryPoint
  });
}