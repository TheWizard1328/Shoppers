import { offlineDB } from '@/components/utils/offlineDatabase';
import { base44 } from '@/api/base44Client';

// In-memory cache to prevent repeated API calls for the same driver/date within a session
const _apiFetchedKeys = new Set();

// Sentinel stop_order for the master 'TODAY' timeline record
const MASTER_STOP_ORDER = -1;

// Polyline encoding — 1e7 precision (~1cm accuracy, maximum meaningful GPS resolution)
// MUST match the client encoder in locationBreadcrumbService.jsx and all backend functions.
const POLY_PRECISION = 1e7;

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
    coordinates.push([lat / POLY_PRECISION, lng / POLY_PRECISION]);
  }
  return coordinates;
}

// Parse a breadcrumb record into { stop_order, lat/lng points array }
function parseBreadcrumbRecord(record) {
  if (!record?.encoded_polyline) return null;
  const coords = decodePolyline(record.encoded_polyline);
  const tsArr = record.timestamps ? record.timestamps.split(',').map(Number) : [];
  return {
    id: record.id,
    stop_order: record.stop_order,
    driver_id: record.driver_id,
    encoded_polyline: record.encoded_polyline,
    timestamps: record.timestamps,
    transport_mode: record.transport_mode,
    point_count: record.point_count,
    _coords: coords,
    _tsArr: tsArr,
  };
}

// Extract flat [{lat, lng, timestamp}] from a breadcrumb record (for the 'current' live trail)
function extractLivePoints(record, filterDate) {
  if (!record?.encoded_polyline || !record?.timestamps) return [];
  const coords = decodePolyline(record.encoded_polyline);
  const tsArr = record.timestamps.split(',').map(Number);
  return coords.map((coord, i) => ({
    lat: coord[0],
    lng: coord[1],
    timestamp: tsArr[i] || 0
  })).filter((point) => {
    if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return false;
    if (!point.timestamp) return true;
    return !filterDate || getEdmontonDateString(point.timestamp) === filterDate;
  });
}

export async function loadBreadcrumbsForDriver(driverId, selectedDateStr, appUsers = []) {
  if (!driverId || !selectedDateStr) {
    return { historical: [], current: [] };
  }

  let historical = []; // Per-stop sliced records (stop_order >= 0)
  let masterLivePoints = []; // Points from the master TODAY record (live trail)

  try {
    // ── Load from offline DB first ─────────────────────────────────────────
    const offlineBreadcrumbs = await offlineDB.getByCompoundIndex(
      offlineDB.STORES.DELIVERY_BREADCRUMBS,
      'date_driver',
      [selectedDateStr, driverId]
    );

    if (Array.isArray(offlineBreadcrumbs) && offlineBreadcrumbs.length > 0) {
      for (const record of offlineBreadcrumbs) {
        if (!record?.encoded_polyline) continue;

        if (Number(record.stop_order) === MASTER_STOP_ORDER) {
          // Master 'TODAY' record — extract as live points for the current trail
          masterLivePoints = extractLivePoints(record, selectedDateStr);
        } else {
          // Per-stop sliced record
          const parsed = parseBreadcrumbRecord(record);
          if (parsed) historical.push(parsed);
        }
      }
    }

    // ── Fall back to API once per session if offline has nothing ─────────────
    const cacheKey = `${driverId}:${selectedDateStr}`;
    if (historical.length === 0 && masterLivePoints.length === 0 && !_apiFetchedKeys.has(cacheKey)) {
      _apiFetchedKeys.add(cacheKey);

      // Cheap probe: check if server has any data
      const probe = await base44.entities.DeliveryBreadcrumbs.filter(
        { driver_id: driverId, delivery_date: selectedDateStr },
        '-created_date',
        1
      );

      if (Array.isArray(probe) && probe.length > 0) {
        const apiBreadcrumbs = await base44.entities.DeliveryBreadcrumbs.filter({
          driver_id: driverId,
          delivery_date: selectedDateStr
        });

        if (Array.isArray(apiBreadcrumbs) && apiBreadcrumbs.length > 0) {
          await offlineDB.bulkSave(offlineDB.STORES.DELIVERY_BREADCRUMBS, apiBreadcrumbs);

          for (const record of apiBreadcrumbs) {
            if (!record?.encoded_polyline) continue;
            if (Number(record.stop_order) === MASTER_STOP_ORDER) {
              masterLivePoints = extractLivePoints(record, selectedDateStr);
            } else {
              const parsed = parseBreadcrumbRecord(record);
              if (parsed) historical.push(parsed);
            }
          }
        }
      }
    }
  } catch (e) {
    console.warn('⚠️ Failed to load breadcrumbs:', e.message);
  }

  // ── Build 'current' live trail ─────────────────────────────────────────────
  // Use the master TODAY offline key as the source for the live trail.
  // This gives an unsliced, continuous path of where the driver has been today.
  // We also supplement from the local offline key format for backward compatibility.
  let current = [...masterLivePoints];

  try {
    if (current.length === 0) {
      // Fallback: check for old-style per-leg local offline keys (backward compatibility)
      const allOffline = await offlineDB.getAll(offlineDB.STORES.DELIVERY_BREADCRUMBS);
      const liveRecords = (allOffline || []).filter((record) => {
        if (!record?.encoded_polyline || !record?.timestamps) return false;
        if (record.driver_id !== driverId) return false;
        if (record.delivery_date !== selectedDateStr) return false;
        // Old format: local-only keys
        if (!(typeof record.id === 'string' && record.id.includes('__'))) return false;
        return true;
      });

      current = liveRecords.flatMap((record) => extractLivePoints(record, selectedDateStr));
    }
  } catch (_) {}

  // Deduplicate current points by timestamp
  const seenTs = new Set();
  current = current.filter((pt) => {
    if (!pt.timestamp || seenTs.has(pt.timestamp)) return false;
    seenTs.add(pt.timestamp);
    return true;
  }).sort((a, b) => a.timestamp - b.timestamp);

  return { historical, current };
}
