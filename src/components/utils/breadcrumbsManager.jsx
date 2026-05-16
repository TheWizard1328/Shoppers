import { offlineDB } from '@/components/utils/offlineDatabase';
import { base44 } from '@/api/base44Client';

// In-memory cache to prevent repeated API calls for the same driver/date within a session
const _apiFetchedKeys = new Set();

function getEdmontonDateString(value = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Edmonton',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date(value));
  const year = parts.find((p) => p.type === 'year')?.value;
  const month = parts.find((p) => p.type === 'month')?.value;
  const day = parts.find((p) => p.type === 'day')?.value;
  return `${year}-${month}-${day}`;
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

export async function loadBreadcrumbsForDriver(driverId, selectedDateStr, appUsers = []) {
  if (!driverId || !selectedDateStr) {
    return { historical: [], current: [] };
  }

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

    // Fall back to API only once per driver/date per session to avoid rate limits
    const cacheKey = `${driverId}:${selectedDateStr}`;
    if (historical.length === 0 && base44.entities?.DeliveryBreadcrumbs && !_apiFetchedKeys.has(cacheKey)) {
      _apiFetchedKeys.add(cacheKey);
      const apiBreadcrumbs = await base44.entities.DeliveryBreadcrumbs.filter({
        driver_id: driverId,
        delivery_date: selectedDateStr
      });

      if (Array.isArray(apiBreadcrumbs) && apiBreadcrumbs.length > 0) {
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

  // Load "current" live breadcrumbs from offline DELIVERY_BREADCRUMBS for today's in-progress legs
  // These are the live points collected since the last stop was started
  let current = [];
  try {
    const allOffline = await offlineDB.getAll(offlineDB.STORES.DELIVERY_BREADCRUMBS);
    const liveRecords = (allOffline || []).filter((record) => {
      if (!record?.encoded_polyline || !record?.timestamps) return false;
      if (record.driver_id !== driverId) return false;
      if (record.delivery_date !== selectedDateStr) return false;
      // "Live" records use the local offline key format (not a backend ID)
      return typeof record.id === 'string' && record.id.includes('__stop_');
    });

    current = liveRecords.flatMap((record) => {
      const coords = decodePolyline(record.encoded_polyline);
      const tsArr = record.timestamps.split(',').map(Number);
      return coords.map((coord, i) => ({
        lat: coord[0],
        lng: coord[1],
        timestamp: tsArr[i] || 0
      }));
    }).filter((point) => {
      if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return false;
      if (!point.timestamp) return true;
      return getEdmontonDateString(point.timestamp) === selectedDateStr;
    });
  } catch (_) {}

  return { historical, current };
}