import { base44 } from '@/api/base44Client';
import { haversineMeters } from './geoUtils';
import { getLocalDateString } from './localTimeHelper';
import { acquireBreadcrumbSyncLock } from './breadcrumbSyncLock';

// ─── Master Timeline Architecture ─────────────────────────────────────────────
// All breadcrumbs are collected into a single 'TODAY' record per driver/date,
// both offline and online. The server-side consolidateBreadcrumbs function later
// slices the master timeline into per-stop segments using delivery_time_end values.
// ──────────────────────────────────────────────────────────────────────────────

// ─── O(1) In-Memory Trail Cache ───────────────────────────────────────────────
// CRITICAL PERF FIX: Previously, every 5s breadcrumb save decoded the ENTIRE day's
// polyline from IDB (O(N)), appended one point, re-encoded the full polyline (O(N)),
// and saved back — making each save O(N) and the total day O(N²). After 8 hours
// (~5,760 points), each save blocked the main thread for 200-500ms, freezing the
// SmartRefreshIndicator spinner and blocking WebSocket callbacks for cross-driver
// location markers.
//
// Fix: keep the day's points as a simple in-memory array. On each 5s save, just
// push to the array (O(1)) and encode from the array (O(N) encode only — no decode).
// The IDB read + decode happens only ONCE per driver/date session (first breadcrumb).
// On subsequent saves, the cache is the source of truth — no IDB read, no decode.
const _masterTrailCache = new Map(); // key: `${driverId}:${date}` → array of [lat, lng, ts]

// Outage markers (force-committed GPS-outage timestamps), mirroring the trail cache
// lifecycle. Loaded from IDB on first breadcrumb of the session, appended on each
// forced commit, and persisted alongside the master 'TODAY' record.
const _outageTimestampsCache = new Map(); // key: `${driverId}:${date}` → Set<number>

function getCacheKey(driverId, deliveryDate) {
  return `${driverId}:${deliveryDate}`;
}

// Online sync throttle: push the full 'TODAY' record to the server every 3rd offline save (15s)
let _lastOnlineSyncTime = 0;
let _breadcrumbSaveCount = 0;
const ONLINE_SYNC_EVERY_N_SAVES = 3; // Sync on every 3rd offline save (3 × 5s = 15s)

// MAX DISTANCE FILTER: 250m max between consecutive breadcrumb points
// At 110 km/h over 5 seconds, max legitimate travel is ~153m. 250m gives a safe buffer.
// Exception: if > 5 minutes have passed since the last point, always accept (heartbeat).
const MAX_BREADCRUMB_DISTANCE_M = 250;
const MAX_BREADCRUMB_STALENESS_MS = 5 * 60 * 1000; // 5 minutes

// Stationary dedup (Option 1): skip storing a breadcrumb when the new GPS fix
// is within this radius of the last stored point. Collapses "at location" piles
// (pre-arrival dwell, at-stop, post-completion lingering, traffic lights) no
// matter which stop the driver is near. The 5-min heartbeat exception above
// still stores one point per 5 min so a long stationary stay leaves an audit trail.
const STATIONARY_DEDUP_RADIUS_M = 12; // ~within phone GPS noise (open-sky ~4m, urban ~10-15m)

// Polyline encoding — 1e7 precision (7 decimal places, ~1cm accuracy).
// Breadcrumb trails use 1e7; HERE/Google route polylines stay at 1e5 (separate codec).
// Arithmetic (non-bitwise) encoder — safe at 1e7 for Edmonton lng (-113.5×1e7 zigzag ≈ 2.27e9, within JS safe-integer range).
const POLY_PRECISION = 1e7;

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

// Auto-detect 1e5 (legacy) vs 1e7 (current) precision from the first raw lat.
// 1e5 raw lat for Edmonton (~53.5°) ≈ 5,350,000; 1e7 ≈ 535,000,000.
// 9,000,000 safely separates the two for any Canada/US latitude, so legacy
// offline-cached 1e5 trails and migrated 1e7 trails both decode correctly.
function decodePolyline(encoded) {
  if (!encoded || typeof encoded !== 'string') return [];
  let index = 0, lat = 0, lng = 0;
  const rawLats = [];
  const rawLngs = [];
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
    rawLats.push(lat);
    rawLngs.push(lng);
  }
  const firstLat = rawLats[0] ?? 0;
  const divisor = Math.abs(firstLat) > 9_000_000 ? 1e7 : 1e5;
  return rawLats.map((rl, i) => [rl / divisor, rawLngs[i] / divisor]);
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

