/* global Deno */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';
import { pickBestMaster } from '../../shared/masterBreadcrumbDedup.ts';

// ═══════════════════════════════════════════════════════════════════════════════
// consolidateBreadcrumbSegment — Sequential Home-Anchored Breadcrumb Slicing
// ═══════════════════════════════════════════════════════════════════════════════
//
// Two modes:
//
// FULL (default — the Route Viewer "resnip" scissors tool, snapMasterTimeline,
// and preview_only reclip projections):
//   1. Resolve the driver's HOME coords (AppUser.home_latitude/longitude, or
//      home_lat/home_lng override params).
//   2. Anchor the route at home: find the first master crumb within 50m of
//      home (bounded by the first crumb within 50m of stop 1, so an end-of-day
//      return home can never win). If no crumb qualifies, the home coords are
//      PREPENDED as a synthetic first point of the home→stop-1 leg.
//   3. Walk stops strictly in stop_order. For stop N, the scan window runs
//      from the previous boundary to the first crumb within 50m of stop N+1
//      (end of trail for the last stop). This bound makes drive-bys immune:
//      a later pass near stop N can never steal points from a later leg, and
//      an unvisited stop can never swallow future legs.
//   4. A crumb QUALIFIES for stop N if it is within 50m of the stop OR within
//      ±2 minutes of the stop's actual_delivery_time (rescues GPS drift — the
//      crumbs recorded at the delivery moment are at the stop even when the
//      fix drifts past 50m). Among qualifiers the ABSOLUTE CLOSEST by distance
//      wins and becomes the leg boundary.
//   5. No qualifier: if the closest approach in the window is ≤200m, the leg
//      is the trail up to that point PLUS the stop's own coords appended as
//      the final anchor (stamped with actual_delivery_time). Beyond 200m
//      (skipped/failed stop) the leg is a straight 2-point line from the
//      previous boundary to the stop coords — no unrelated trail dragged in.
//
// INCREMENTAL (mode: 'incremental' — the automatic stop-finish path):
//   The driver's GPS is freshly at the just-finished stop (the completion flow
//   force-flushes the master right before this call), so only ONE leg is cut:
//   from the final point of the PREVIOUS finished stop's saved segment (or the
//   home anchor / trail start for the first finished stop) forward through the
//   trail to the closest qualifying crumb (same 50m / ±2min rule). Earlier
//   legs are NEVER re-cut. Only the just-finished stop's segment is written.
//
// All stop types are handled identically:
//   - Patient deliveries → patient.lat/lng
//   - Store pickups → store.lat/lng
//   - ISD (inter-store dropoff) → InterStoreLocation by assignedStorePhone in delivery_id
//   - ISP (inter-store pickup) → InterStoreLocation by pickupLocationPhone in delivery_id
//   - Cycling markers → cycling_latitude/cycling_longitude on the delivery
//
// ═══════════════════════════════════════════════════════════════════════════════

// ── Constants ──────────────────────────────────────────────────────────────────
const MATCH_RADIUS_M = 50;            // crumb qualifies by proximity
const TIME_WINDOW_MS = 2 * 60 * 1000; // crumb qualifies by ±2 min of delivery time
const NEAR_MISS_MAX_M = 200;          // closest approach beyond this → straight synthetic line
const POLY_PRECISION = 1e7;           // breadcrumb trails are 1e7 (legacy 1e5 auto-detected)

// ── Polyline encode/decode ───────────────────────────────────────────────────
function encodePolylineValue(value) {
  let v = Math.round(value * POLY_PRECISION);
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

// Detect corrupted points from the old bitwise-overflow encoder.
function isCorruptedPoint(lat, lng) {
  return Math.abs(lat) > 1 && Math.abs(lng) < 0.01;
}

// ── Haversine distance (meters) ─────────────────────────────────────────────
function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Edmonton wall-clock ("YYYY-MM-DD HH:MM:SS") → epoch ms ───────────────────
// actual_delivery_time is stored as a LOCAL Edmonton wall-clock string. The
// master trail timestamps are epoch ms (UTC). Convert via a two-iteration
// Intl offset lookup so DST is handled correctly.
function edmontonOffsetMs(utcMs) {
  try {
    const dtf = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Edmonton',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
    const parts = dtf.formatToParts(new Date(utcMs));
    const get = (t) => Number(parts.find((p) => p.type === t)?.value || 0);
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
    return asUtc - utcMs; // Edmonton is behind UTC → negative offset
  } catch {
    return -6 * 3600 * 1000; // MDT fallback
  }
}

function deliveryTimeToEpochMs(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw > 1e12 ? raw : raw > 1e9 ? raw * 1000 : null;
  }
  const s = String(raw).trim();
  if (!s) return null;
  // "YYYY-MM-DD HH:MM:SS" (Edmonton local, seconds or minute precision)
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (m) {
    const naive = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] || 0));
    // Two-iteration refinement handles DST boundaries correctly
    const o1 = edmontonOffsetMs(naive);
    const e1 = naive - o1;
    const o2 = edmontonOffsetMs(e1);
    return naive - o2;
  }
  const parsed = Date.parse(s);
  return Number.isFinite(parsed) ? parsed : null;
}

