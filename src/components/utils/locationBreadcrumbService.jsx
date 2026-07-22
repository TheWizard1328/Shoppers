import { base44 } from '@/api/base44Client';
import { getLocalDateString } from './localTimeHelper';

// ─── Master Timeline Architecture ─────────────────────────────────────────────
// All breadcrumbs are collected into a single 'TODAY' record per driver/date,
// both offline and online. The server-side consolidateBreadcrumbs function later
// slices the master timeline into per-stop segments using delivery_time_end values.
// ──────────────────────────────────────────────────────────────────────────────

// Online sync throttle: push the full 'TODAY' record to the server every 3rd offline save (15s)
let _lastOnlineSyncTime = 0;
let _breadcrumbSaveCount = 0;
const ONLINE_SYNC_EVERY_N_SAVES = 3; // Sync on every 3rd offline save (3 × 5s = 15s)

// MAX DISTANCE FILTER: 250m max between consecutive breadcrumb points
// At 110 km/h over 5 seconds, max legitimate travel is ~153m. 250m gives a safe buffer.
// Exception: if > 5 minutes have passed since the last point, always accept (heartbeat).
const MAX_BREADCRUMB_DISTANCE_M = 250;
const MAX_BREADCRUMB_STALENESS_MS = 5 * 60 * 1000; // 5 minutes

// Polyline encoding — 1e5 precision (~1m accuracy, standard Google/HERE polyline format)
const POLY_PRECISION = 1e5;

// CRITICAL: These encode/decode functions use pure arithmetic instead of JavaScript
// bitwise operators (<<, >>, &, |, ~). At 1e5 precision, Edmonton's longitude
// (-113.5) produces an integer of -1,135,000,000. The zigzag encoding step requires
// multiplying by 2 (<< 1), which gives -2,270,000,000 — this OVERFLOWS JavaScript's
// 32-bit signed integer range (-2,147,483,648 to 2,147,483,647). The overflow silently
// corrupts the longitude to ~0, while the latitude (53.5 * 1e7 = 535,000,000, * 2 =
// 1,070,000,000 — within range) is unaffected. Using arithmetic (* 2, / 2, %) avoids
// the 32-bit overflow entirely, working correctly for any coordinate on Earth.

function encodePolylineValue(value) {
  let v = Math.round(value * POLY_PRECISION);
  // Zigzag encode using arithmetic: 0→0, -1→1, 1→2, -2→3, etc.
  // NOT: v = v < 0 ? ~(v << 1) : v << 1  (overflows 32-bit for |lng| > ~107° at 1e7)
  v = v < 0 ? (-v * 2 - 1) : (v * 2);
  let result = '';
  while (v >= 0x20) {
    result += String.fromCharCode((0x20 + (v % 0x20)) + 63);
    v = Math.floor(v / 0x20);
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
    let result = 0, multiplier = 1, byte;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result += (byte % 32) * multiplier;
      multiplier *= 32;
    } while (byte >= 0x20);
    lat += (result % 2 !== 0) ? -((result + 1) / 2) : (result / 2);
    result = 0; multiplier = 1;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result += (byte % 32) * multiplier;
      multiplier *= 32;
    } while (byte >= 0x20);
    lng += (result % 2 !== 0) ? -((result + 1) / 2) : (result / 2);
    coordinates.push([lat / POLY_PRECISION, lng / POLY_PRECISION]);
  }
  return coordinates;
}

// The stable offline key for the master 'TODAY' timeline record
function getTodayOfflineKey(userId, deliveryDate) {
  return `${userId}__TODAY__${deliveryDate}`;
}