/**
 * Load the master trail into the in-memory cache from IDB.
 * Called only ONCE per driver/date session (first breadcrumb of the day).
 * Subsequent breadcrumbs use the cache directly — no IDB read, no decode.
 */
async function loadTrailIntoCache(driverId, deliveryDate, offlineKey) {
  const cacheKey = getCacheKey(driverId, deliveryDate);
  if (_masterTrailCache.has(cacheKey)) return _masterTrailCache.get(cacheKey);

  const { offlineDB } = await import('./offlineDatabase');
  const existingRecord = await offlineDB.getById(offlineDB.STORES.DELIVERY_BREADCRUMBS, offlineKey);

  let points = [];
  if (existingRecord?.encoded_polyline && existingRecord?.timestamps) {
    const coords = decodePolyline(existingRecord.encoded_polyline);
    const tsArr = existingRecord.timestamps.split(',').map(Number);
    points = coords
      .map((coord, i) => [coord[0], coord[1], tsArr[i] || 0])
      .filter(p => !(Math.abs(p[0]) < 0.0001 && Math.abs(p[1]) < 0.0001));

    if (isCorruptedByBitwiseOverflow(points)) {
      console.warn(`🍞 [Breadcrumbs] Detected corrupted breadcrumb record (valid lat, ~0 lng — bitwise overflow from old encoder). Clearing ${points.length} corrupted points and starting fresh.`);
      points = [];
    }
  }

  _masterTrailCache.set(cacheKey, points);

  // Load existing outage markers (force-committed GPS-outage timestamps) so they
  // survive across session restarts and are re-persisted on each subsequent save.
  const existingOutage = Array.isArray(existingRecord?.outage_timestamps) ? existingRecord.outage_timestamps : [];
  _outageTimestampsCache.set(
    cacheKey,
    new Set(existingOutage.map(Number).filter((n) => Number.isFinite(n))),
  );

  return points;
}

/**
 * Clear the in-memory trail cache for a specific driver/date.
 * Called when the date changes or tracking stops to free memory.
 */
export function clearBreadcrumbCache(driverId, deliveryDate) {
  const cacheKey = getCacheKey(driverId, deliveryDate);
  _masterTrailCache.delete(cacheKey);
  _outageTimestampsCache.delete(cacheKey);
}

/**
 * Clear all breadcrumb caches (e.g., on logout).
 */
export function clearAllBreadcrumbCaches() {
  _masterTrailCache.clear();
  _outageTimestampsCache.clear();
}

/**
 * Peek the last committed crumb's {lat, lng} from the in-memory trail cache.
 * Returns null when the cache is empty (first crumb of the session, or the
 * trail hasn't been loaded yet). Used by the chain-commit walk in locationTracker
 * to compute distances from the last stored point without re-reading IDB.
 */
export function getLastCommittedCrumb(driverId, deliveryDate) {
  const cacheKey = getCacheKey(driverId, deliveryDate);
  const trail = _masterTrailCache.get(cacheKey);
  if (!trail || trail.length === 0) return null;
  const last = trail[trail.length - 1];
  return { lat: last[0], lng: last[1] };
}