// ── ISD/ISP delivery_id parsing (mirrors interStoreDisplayName.jsx) ──────────
function parseInterStoreDeliveryId(deliveryId) {
  if (!deliveryId) return null;
  const upper = String(deliveryId).toUpperCase();
  const isISP = upper.startsWith('ISP-');
  const isISD = upper.startsWith('ISD-');
  if (!isISP && !isISD) return null;
  const parts = String(deliveryId).split('-');
  if (parts.length < 3) return null;
  return {
    type: isISP ? 'ISP' : 'ISD',
    pickupLocationPhone: parts[2] ? parts[2].replace(/\D/g, '') : null,
    assignedStorePhone: parts[3] ? parts[3].replace(/\D/g, '') : null,
  };
}

function stripPhone(s) {
  return (s || '').replace(/\D/g, '');
}

// ── Resolve coordinates for a single delivery ───────────────────────────────
function resolveDeliveryCoords(delivery, phoneToInterStore, patientMap, storeMap) {
  if (!delivery) return null;

  // Cycling markers — coords embedded directly on the delivery
  if (delivery.is_cycling_marker) {
    const cLat = Number(delivery.cycling_latitude);
    const cLng = Number(delivery.cycling_longitude);
    if (Number.isFinite(cLat) && Number.isFinite(cLng) && cLat !== 0 && cLng !== 0) {
      return { lat: cLat, lng: cLng };
    }
  }

  // ISD/ISP — resolve via InterStoreLocation by phone number from delivery_id
  const parsed = parseInterStoreDeliveryId(delivery.delivery_id || delivery.id);
  if (parsed) {
    // ISP → pickup FROM source store → use pickupLocationPhone (parts[2])
    // ISD → dropoff TO dest store → use assignedStorePhone (parts[3])
    const phone = parsed.type === 'ISD'
      ? parsed.assignedStorePhone
      : parsed.pickupLocationPhone;
    if (phone) {
      const loc = phoneToInterStore.get(phone);
      if (loc) {
        const lat = Number(loc.store_latitude);
        const lng = Number(loc.store_longitude);
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          return { lat, lng };
        }
      }
    }
    // Fallback: if the ISD has an assigned store_id, try store coords
    if (delivery.store_id && storeMap.has(delivery.store_id)) {
      const store = storeMap.get(delivery.store_id);
      const lat = Number(store.latitude);
      const lng = Number(store.longitude);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        return { lat, lng };
      }
    }
    return null;
  }

  // Patient delivery → patient.lat/lng
  if (delivery.patient_id) {
    const patient = patientMap.get(delivery.patient_id);
    if (patient) {
      const lat = Number(patient.latitude);
      const lng = Number(patient.longitude);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        return { lat, lng };
      }
    }
    return null;
  }

  // Store pickup → store.lat/lng
  if (delivery.store_id) {
    const store = storeMap.get(delivery.store_id);
    if (store) {
      const lat = Number(store.latitude);
      const lng = Number(store.longitude);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        return { lat, lng };
      }
    }
  }

  return null;
}

// ── Shared slicing helpers ────────────────────────────────────────────────────

/**
 * Find the first trail index (scanning from `from`) whose point is within
 * `radiusM` of (lat,lng). Returns the index or -1.
 */
function firstIndexWithin(masterPoints, from, lat, lng, radiusM) {
  for (let i = Math.max(0, from); i < masterPoints.length; i++) {
    if (haversineMeters(lat, lng, masterPoints[i][0], masterPoints[i][1]) <= radiusM) return i;
  }
  return -1;
}

/**
 * Scan window [from, to) for the stop at (lat,lng) with delivery time `dtMs`.
 * A crumb qualifies when within MATCH_RADIUS_M of the stop OR within
 * TIME_WINDOW_MS of the delivery time. Returns:
 *   qualifierIdx/qualifierDist — absolute-closest qualifying crumb
 *   closestIdx/closestDist     — closest approach regardless of qualification
 */
