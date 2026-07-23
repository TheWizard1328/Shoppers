/* global Deno */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

// ═══════════════════════════════════════════════════════════════════════════════
// consolidateBreadcrumbSegment — Proximity-Based Breadcrumb Slicing
// ═══════════════════════════════════════════════════════════════════════════════
//
// Replaces the timestamp-based slicing with a proximity-matching algorithm.
// The master trail (stop_order = -1) is decoded into GPS points, then walked
// sequentially. For each stop (sorted by stop_order), the closest point in the
// trail is found — that's the slice boundary. Segments are the trail points
// between consecutive boundaries.
//
// This approach is immune to:
//   - Timestamp rounding (5-min first/last stop rounding no longer matters)
//   - Stop re-sequencing (we match by physical location, not time)
//   - Master trail edits (removing bad points doesn't shift time windows)
//   - Missing actual_delivery_time (we don't use it at all)
//
// All stop types are handled identically:
//   - Patient deliveries → patient.lat/lng
//   - Store pickups → store.lat/lng
//   - ISD (inter-store dropoff) → InterStoreLocation by assignedStorePhone in delivery_id
//   - ISP (inter-store pickup) → InterStoreLocation by pickupLocationPhone in delivery_id
//   - Cycling markers → cycling_latitude/cycling_longitude on the delivery
//
// Coordinate resolution mirrors the client-side resolveStopLocation() in
// deliveryTypeUtils.jsx.
//
// ═══════════════════════════════════════════════════════════════════════════════