export const collectBreadcrumbForTracker = async ({
  driverStatus,
  appUserId,
  currentUser,
  currentDeliveryDate,
  latitude,
  longitude,
  timestamp,
  outage = false,
}) => {
  // Breadcrumb recording rule — collected ONLY while on duty or on break.
  // Off-duty and "online" (non-driver) statuses must NOT produce trails.
  if ((driverStatus !== 'on_duty' && driverStatus !== 'on_break') || !appUserId || !currentUser?.id) {
    return null;
  }

  // Drop Null Island / invalid GPS fixes — [0,0] is never a real coordinate in Edmonton
  if (Math.abs(latitude) < 0.0001 && Math.abs(longitude) < 0.0001) {
    return null;
  }

  const { offlineDB } = await import('./offlineDatabase');

  const deliveryDate = currentDeliveryDate || getLocalDateString();
  const offlineKey = getTodayOfflineKey(currentUser.id, deliveryDate);
  const cacheKey = getCacheKey(currentUser.id, deliveryDate);

  // ── O(1) CACHE PATH: Use in-memory array instead of decoding from IDB ──────
  // First breadcrumb of the session loads from IDB (one-time decode). All
  // subsequent breadcrumbs push to the in-memory array — no IDB read, no decode.
  const trailPoints = await loadTrailIntoCache(currentUser.id, deliveryDate, offlineKey);

  const breadcrumbPoint = [
    Math.round(latitude * 1e7) / 1e7,
    Math.round(longitude * 1e7) / 1e7,
    timestamp,
  ];

  // Distance filter: LOG large GPS jumps but still ACCEPT the point.
  if (trailPoints.length > 0) {
    const lastPoint = trailPoints[trailPoints.length - 1];
    const timeSinceLast = timestamp - (lastPoint[2] || 0);

    if (timeSinceLast < MAX_BREADCRUMB_STALENESS_MS) {
      // Consolidated into geoUtils — identical math, single source of truth.
      const distanceM = haversineMeters(lastPoint[0], lastPoint[1], latitude, longitude);

      // ── Stationary dedup ───────────────────────────────────────────────────
      // Skip storing when the new fix is within the dedup radius of the last
      // stored point — collapses piles at stops, red lights, traffic without
      // needing geofence logic. The 5-min heartbeat exception (below) still
      // leaves an audit trail for long stationary stays.
      if (distanceM <= STATIONARY_DEDUP_RADIUS_M) {
        return { deduped: true };
      }

      if (distanceM > MAX_BREADCRUMB_DISTANCE_M) {
        console.warn(`🍞 [Breadcrumbs] Large GPS jump: ${distanceM.toFixed(0)}m > ${MAX_BREADCRUMB_DISTANCE_M}m — accepting${outage ? ' (forced outage commit)' : ''}`);
      }
    }
  }

  // O(1) append to in-memory array
  trailPoints.push(breadcrumbPoint);

  // ── Outage marker ─────────────────────────────────────────────────────────
  // Record the timestamp of a force-committed (genuine GPS outage) point so the
  // Route viewer / snap analysis can annotate the resulting >250m gap as a
  // known outage rather than a sampling artifact. Diagnostic only.
  if (outage) {
    let outageSet = _outageTimestampsCache.get(cacheKey);
    if (!outageSet) { outageSet = new Set(); _outageTimestampsCache.set(cacheKey, outageSet); }
    outageSet.add(timestamp);
  }
  const outageTsArr = Array.from(_outageTimestampsCache.get(cacheKey) || []);

  // O(N) encode from in-memory array (no decode needed — this is the key optimization)
  const encodedPolyline = encodePolyline(trailPoints);
  const timestamps = trailPoints.map((p) => p[2] || 0).join(',');

  // Save 'TODAY' master record to offline DB
  const offlineRecord = {
    id: offlineKey,
    driver_id: currentUser.id,
    delivery_date: deliveryDate,
    stop_order: -1,
    encoded_polyline: encodedPolyline,
    timestamps,
    transport_mode: 'driving',
    point_count: trailPoints.length,
    outage_timestamps: outageTsArr,
    _pending_server_sync: true,
  };
  await offlineDB.save(offlineDB.STORES.DELIVERY_BREADCRUMBS, offlineRecord);

  // Always save to offline DB first, then sync to server every 3rd save (15s)
  _breadcrumbSaveCount++;
  const now = Date.now();
  if (_breadcrumbSaveCount >= ONLINE_SYNC_EVERY_N_SAVES) {
    _breadcrumbSaveCount = 0;
    _lastOnlineSyncTime = now;
    const releaseLock = await acquireBreadcrumbSyncLock();
    try {
      await base44.functions.invoke('syncPendingBreadcrumbs', {
        driver_id: currentUser.id,
        delivery_date: deliveryDate,
        encoded_polyline: encodedPolyline,
        timestamps,
        point_count: trailPoints.length,
        outage_timestamps: outageTsArr,
      });
      const latest = await offlineDB.getById(offlineDB.STORES.DELIVERY_BREADCRUMBS, offlineKey).catch(() => null);
      if (latest?.encoded_polyline === encodedPolyline) {
        await offlineDB.save(offlineDB.STORES.DELIVERY_BREADCRUMBS, { ...latest, _pending_server_sync: false });
      }
    } catch (error) {
      const isRateLimited = error?.response?.status === 429 || error?.status === 429 || error?.message?.includes('429') || error?.message?.toLowerCase?.includes('rate limit');
      if (!isRateLimited) {
        console.warn(`⚠️ [Breadcrumbs] Server sync failed:`, error.message);
      }
    } finally {
      releaseLock();
    }
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
// ═══════════════════════════════════════════════════════════════════════════════
// seedHomeAnchorOnDuty — home anchor for the master trail (on_duty toggle)
// ═══════════════════════════════════════════════════════════════════════════════
// Called from DriverStatusToggle when the driver toggles ON DUTY from their own
// primary device. Rule (owner-defined, Sep 17 2026):
//   - If the driver is MORE than 50m from home, the home coords become the very
//     FIRST point of the master breadcrumb trail.
//   - If crumbs already exist in the master AND no stops are finished yet for
//     the date, those stray pre-duty crumbs are CLEARED first (the route starts
//     fresh from home — the trail only covers the on-duty period).
//   - If stops are already finished (mid-route re-toggle after a break), the
//     master is left COMPLETELY untouched.
//   - Within 50m of home, no seed — the trail naturally starts at home.
//
// Mutates the in-memory trail cache + IDB record + immediately flushes to the
// server so the slicer's home anchor (consolidateBreadcrumbSegment) sees it.
export const seedHomeAnchorOnDuty = async ({
  driverId,
  deliveryDate,
  homeLat,
  homeLng,
  currentLat,
  currentLng,
  hasFinishedStops,
}) => {
  const hLat = Number(homeLat);
  const hLng = Number(homeLng);
  const cLat = Number(currentLat);
  const cLng = Number(currentLng);
  if (!driverId || ![hLat, hLng, cLat, cLng].every(Number.isFinite)) {
    return { seeded: false, reason: 'missing_coords' };
  }

  const distFromHome = haversineMeters(hLat, hLng, cLat, cLng);
  if (distFromHome <= 50) {
    return { seeded: false, reason: 'within_50m', distance: Math.round(distFromHome) };
  }

  const { offlineDB } = await import('./offlineDatabase');
  const d = deliveryDate || getLocalDateString();
  const offlineKey = getTodayOfflineKey(driverId, d);
  const cacheKey = getCacheKey(driverId, d);

  // Load the trail into the in-memory cache (same cache the collector appends to)
  const trailPoints = await loadTrailIntoCache(driverId, d, offlineKey);

  if (trailPoints.length > 0 && hasFinishedStops) {
    // Mid-route re-toggle — the master is authoritative, never touched.
    return { seeded: false, reason: 'route_in_progress', distance: Math.round(distFromHome) };
  }

  const now = Date.now();
  const homePoint = [hLat, hLng, now];

  if (trailPoints.length === 0) {
    trailPoints.push(homePoint);
  } else {
    // Stray pre-duty crumbs with no finished stops — wipe and restart from home.
    console.log(`🍞 [Breadcrumbs] Duty-toggle seed: clearing ${trailPoints.length} pre-duty crumbs, restarting master from home (${Math.round(distFromHome)}m from driver)`);
    trailPoints.length = 0;
    _outageTimestampsCache.set(cacheKey, new Set());
    trailPoints.push(homePoint);
  }

  const encodedPolyline = encodePolyline(trailPoints);
  const timestamps = trailPoints.map((p) => p[2] || 0).join(',');
  const outageTsArr = Array.from(_outageTimestampsCache.get(cacheKey) || []);

  const offlineRecord = {
    id: offlineKey,
    driver_id: driverId,
    delivery_date: d,
    stop_order: -1,
    encoded_polyline: encodedPolyline,
    timestamps,
    transport_mode: 'driving',
    point_count: trailPoints.length,
    outage_timestamps: outageTsArr,
    _pending_server_sync: true,
  };
  await offlineDB.save(offlineDB.STORES.DELIVERY_BREADCRUMBS, offlineRecord);

  // Immediate flush so the server master (and the slicer's home anchor) sees it
  // right away — don't wait for the 3rd-collect sync cycle.
  const releaseLock = await acquireBreadcrumbSyncLock();
  try {
    await base44.functions.invoke('syncPendingBreadcrumbs', {
      driver_id: driverId,
      delivery_date: d,
      encoded_polyline: encodedPolyline,
      timestamps,
      point_count: trailPoints.length,
      outage_timestamps: outageTsArr,
    });
    const latest = await offlineDB.getById(offlineDB.STORES.DELIVERY_BREADCRUMBS, offlineKey).catch(() => null);
    if (latest?.encoded_polyline === encodedPolyline) {
      await offlineDB.save(offlineDB.STORES.DELIVERY_BREADCRUMBS, { ...latest, _pending_server_sync: false });
    }
  } catch (error) {
    console.warn(`⚠️ [Breadcrumbs] Duty-toggle seed flush failed (will retry on next collect):`, error?.message || error);
  } finally {
    releaseLock();
  }

  console.log(`🍞 [Breadcrumbs] Duty-toggle seed: home coords injected as first master point (${Math.round(distFromHome)}m from driver, ${trailPoints.length} pts total)`);
  return { seeded: true, cleared: trailPoints.length === 1, distance: Math.round(distFromHome) };
};


/** Flush every dirty local master trail after connectivity returns. */
export const flushPendingBreadcrumbMasters = async () => {
  const { offlineDB } = await import('./offlineDatabase');
  const records = await offlineDB.getAll(offlineDB.STORES.DELIVERY_BREADCRUMBS).catch(() => []);
  const pending = (records || []).filter((record) =>
    record?._pending_server_sync !== false &&
    record?.driver_id && record?.delivery_date && record?.encoded_polyline && record?.timestamps
  );
  if (!pending.length) return { flushed: 0 };

  const releaseLock = await acquireBreadcrumbSyncLock();
  let flushed = 0;
  try {
    for (const record of pending) {
      if (Number(record.stop_order) === -1) {
        await base44.functions.invoke('syncPendingBreadcrumbs', {
          driver_id: record.driver_id,
          delivery_date: record.delivery_date,
          encoded_polyline: record.encoded_polyline,
          timestamps: record.timestamps,
          point_count: record.point_count,
          outage_timestamps: record.outage_timestamps || [],
        });
      } else {
        const payload = {
          driver_id: record.driver_id,
          delivery_id: record.delivery_id,
          delivery_date: record.delivery_date,
          stop_order: record.stop_order,
          encoded_polyline: record.encoded_polyline,
          timestamps: record.timestamps,
          transport_mode: record.transport_mode || 'driving',
          point_count: record.point_count,
        };
        const existing = await base44.entities.DeliveryBreadcrumbs.filter({
          driver_id: record.driver_id,
          delivery_date: record.delivery_date,
          stop_order: record.stop_order,
        }).catch(() => []);
        if (existing?.[0]?.id) await base44.entities.DeliveryBreadcrumbs.update(existing[0].id, payload);
        else await base44.entities.DeliveryBreadcrumbs.create(payload);
      }
      const latest = await offlineDB.getById(offlineDB.STORES.DELIVERY_BREADCRUMBS, record.id).catch(() => null);
      if (latest?.encoded_polyline === record.encoded_polyline) {
        await offlineDB.save(offlineDB.STORES.DELIVERY_BREADCRUMBS, { ...latest, _pending_server_sync: false });
      }
      flushed++;
    }
  } finally {
    releaseLock();
  }
  return { flushed };
};