function scanWindow(masterPoints, from, to, lat, lng, dtMs) {
  let qualifierIdx = null, qualifierDist = Infinity;
  let closestIdx = null, closestDist = Infinity;
  for (let i = Math.max(0, from); i < to && i < masterPoints.length; i++) {
    const mp = masterPoints[i];
    const dist = haversineMeters(lat, lng, mp[0], mp[1]);
    if (dist < closestDist) { closestDist = dist; closestIdx = i; }
    const timeOk = dtMs != null && Math.abs((mp[2] || 0) - dtMs) <= TIME_WINDOW_MS;
    if ((dist <= MATCH_RADIUS_M || timeOk) && dist < qualifierDist) {
      qualifierDist = dist; qualifierIdx = i;
    }
  }
  return { qualifierIdx, qualifierDist, closestIdx, closestDist };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main handler
// ═══════════════════════════════════════════════════════════════════════════════

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const {
      driver_id,
      delivery_date,
      delivery_id: _triggeredDeliveryId,  // just-finished stop in incremental mode
      selected_stop_orders = null,
      force_replace = false,
      master_polyline = null,
      master_timestamps = null,
      preview_only = false,
      // NEW — 'full' (default, scissors/snap/preview) | 'incremental' (stop-finish tail cut)
      mode = 'full',
      // NEW — optional home coords override (else fetched from AppUser)
      home_lat = null,
      home_lng = null,
    } = body || {};

    if (!driver_id || !delivery_date) {
      return Response.json({ success: false, error: 'driver_id and delivery_date are required' }, { status: 400 });
    }

    const isIncremental = mode === 'incremental';

    // Normalize the optional selected_stop_orders into a Set<number> (empty = full route).
    const selectedSet = Array.isArray(selected_stop_orders) && selected_stop_orders.length > 0
      ? new Set(selected_stop_orders.map((n) => Number(n)).filter(Number.isFinite))
      : null;
    const explicitlySelected = !!selectedSet;

    console.log(`🍞 [consolidateBreadcrumbSegment] ${isIncremental ? 'INCREMENTAL tail cut' : 'FULL home-anchored walk'} for driver=${driver_id}, date=${delivery_date}${_triggeredDeliveryId ? `, target ${_triggeredDeliveryId}` : ''}`);

    // ── 1. Read the master trail (stop_order = -1) ─────────────────────────────
    const usePassedMaster = typeof master_polyline === 'string' && master_polyline.length > 0;

    const masterPointsArr = [];

    const pushDecodedCoords = (encoded, tsStr) => {
      const coords = decodePolyline(encoded);
      const tsArr = (typeof tsStr === 'string' && tsStr.length > 0)
        ? tsStr.split(',').map(Number)
        : [];
      for (let i = 0; i < coords.length; i++) {
        const lat = coords[i][0], lng = coords[i][1];
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || isCorruptedPoint(lat, lng)) continue;
        const ts = Number(tsArr[i]) || 0; // 0 when missing — kept, not dropped
        masterPointsArr.push([lat, lng, ts]);
      }
    };

    if (usePassedMaster) {
      console.log(`🍞 [consolidateBreadcrumbSegment] Using PASSED master polyline (${master_polyline.length} chars) — skipping DB read`);
      pushDecodedCoords(master_polyline, master_timestamps);
    } else {
      const masterRecords = await base44.asServiceRole.entities.DeliveryBreadcrumbs.filter({
        driver_id,
        delivery_date,
        stop_order: -1
      });

      if (Array.isArray(masterRecords) && masterRecords.length > 1) {
        console.warn(`⚠️ [consolidateBreadcrumbSegment] Found ${masterRecords.length} duplicate master records for driver=${driver_id} date=${delivery_date} — using best, deleting stale.`);
      }

      const { best: bestMaster, rest: dupMasters } = pickBestMaster(masterRecords);

      console.log(`🍞 [consolidateBreadcrumbSegment] Using master ${bestMaster?.id} (${bestMaster?.point_count ?? 0} pts)${bestMaster?.is_snapped === true ? ' [SNAPPED]' : ''} — deleting ${dupMasters.length} stale duplicate(s)`);
      for (const dup of dupMasters) {
        if (dup?.id) {
          await base44.asServiceRole.entities.DeliveryBreadcrumbs.delete(dup.id).catch(() => null);
        }
      }
      if (bestMaster?.encoded_polyline) {
        pushDecodedCoords(bestMaster.encoded_polyline, bestMaster.timestamps);
      }
    }

    const masterPoints = masterPointsArr;

    if (masterPoints.length === 0) {
      return Response.json({
        success: false,
        error: 'No master breadcrumb trail found for this driver/date',
        driver_id,
        delivery_date,
        point_count: 0
      }, { status: 404 });
    }

    console.log(`🍞 [consolidateBreadcrumbSegment] Master trail: ${masterPoints.length} points`);

    // ── 2. Fetch all deliveries for this driver/date, sorted by stop_order ────
    const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
    const allDeliveries = await base44.asServiceRole.entities.Delivery.filter({
      driver_id,
      delivery_date
    });

    const stops = (allDeliveries || [])
      .filter(d => d && d.stop_order != null && Number.isFinite(Number(d.stop_order)) && TERMINAL_STATUSES.has(String(d.status || '').toLowerCase()))
      .sort((a, b) => Number(a.stop_order) - Number(b.stop_order));

    if (stops.length === 0) {
      return Response.json({ success: false, error: 'No deliveries with stop_order found', point_count: 0 }, { status: 404 });
    }

    console.log(`🍞 [consolidateBreadcrumbSegment] ${stops.length} finished stops`);

    // ── 3. Build lookup maps for coordinate resolution ────────────────────────
    const patientIds = new Set();
    const storeIds = new Set();
    const interStorePhones = new Set();

    for (const d of stops) {
      if (d.is_cycling_marker) continue; // cycling markers have embedded coords
      const parsed = parseInterStoreDeliveryId(d.delivery_id || d.id);
      if (parsed) {
        const phone = parsed.type === 'ISD' ? parsed.assignedStorePhone : parsed.pickupLocationPhone;
        if (phone) interStorePhones.add(phone);
        if (d.store_id) storeIds.add(d.store_id);
        continue;
      }
      if (d.patient_id) patientIds.add(d.patient_id);
      if (d.store_id) storeIds.add(d.store_id);
    }

    const phoneToInterStore = new Map();
    if (interStorePhones.size > 0) {
      const allInterStoreLocs = await base44.asServiceRole.entities.InterStoreLocation.list().catch(() => []);
      for (const loc of (allInterStoreLocs || [])) {
        const phone = stripPhone(loc.store_phone);
        if (phone) phoneToInterStore.set(phone, loc);
      }
    }

    const patientMap = new Map();
    if (patientIds.size > 0) {
      const allPatients = await base44.asServiceRole.entities.Patient.list().catch(() => []);
      for (const p of (allPatients || [])) {
        if (patientIds.has(p.id)) patientMap.set(p.id, p);
      }
    }

    const storeMap = new Map();
    if (storeIds.size > 0) {
      const allStores = await base44.asServiceRole.entities.Store.list().catch(() => []);
      for (const s of (allStores || [])) {
        if (storeIds.has(s.id)) storeMap.set(s.id, s);
      }
    }

    // ── 4. Resolve coordinates + delivery times for each stop ─────────────────
    const stopsWithCoords = [];
    const stopsWithoutCoords = [];

    for (const d of stops) {
      const coords = resolveDeliveryCoords(d, phoneToInterStore, patientMap, storeMap);
      const dtMs = deliveryTimeToEpochMs(d.actual_delivery_time);
      if (coords) {
        stopsWithCoords.push({ delivery: d, coords, dtMs });
      } else {
        stopsWithoutCoords.push(d);
      }
    }

    if (stopsWithCoords.length === 0) {
      return Response.json({
        success: false,
        error: 'Could not resolve coordinates for any stops',
        point_count: 0,
        unresolved_count: stops.length
      }, { status: 500 });
    }

    if (stopsWithoutCoords.length > 0) {
      console.log(`⚠️ [consolidateBreadcrumbSegment] ${stopsWithoutCoords.length} stops with unresolvable coords (will be skipped)`);
    }

    // ── 5. Resolve home coords ─────────────────────────────────────────────────
    let homeCoords = null;
    if (Number.isFinite(Number(home_lat)) && Number.isFinite(Number(home_lng))) {
      homeCoords = { lat: Number(home_lat), lng: Number(home_lng) };
    } else {
      const appUsers = await base44.asServiceRole.entities.AppUser.filter({ user_id: driver_id }).catch(() => []);
      const au = (appUsers || [])[0];
      const hLat = Number(au?.home_latitude);
      const hLng = Number(au?.home_longitude);
      if (Number.isFinite(hLat) && Number.isFinite(hLng)) {
        homeCoords = { lat: hLat, lng: hLng };
      }
    }

    // ═════════════════════════════════════════════════════════════════════════
    // 6a. INCREMENTAL MODE — tail-only cut for the just-finished stop
    // ═════════════════════════════════════════════════════════════════════════
    if (isIncremental) {
      const target = stopsWithCoords.find((s) =>
        s.delivery.id === _triggeredDeliveryId || s.delivery.delivery_id === _triggeredDeliveryId
      ) || stopsWithCoords[stopsWithCoords.length - 1]; // fallback: highest stop_order

      if (!target) {
        return Response.json({ success: false, error: 'Just-finished stop not found among terminal stops', point_count: 0 }, { status: 404 });
      }

      const stopOrder = Number(target.delivery.stop_order);
      console.log(`🍞 [consolidateBreadcrumbSegment] Incremental target: stop #${stopOrder} (dt=${target.dtMs ?? 'n/a'})`);

      const existingAll = await base44.asServiceRole.entities.DeliveryBreadcrumbs.filter({
        driver_id,
        delivery_date
      }).catch(() => []);

      // Find the anchor: previous finished stop (by stop_order) with a saved segment
      let cursor = -1;            // boundary index in the trail (-1 = trail start)
      let anchorPoint = null;     // synthetic home point prepended to a first leg
      const prevStops = stopsWithCoords.filter((s) => Number(s.delivery.stop_order) < stopOrder);
      let prevSegmentRecord = null;
      let prevStop = null;

      for (let i = prevStops.length - 1; i >= 0 && !prevSegmentRecord; i--) {
        const cand = prevStops[i];
        const rec = (existingAll || []).find((r) => Number(r.stop_order) === Number(cand.delivery.stop_order));
        if (rec?.encoded_polyline) { prevSegmentRecord = rec; prevStop = cand; }
      }

      if (prevSegmentRecord) {
        // Anchor = final point of the previous stop's saved leg. Locate it in the
        // master trail (it IS a trail point for real legs; the stop coords for
        // synthetic ones — first-within-1m finds the exact point).
        const segPts = decodePolyline(prevSegmentRecord.encoded_polyline);
        const last = segPts[segPts.length - 1];
        if (last) {
          let idx = firstIndexWithin(masterPoints, 0, last[0], last[1], 1);
          if (idx === -1) idx = firstIndexWithin(masterPoints, 0, last[0], last[1], MATCH_RADIUS_M);
          if (idx !== -1) {
            cursor = idx;
            console.log(`🍞 [consolidateBreadcrumbSegment] Anchor: prev stop #${Number(prevStop.delivery.stop_order)} final point → trail idx ${idx}`);
          }
        }
      }

      // No previous segment (first finished stop) → anchor at home / trail start
      if (cursor === -1) {
        if (homeCoords) {
          const stop1Approach = firstIndexWithin(masterPoints, 0, target.coords.lat, target.coords.lng, MATCH_RADIUS_M);
          const homeBound = stop1Approach === -1 ? masterPoints.length : stop1Approach;
          const homeIdx = firstIndexWithin(masterPoints, 0, homeCoords.lat, homeCoords.lng, MATCH_RADIUS_M);
          if (homeIdx !== -1 && homeIdx < homeBound) {
            cursor = homeIdx;
          } else {
            const firstDist = haversineMeters(homeCoords.lat, homeCoords.lng, masterPoints[0][0], masterPoints[0][1]);
            if (firstDist > MATCH_RADIUS_M) {
              anchorPoint = [homeCoords.lat, homeCoords.lng, masterPoints[0][2] || 0];
            }
            cursor = 0;
          }
        } else {
          cursor = 0;
        }
      }

      // Scan forward through the trail for the target stop
      const cursorStart = cursor + 1;
      const win = scanWindow(masterPoints, cursorStart, masterPoints.length, target.coords.lat, target.coords.lng, target.dtMs);

      let segPts;
      let matchDistance;
      let method;

      if (win.qualifierIdx !== null) {
        segPts = masterPoints.slice(cursorStart, win.qualifierIdx + 1).map((p) => [p[0], p[1], p[2] || 0]);
        if (anchorPoint) segPts.unshift(anchorPoint);
        matchDistance = win.qualifierDist;
        method = 'incremental-proximity';
      } else if (win.closestIdx !== null && win.closestDist <= NEAR_MISS_MAX_M) {
        segPts = masterPoints.slice(cursorStart, win.closestIdx + 1).map((p) => [p[0], p[1], p[2] || 0]);
        if (anchorPoint) segPts.unshift(anchorPoint);
        segPts.push([target.coords.lat, target.coords.lng, target.dtMs ?? 0]);
        matchDistance = win.closestDist;
        method = 'incremental-near-miss-anchor';
      } else {
        const anchorCoords = cursor >= 0
          ? [masterPoints[cursor][0], masterPoints[cursor][1], masterPoints[cursor][2] || 0]
          : (anchorPoint || [masterPoints[0][0], masterPoints[0][1], masterPoints[0][2] || 0]);
        segPts = [anchorCoords, [target.coords.lat, target.coords.lng, target.dtMs ?? 0]];
        matchDistance = win.closestDist;
        method = 'incremental-synthetic';
      }

      // Transport mode resolution (mirrors full mode)
      let segTransportMode = 'driving';
      if (target.delivery.is_cycling_marker) {
        const notes = String(target.delivery.delivery_notes || '').toLowerCase();
        if (notes.includes('end')) segTransportMode = 'cycling';
      } else if (String(target.delivery.transport_mode || '').toLowerCase() === 'cycling') {
        segTransportMode = 'cycling';
      }

      // ── Write ONLY the target segment ──────────────────────────────────────
      let existing = null;
      const dupIds = [];
      const seen = new Set();
      for (const rec of (existingAll || [])) {
        if (Number(rec.stop_order) === stopOrder) {
          if (!existing || (rec.saved_to_route === true && existing.saved_to_route !== true)) {
            if (existing) dupIds.push(existing.id);
            existing = rec;
          } else {
            dupIds.push(rec.id);
          }
          seen.add(rec.id);
        }
      }
      for (const id of dupIds) {
        await base44.asServiceRole.entities.DeliveryBreadcrumbs.delete(id).catch(() => null);
      }

      // Respect manual saves — a saved_to_route leg is never auto-overwritten
      if (existing?.saved_to_route === true) {
        console.log(`⏭️ [consolidateBreadcrumbSegment] Incremental: stop #${stopOrder} already saved_to_route — skipping write`);
        return Response.json({
          success: true,
          segments: [{ stop_order: stopOrder, skipped: true }],
          total_segments: 1,
          master_point_count: masterPoints.length,
          driver_id,
          delivery_date,
        });
      }

      const segEncoded = encodePolyline(segPts.map((p) => [p[0], p[1]]));
      const segTimestamps = segPts.map((p) => p[2] || 0).join(',');
      const payload = {
        driver_id,
        delivery_date,
        stop_order: stopOrder,
        encoded_polyline: segEncoded,
        timestamps: segTimestamps,
        transport_mode: segTransportMode,
        point_count: segPts.length,
        saved_to_route: false,
      };

      if (existing?.id) {
        await base44.asServiceRole.entities.DeliveryBreadcrumbs.update(existing.id, payload);
      } else {
        await base44.asServiceRole.entities.DeliveryBreadcrumbs.create(payload);
      }

      console.log(`✅ [consolidateBreadcrumbSegment] Incremental cut stop #${stopOrder}: ${segPts.length} pts (${method}, ${Math.round(matchDistance || 0)}m)`);

      return Response.json({
        success: true,
        segments: [{
          stop_order: stopOrder,
          delivery_id: target.delivery.delivery_id || target.delivery.id,
          point_count: segPts.length,
          match_distance_m: Math.round(matchDistance || 0),
          method,
          has_polyline: !!segEncoded,
        }],
        total_segments: 1,
        master_point_count: masterPoints.length,
        driver_id,
        delivery_date,
      });
    }

    // ═════════════════════════════════════════════════════════════════════════
    // 6b. FULL MODE — sequential home-anchored walk through every stop
    // ═════════════════════════════════════════════════════════════════════════
    const segments = [];
    {
      // ── Home anchor ────────────────────────────────────────────────────────
      let homePrepend = null;   // synthetic home point prepended to stop 1's leg
      let cursor = 0;           // first crumb index of the current leg (inclusive)
      let boundaryIdx = -1;     // last crumb index of the previous leg
      let boundaryCoords = null;

      if (homeCoords) {
        // Bound the home scan at the first crumb within 50m of stop 1, so an
        // end-of-day return home can never be mistaken for the route start.
        const firstStop = stopsWithCoords[0];
        const stop1Approach = firstIndexWithin(masterPoints, 0, firstStop.coords.lat, firstStop.coords.lng, MATCH_RADIUS_M);
        const homeBound = stop1Approach === -1 ? masterPoints.length : stop1Approach;
        let homeIdx = -1;
        let bestHomeDist = Infinity;
        for (let i = 0; i < homeBound; i++) {
          const d = haversineMeters(homeCoords.lat, homeCoords.lng, masterPoints[i][0], masterPoints[i][1]);
          if (d <= MATCH_RADIUS_M && d < bestHomeDist) { bestHomeDist = d; homeIdx = i; }
        }
        if (homeIdx !== -1) {
          cursor = homeIdx; // leg 1 starts AT the home crumb (pre-route crumbs dropped)
          console.log(`🍞 [consolidateBreadcrumbSegment] Home anchor: crumb idx ${homeIdx} (${Math.round(bestHomeDist)}m from home)`);
        } else if (masterPoints.length > 0) {
          const firstDist = haversineMeters(homeCoords.lat, homeCoords.lng, masterPoints[0][0], masterPoints[0][1]);
          if (firstDist > MATCH_RADIUS_M) {
            homePrepend = [homeCoords.lat, homeCoords.lng, masterPoints[0][2] || 0];
            console.log(`🍞 [consolidateBreadcrumbSegment] No home crumb within 50m — prepending synthetic home point (first crumb ${Math.round(firstDist)}m from home)`);
          }
        }
      }

      // ── Sequential walk ─────────────────────────────────────────────────────
      for (let s = 0; s < stopsWithCoords.length; s++) {
        const swc = stopsWithCoords[s];
        const stopLat = swc.coords.lat;
        const stopLng = swc.coords.lng;
        const stopOrder = Number(swc.delivery.stop_order);

        // Window bound: first crumb within 50m of the NEXT stop, scanned from
        // the current cursor. Makes drive-bys immune — a later pass near this
        // stop can never steal points, and an unvisited stop can never swallow
        // the legs of later stops.
        let windowEnd = masterPoints.length;
        if (s < stopsWithCoords.length - 1) {
          const next = stopsWithCoords[s + 1];
          const bound = firstIndexWithin(masterPoints, cursor, next.coords.lat, next.coords.lng, MATCH_RADIUS_M);
          if (bound !== -1 && bound > cursor) windowEnd = bound;
        }

        const win = scanWindow(masterPoints, cursor, windowEnd, stopLat, stopLng, swc.dtMs);

        let pts;
        let matchDistance;
        let method;
        let synthetic = false;

        if (win.qualifierIdx !== null) {
          pts = masterPoints.slice(cursor, win.qualifierIdx + 1).map((p) => [p[0], p[1], p[2] || 0]);
          if (s === 0 && homePrepend) pts.unshift(homePrepend);
          matchDistance = win.qualifierDist;
          method = win.qualifierDist <= MATCH_RADIUS_M ? 'proximity-50m' : 'time-2min';
          boundaryIdx = win.qualifierIdx;
          boundaryCoords = [masterPoints[win.qualifierIdx][0], masterPoints[win.qualifierIdx][1]];
          cursor = win.qualifierIdx + 1;
        } else if (win.closestIdx !== null && win.closestDist <= NEAR_MISS_MAX_M) {
          // Near miss: trail got close but never within 50m / ±2min — cut up to
          // the closest approach and append the stop coords as the leg anchor.
          pts = masterPoints.slice(cursor, win.closestIdx + 1).map((p) => [p[0], p[1], p[2] || 0]);
          if (s === 0 && homePrepend) pts.unshift(homePrepend);
          pts.push([stopLat, stopLng, swc.dtMs ?? 0]);
          matchDistance = win.closestDist;
          method = 'near-miss-anchor';
          boundaryIdx = win.closestIdx;
          boundaryCoords = [stopLat, stopLng];
          cursor = win.closestIdx + 1;
        } else {
          // Far miss (skipped/failed stop) — straight 2-point line from the
          // previous boundary to the stop. Cursor UNCHANGED: the trail between
          // the boundary and the next stop belongs to the next leg.
          const anchor = boundaryCoords
            ? [boundaryCoords[0], boundaryCoords[1], 0]
            : (s === 0 && homePrepend
              ? [homePrepend[0], homePrepend[1], homePrepend[2]]
              : [masterPoints[cursor][0], masterPoints[cursor][1], masterPoints[cursor][2] || 0]);
          pts = [anchor, [stopLat, stopLng, swc.dtMs ?? 0]];
          matchDistance = win.closestDist;
          method = 'far-miss-synthetic';
          synthetic = true;
        }

        segments.push({ delivery: swc.delivery, stopOrder, points: pts, pointCount: pts.length, matchDistance, method, synthetic });
      }
    }

    const syntheticCount = segments.filter(s => s.synthetic).length;
    console.log(`🍞 [consolidateBreadcrumbSegment] Sliced ${segments.length} segments (${syntheticCount} synthetic): ${segments.map(s => `#${s.stopOrder}:${s.pointCount}pts:${s.method}`).join(', ')}`);

    // ── PREVIEW MODE ─────────────────────────────────────────────────────────
    if (preview_only) {
      const existingSegs = await base44.asServiceRole.entities.DeliveryBreadcrumbs.filter({
        driver_id,
        delivery_date,
      }).catch(() => []);
      const currentByStop = new Map();
      for (const rec of (existingSegs || [])) {
        if (rec && rec.stop_order != null && rec.stop_order !== -1) {
          currentByStop.set(Number(rec.stop_order), rec.point_count ?? 0);
        }
      }
      const preview = segments.map((seg) => {
        const so = Number(seg.delivery.stop_order);
        return {
          stop_order: so,
          delivery_id: seg.delivery.delivery_id || seg.delivery.id,
          projected_point_count: seg.pointCount,
          current_point_count: currentByStop.has(so) ? currentByStop.get(so) : null,
          match_distance_m: Math.round(seg.matchDistance),
          method: seg.method,
        };
      });
      return Response.json({
        success: true,
        preview_only: true,
        driver_id,
        delivery_date,
        master_point_count: masterPoints.length,
        segments: preview,
      });
    }

    // ── 7. Save each segment to DeliveryBreadcrumbs ────────────────────────────
    const existingSegments = await base44.asServiceRole.entities.DeliveryBreadcrumbs.filter({
      driver_id,
      delivery_date
    }).catch(() => []);

    const existingByStopOrder = new Map();
    const duplicateCrumbIds = [];
    const seenStopOrders = new Set();
    for (const rec of (existingSegments || [])) {
      if (rec.stop_order !== -1) {
        const so = Number(rec.stop_order);
        if (seenStopOrders.has(so)) {
          const existing = existingByStopOrder.get(so);
          if (existing && existing.saved_to_route === true && rec.saved_to_route !== true) {
            duplicateCrumbIds.push(rec.id);
          } else if (existing && existing.saved_to_route !== true && rec.saved_to_route === true) {
            duplicateCrumbIds.push(existing.id);
            existingByStopOrder.set(so, rec);
          } else {
            duplicateCrumbIds.push(rec.id);
          }
        } else {
          seenStopOrders.add(so);
          existingByStopOrder.set(so, rec);
        }
      }
    }

    for (const dupId of duplicateCrumbIds) {
      console.log(`🗑️ [consolidateBreadcrumbSegment] Deleting duplicate breadcrumb record ${dupId}`);
      await base44.asServiceRole.entities.DeliveryBreadcrumbs.delete(dupId).catch(() => null);
    }

    const results = [];

    for (const seg of segments) {
      const stopOrder = Number(seg.delivery.stop_order);

      if (explicitlySelected && !selectedSet.has(stopOrder)) {
        continue;
      }

      const segCoords = seg.points.map(p => [p[0], p[1]]);
      const segEncoded = encodePolyline(segCoords);
      const segTimestamps = seg.points.map(p => p[2]).join(',');

      let segTransportMode = 'driving';
      if (seg.delivery.is_cycling_marker) {
        const notes = String(seg.delivery.delivery_notes || '').toLowerCase();
        if (notes.includes('end')) {
          segTransportMode = 'cycling';
        }
      } else if (String(seg.delivery.transport_mode || '').toLowerCase() === 'cycling') {
        segTransportMode = 'cycling';
      }

      const existing = existingByStopOrder.get(stopOrder);

      const preserveSavedToRoute = (explicitlySelected || force_replace) && existing?.saved_to_route === true;

      const payload = {
        driver_id,
        delivery_date,
        stop_order: stopOrder,
        encoded_polyline: segEncoded,
        timestamps: segTimestamps,
        transport_mode: segTransportMode,
        point_count: seg.pointCount,
        saved_to_route: preserveSavedToRoute ? true : false,
      };

      if (existing?.id) {
        existingByStopOrder.delete(stopOrder);
        if (!explicitlySelected && !force_replace && existing.saved_to_route === true) {
          console.log(`⏭️ [consolidateBreadcrumbSegment] Skipping stop #${stopOrder} — already saved_to_route`);
          results.push({
            stop_order: stopOrder,
            delivery_id: seg.delivery.delivery_id || seg.delivery.id,
            point_count: existing.point_count || 0,
            match_distance_m: Math.round(seg.matchDistance),
            has_polyline: !!existing.encoded_polyline,
            skipped: true,
          });
          continue;
        }
        await base44.asServiceRole.entities.DeliveryBreadcrumbs.update(existing.id, payload);
      } else {
        await base44.asServiceRole.entities.DeliveryBreadcrumbs.create(payload);
      }

      results.push({
        stop_order: stopOrder,
        delivery_id: seg.delivery.delivery_id || seg.delivery.id,
        point_count: seg.pointCount,
        match_distance_m: Math.round(seg.matchDistance),
        method: seg.method,
        has_polyline: !!segEncoded,
      });
    }

    // ── 8. Clean up orphaned segments for stops that no longer exist ──────────
    if (!explicitlySelected) {
      const validStopOrders = new Set(stops.map(d => Number(d.stop_order)));
      for (const [stopOrder, rec] of existingByStopOrder) {
        if (!validStopOrders.has(stopOrder)) {
          console.log(`🗑️ [consolidateBreadcrumbSegment] Deleting orphaned segment for stop_order=${stopOrder}`);
          await base44.asServiceRole.entities.DeliveryBreadcrumbs.delete(rec.id).catch(() => null);
        }
      }
    }

    console.log(`✅ [consolidateBreadcrumbSegment] Home-anchored slicing complete: ${results.length} segments saved, driver=${driver_id}, date=${delivery_date}`);

    return Response.json({
      success: true,
      segments: results,
      total_segments: results.length,
      master_point_count: masterPoints.length,
      unresolved_stops: stopsWithoutCoords.length,
      driver_id,
      delivery_date,
    });

  } catch (error) {
    console.error('❌ [consolidateBreadcrumbSegment] Error:', error?.message || error);
    return Response.json({ error: error?.message || 'Unknown error' }, { status: 500 });
  }
});