// Detect corrupted breadcrumb records from the old bitwise encoder (pre-fix).
// The old encoder overflowed 32-bit for |longitude| > ~107° at 1e5 precision,
// zeroing out the longitude while keeping latitude correct. If we see valid
// latitudes but near-zero longitudes, the record is corrupted and should be discarded.
function isCorruptedByBitwiseOverflow(points) {
  if (points.length === 0) return false;
  // At least 2 points with valid lat but ~0 lng = corruption signature
  let corruptCount = 0;
  for (const p of points) {
    if (Math.abs(p[0]) > 1 && Math.abs(p[1]) < 0.01) {
      corruptCount++;
    }
  }
  return corruptCount >= 2;
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

  // Drop Null Island / invalid GPS fixes — [0,0] is never a real coordinate in Edmonton
  if (Math.abs(latitude) < 0.0001 && Math.abs(longitude) < 0.0001) {
    console.warn('🍞 [Breadcrumbs] Dropping invalid [0,0] coordinate — GPS not yet locked');
    return null;
  }

  const { offlineDB } = await import('./offlineDatabase');

  const deliveryDate = currentDeliveryDate || getLocalDateString();
  const offlineKey = getTodayOfflineKey(currentUser.id, deliveryDate);

  // Load existing offline 'TODAY' master record
  const existingOfflineRecord = await offlineDB.getById(offlineDB.STORES.DELIVERY_BREADCRUMBS, offlineKey);
  // Store coordinates at 7 decimal place precision (~1cm accuracy)
  const breadcrumbPoint = [
    Math.round(latitude * 1e5) / 1e5,
    Math.round(longitude * 1e5) / 1e5,
    timestamp,
  ];

  // Reconstruct existing points from encoded polyline + timestamps
  let existingPoints = [];
  if (existingOfflineRecord?.encoded_polyline && existingOfflineRecord?.timestamps) {
    const coords = decodePolyline(existingOfflineRecord.encoded_polyline);
    const tsArr = existingOfflineRecord.timestamps.split(',').map(Number);
    existingPoints = coords
      .map((coord, i) => [coord[0], coord[1], tsArr[i] || 0])
      .filter(p => !(Math.abs(p[0]) < 0.0001 && Math.abs(p[1]) < 0.0001)); // Strip any previously-saved [0,0] points

    // Detect and clear corrupted records from the old bitwise-overflow encoder.
    // The old encoder zeroed out longitude for Edmonton coordinates (|lng| > 107° at 1e7).
    // If detected, discard all existing points and start fresh with the current GPS fix.
    if (isCorruptedByBitwiseOverflow(existingPoints)) {
      console.warn(`🍞 [Breadcrumbs] Detected corrupted breadcrumb record (valid lat, ~0 lng — bitwise overflow from old encoder). Clearing ${existingPoints.length} corrupted points and starting fresh.`);
      existingPoints = [];
    }
  }

  // Distance filter: LOG large GPS jumps but still ACCEPT the point.
  // Previously, jumps >250m were rejected, which caused gaps in the trail exactly
  // when the driver was moving fast (highway) or after a GPS re-acquisition.
  // The spatial anchor refinement in consolidateBreadcrumbs can handle minor GPS
  // noise. A gap in the trail is worse than a potentially-imperfect point.
  if (existingPoints.length > 0) {
    const lastPoint = existingPoints[existingPoints.length - 1];
    const timeSinceLast = timestamp - (lastPoint[2] || 0);

    if (timeSinceLast < MAX_BREADCRUMB_STALENESS_MS) {
      const R = 6371000;
      const dLat = (latitude - lastPoint[0]) * Math.PI / 180;
      const dLon = (longitude - lastPoint[1]) * Math.PI / 180;
      const a = Math.sin(dLat / 2) ** 2 + Math.cos(lastPoint[0] * Math.PI / 180) * Math.cos(latitude * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
      const distanceM = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

      if (distanceM > MAX_BREADCRUMB_DISTANCE_M) {
        console.warn(`🍞 [Breadcrumbs] Large GPS jump: ${distanceM.toFixed(0)}m > ${MAX_BREADCRUMB_DISTANCE_M}m — accepting (was previously rejected, causing gaps)`);
      }
    } else {
      console.log(`🍞 [Breadcrumbs] Heartbeat accepted — ${Math.round(timeSinceLast / 1000)}s since last point`);
    }
  }

  const allPoints = existingPoints.length > 0
    ? [...existingPoints, breadcrumbPoint]
    : [breadcrumbPoint];

  const encodedPolyline = encodePolyline(allPoints);
  const timestamps = allPoints.map((p) => p[2] || 0).join(',');

  // Save 'TODAY' master record to offline DB
  // stop_order = -1 is the sentinel value meaning "master timeline / unsliced"
  const offlineRecord = {
    id: offlineKey,
    driver_id: currentUser.id,
    delivery_date: deliveryDate,
    stop_order: -1, // Sentinel: master timeline, not a specific stop
    encoded_polyline: encodedPolyline,
    timestamps,
    transport_mode: 'driving', // Master timeline doesn't have a mode; stops inherit from delivery
    point_count: allPoints.length,
  };
  await offlineDB.save(offlineDB.STORES.DELIVERY_BREADCRUMBS, offlineRecord);

  // Always save to offline DB first, then sync to server every 3rd save (15s)
  _breadcrumbSaveCount++;
  const now = Date.now();
  if (_breadcrumbSaveCount >= ONLINE_SYNC_EVERY_N_SAVES) {
    _breadcrumbSaveCount = 0;
    _lastOnlineSyncTime = now;
    try {
      await base44.functions.invoke('syncPendingBreadcrumbs', {
        driver_id: currentUser.id,
        delivery_date: deliveryDate,
        encoded_polyline: encodedPolyline,
        timestamps,
        point_count: allPoints.length,
      });
      console.log(`☁️ [Breadcrumbs] Master timeline synced to server (${allPoints.length} points, save #${_breadcrumbSaveCount + ONLINE_SYNC_EVERY_N_SAVES})`);
    } catch (error) {
      const isRateLimited = error?.response?.status === 429 || error?.status === 429 || error?.message?.includes('429') || error?.message?.toLowerCase?.().includes('rate limit');
      if (!isRateLimited) {
        console.warn(`⚠️ [Breadcrumbs] Server sync failed:`, error.message);
      }
    }
  } else {
    console.log(`🍞 [Breadcrumbs] Offline save ${_breadcrumbSaveCount}/${ONLINE_SYNC_EVERY_N_SAVES} (${allPoints.length} pts) — server sync on save #${ONLINE_SYNC_EVERY_N_SAVES}`);
  }

  // Dispatch event for live map display (stop_order = -1 means "live, unsliced")
  window.dispatchEvent(new CustomEvent('breadcrumbCollected', {
    detail: {
      driverId: currentUser?.id,
      appUserId,
      deliveryDate,
      stopOrder: -1,
      point: { lat: latitude, lng: longitude, timestamp }
    }
  }));

  return { pendingKey: offlineKey, deliveryDate };
};