// ── Polyline encode/decode (Google polyline format, 1e5 precision) ──────────
const POLY_PRECISION = 1e5;

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
// Returns { lat, lng } or null if unresolvable.
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
      delivery_id: _triggeredDeliveryId,  // optional, for logging only
      transport_mode = 'driving'
    } = body || {};

    if (!driver_id || !delivery_date) {
      return Response.json({ success: false, error: 'driver_id and delivery_date are required' }, { status: 400 });
    }

    console.log(`🍞 [consolidateBreadcrumbSegment] Proximity slicing for driver=${driver_id}, date=${delivery_date}${_triggeredDeliveryId ? `, triggered by ${_triggeredDeliveryId}` : ''}`);

    // ── 1. Read the master trail (stop_order = -1) ─────────────────────────────
    const masterRecords = await base44.asServiceRole.entities.DeliveryBreadcrumbs.filter({
      driver_id,
      delivery_date,
      stop_order: -1
    });

    const masterRecord = Array.isArray(masterRecords) && masterRecords.length > 0
      ? masterRecords[0]
      : null;

    if (!masterRecord?.encoded_polyline || !masterRecord?.timestamps) {
      return Response.json({
        success: false,
        error: 'No master breadcrumb trail found for this driver/date',
        driver_id,
        delivery_date,
        point_count: 0
      }, { status: 404 });
    }

    // Decode master trail into [lat, lng, timestamp] points
    const masterCoords = decodePolyline(masterRecord.encoded_polyline);
    const masterTsArr = masterRecord.timestamps.split(',').map(Number);
    const masterPoints = masterCoords
      .map((coord, i) => [coord[0], coord[1], masterTsArr[i] || 0])
      .filter((pt) =>
        Number.isFinite(pt[0]) && Number.isFinite(pt[1]) && Number.isFinite(pt[2]) &&
        !isCorruptedPoint(pt[0], pt[1])
      );

    if (masterPoints.length === 0) {
      return Response.json({ success: false, error: 'Master trail has no valid points', point_count: 0 }, { status: 500 });
    }

    console.log(`🍞 [consolidateBreadcrumbSegment] Master trail: ${masterPoints.length} points`);

    // ── 2. Fetch all deliveries for this driver/date, sorted by stop_order ────
    // Only slice COMPLETED stops — incomplete stops have no trail legs yet.
    const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'returned']);
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

    console.log(`🍞 [consolidateBreadcrumbSegment] ${stops.length} stops to slice`);

    // ── 3. Build lookup maps for coordinate resolution ────────────────────────
    // Collect all patient_ids and store_ids we need to resolve
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

    // Fetch InterStoreLocations and build phone→record map
    const phoneToInterStore = new Map();
    if (interStorePhones.size > 0) {
      const allInterStoreLocs = await base44.asServiceRole.entities.InterStoreLocation.list().catch(() => []);
      for (const loc of (allInterStoreLocs || [])) {
        const phone = stripPhone(loc.store_phone);
        if (phone) phoneToInterStore.set(phone, loc);
      }
    }

    // Fetch Patients and build id→record map
    const patientMap = new Map();
    if (patientIds.size > 0) {
      // Fetch all patients (filter API may not support bulk id lookup)
      const allPatients = await base44.asServiceRole.entities.Patient.list().catch(() => []);
      for (const p of (allPatients || [])) {
        if (patientIds.has(p.id)) patientMap.set(p.id, p);
      }
    }

    // Fetch Stores and build id→record map
    const storeMap = new Map();
    if (storeIds.size > 0) {
      const allStores = await base44.asServiceRole.entities.Store.list().catch(() => []);
      for (const s of (allStores || [])) {
        if (storeIds.has(s.id)) storeMap.set(s.id, s);
      }
    }

    // ── 4. Resolve coordinates for each stop ──────────────────────────────────
    const stopsWithCoords = [];
    const stopsWithoutCoords = [];

    for (const d of stops) {
      const coords = resolveDeliveryCoords(d, phoneToInterStore, patientMap, storeMap);
      if (coords) {
        stopsWithCoords.push({ delivery: d, coords });
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

    console.log(`🍞 [consolidateBreadcrumbSegment] ${stopsWithCoords.length}/${stops.length} stops resolved with coords`);

    // ── 5. Proximity matching — walk master trail sequentially ────────────────
    // For each stop (in stop_order), find the closest point in the trail.
    // The search starts from the cursor (index after the previous stop's match).
    // This prevents matching a future stop while the trail is still near a previous one.

    let cursor = 0; // search starts here for the next stop
    const sliceBoundaries = []; // [{ stopIndex, trailIndex, distance }]
    const PROXIMITY_THRESHOLD_M = 500; // log warning if closest point is farther than this
    const FIRST_MATCH_THRESHOLD_M = 80; // trigger threshold for first close-enough point
    // Local minimum parameters — after triggering, scan forward to find the ACTUAL
    // closest approach (handles road-passing → parking-lot-entry pattern)
    const LOOKAHEAD_POINTS = 200;    // max points to scan after trigger
    const LOOKAHEAD_TIME_MS = 180000; // max 3 minutes of trail time after trigger
    const EXIT_INCREASING_POINTS = 20; // exit if distance increases for this many consecutive points
    const EXIT_BUFFER_M = 50;         // exit immediately if distance exceeds local min + this buffer

    for (let s = 0; s < stopsWithCoords.length; s++) {
      const { coords } = stopsWithCoords[s];
      let globalMinIdx = cursor;
      let globalMinDist = Infinity;
      let triggerIdx = -1;
      let triggerDist = Infinity;

      // Phase 1: scan forward for the first point within FIRST_MATCH_THRESHOLD_M
      // (also track global minimum as fallback)
      for (let i = cursor; i < masterPoints.length; i++) {
        const dist = haversineMeters(coords.lat, coords.lng, masterPoints[i][0], masterPoints[i][1]);
        if (dist < globalMinDist) {
          globalMinDist = dist;
          globalMinIdx = i;
        }
        if (dist < FIRST_MATCH_THRESHOLD_M && triggerIdx === -1) {
          triggerIdx = i;
          triggerDist = dist;
          break; // found first close-enough point
        }
      }

      let useIdx, useDist;

      if (triggerIdx !== -1) {
        // Phase 2: from trigger, scan forward to find local minimum
        // (the actual closest approach — handles driver passing on road then
        //  entering parking lot where even closer points appear further ahead)
        useIdx = triggerIdx;
        useDist = triggerDist;
        let pointsPastMin = 0;
        const triggerTime = masterPoints[triggerIdx][2];

        for (let i = triggerIdx + 1; i < Math.min(triggerIdx + LOOKAHEAD_POINTS, masterPoints.length); i++) {
          const dist = haversineMeters(coords.lat, coords.lng, masterPoints[i][0], masterPoints[i][1]);
          const timeDiff = masterPoints[i][2] - triggerTime;

          if (timeDiff > LOOKAHEAD_TIME_MS) break; // too far in time

          if (dist < useDist) {
            // Found a closer point — update local minimum
            useDist = dist;
            useIdx = i;
            pointsPastMin = 0;
          } else {
            pointsPastMin++;
          }

          // Exit conditions: driver has passed the closest approach
          if (pointsPastMin > EXIT_INCREASING_POINTS) break;
          if (dist > useDist + EXIT_BUFFER_M) break;
        }
      } else {
        // No trigger found — fall back to global minimum
        useIdx = globalMinIdx;
        useDist = globalMinDist;
      }

      if (useDist > PROXIMITY_THRESHOLD_M) {
        console.log(`⚠️ [consolidateBreadcrumbSegment] Stop #${stopsWithCoords[s].delivery.stop_order}: closest point is ${Math.round(useDist)}m away (threshold: ${PROXIMITY_THRESHOLD_M}m)`);
      }

      sliceBoundaries.push({
        stopIndex: s,
        trailIndex: useIdx,
        distance: useDist,
        stopOrder: stopsWithCoords[s].delivery.stop_order,
      });

      // Advance cursor past this match for the next stop search
      cursor = useIdx + 1;

      // If cursor is past the end of the trail, remaining stops get empty segments
      if (cursor >= masterPoints.length) {
        console.log(`🍞 [consolidateBreadcrumbSegment] Trail exhausted at stop #${stopsWithCoords[s].delivery.stop_order}. Remaining ${stopsWithCoords.length - s - 1} stops will get 0-point segments.`);
        // Fill remaining stops with empty boundaries
        for (let r = s + 1; r < stopsWithCoords.length; r++) {
          sliceBoundaries.push({
            stopIndex: r,
            trailIndex: masterPoints.length - 1,
            distance: Infinity,
            stopOrder: stopsWithCoords[r].delivery.stop_order,
          });
        }
        break;
      }
    }

    // ── 6. Slice segments between consecutive boundaries ──────────────────────
    const segments = [];
    for (let s = 0; s < sliceBoundaries.length; s++) {
      const startIdx = s === 0 ? 0 : sliceBoundaries[s - 1].trailIndex;
      const endIdx = sliceBoundaries[s].trailIndex;

      // Segment points: from just after the previous boundary to this boundary (inclusive)
      const segStart = s === 0 ? startIdx : startIdx + 1;
      const segEnd = endIdx;
      const segPoints = segStart <= segEnd
        ? masterPoints.slice(segStart, segEnd + 1)
        : [];

      segments.push({
        delivery: stopsWithCoords[s].delivery,
        stopOrder: stopsWithCoords[s].delivery.stop_order,
        points: segPoints,
        pointCount: segPoints.length,
        matchDistance: sliceBoundaries[s].distance,
      });
    }

    console.log(`🍞 [consolidateBreadcrumbSegment] Sliced ${segments.length} segments: ${segments.map(s => `#${s.stopOrder}:${s.pointCount}pts`).join(', ')}`);

    // ── 7. Save each segment to DeliveryBreadcrumbs ────────────────────────────
    // Fetch existing segments for this driver/date (all stop_orders except -1)
    const existingSegments = await base44.asServiceRole.entities.DeliveryBreadcrumbs.filter({
      driver_id,
      delivery_date
    }).catch(() => []);

    // Build map: stop_order → existing record
    const existingByStopOrder = new Map();
    for (const rec of (existingSegments || [])) {
      if (rec.stop_order !== -1) {
        existingByStopOrder.set(Number(rec.stop_order), rec);
      }
    }

    const results = [];

    for (const seg of segments) {
      const stopOrder = Number(seg.delivery.stop_order);
      const segCoords = seg.points.map(p => [p[0], p[1]]);
      const segEncoded = encodePolyline(segCoords);
      const segTimestamps = seg.points.map(p => p[2]).join(',');

      // Determine transport mode from the delivery
      let segTransportMode = 'driving';
      if (seg.delivery.is_cycling_marker) {
        // Cycling start marker → the leg TO this marker is driving
        // Cycling end marker → the leg TO this marker is cycling
        const notes = String(seg.delivery.delivery_notes || '').toLowerCase();
        if (notes.includes('end')) {
          segTransportMode = 'cycling';
        }
      } else if (seg.delivery.preferred_travel_mode === 'cycling') {
        segTransportMode = 'cycling';
      }

      const payload = {
        driver_id,
        delivery_date,
        stop_order: stopOrder,
        encoded_polyline: segEncoded,
        timestamps: segTimestamps,
        transport_mode: segTransportMode,
        point_count: seg.pointCount,
        saved_to_route: false,
      };

      const existing = existingByStopOrder.get(stopOrder);
      let savedRecord;
      if (existing?.id) {
        savedRecord = await base44.asServiceRole.entities.DeliveryBreadcrumbs.update(existing.id, payload);
        existingByStopOrder.delete(stopOrder); // mark as handled
      } else {
        savedRecord = await base44.asServiceRole.entities.DeliveryBreadcrumbs.create(payload);
      }

      results.push({
        stop_order: stopOrder,
        delivery_id: seg.delivery.delivery_id || seg.delivery.id,
        point_count: seg.pointCount,
        match_distance_m: Math.round(seg.matchDistance),
        has_polyline: !!segEncoded,
      });
    }

    // ── 8. Clean up orphaned segments for stops that no longer exist ──────────
    // (e.g., deliveries were deleted or re-assigned to a different date)
    const validStopOrders = new Set(stops.map(d => Number(d.stop_order)));
    for (const [stopOrder, rec] of existingByStopOrder) {
      if (!validStopOrders.has(stopOrder)) {
        console.log(`🗑️ [consolidateBreadcrumbSegment] Deleting orphaned segment for stop_order=${stopOrder}`);
        await base44.asServiceRole.entities.DeliveryBreadcrumbs.delete(rec.id).catch(() => null);
      }
    }

    console.log(`✅ [consolidateBreadcrumbSegment] Proximity slicing complete: ${segments.length} segments saved, driver=${driver_id}, date=${delivery_date}`);

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
