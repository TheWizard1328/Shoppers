/**
 * LEG ANCHOR REPAIR (owner report Nov 27 2026)
 *
 * "When I click Start on the current stop the whole route optimizes the way I
 * expect, but the stop that WAS next still keeps its original polyline with the
 * originating point from the most recent finished stop — so both the started
 * stop and that stop originate from the same location, even though it is now
 * third in line instead of first."
 *
 * Root cause: both engines stamp a leg with `polyline_from_order` = the stop's
 * OWN stop_order. A run that re-sequences the route changes that stop's
 * stop_order, so the stamp no longer matches and the leg is supposed to be
 * regenerated — but when a run renumbers a stop and the polyline pass returns
 * no usable segment for it (group slicing, co-located handling, provider
 * hiccup), the OLD geometry survives: it is still anchored at the stop that
 * used to precede it. A stamp alone cannot catch that, because the geometry
 * anchor is what is wrong, not the order number.
 *
 * This module verifies the real thing: for every active stop, decode the first
 * point of its stored leg and compare it with the stop that now precedes it.
 * A leg anchored somewhere else is regenerated from the correct anchor and
 * patched into the optimization's writeBatch, so the map draws the route that
 * was just sequenced. Engine-agnostic: it runs after a server or client run.
 */

import { generateRoutePolylines, decodeGooglePolyline } from './routePolylineGenerator';
import { getDeliveryCoords } from './clientRouteEngine';

const ACTIVE_STATUSES = new Set(['pending', 'en_route', 'in_transit']);
const FINISHED_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const TOLERANCE_M = 300; // an anchor further than this from the real predecessor is wrong

const _toRad = (deg) => (Number(deg) * Math.PI) / 180;

function _distanceM(a, b) {
  if (!a || !b) return Infinity;
  const lat1 = Number(a.lat ?? a[0]);
  const lon1 = Number(a.lon ?? a.lng ?? a[1]);
  const lat2 = Number(b.lat ?? b[0]);
  const lon2 = Number(b.lon ?? b.lng ?? b[1]);
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return Infinity;
  const R = 6371000;
  const dLat = _toRad(lat2 - lat1);
  const dLon = _toRad(lon2 - lon1);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(_toRad(lat1)) * Math.cos(_toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * @returns {Promise<{ patches: Map<string, object>, misAnchored: string[], checked: number }>}
 */
export async function repairMisAnchoredLegs({
  deliveries = [],
  writeBatch = [],
  patients = [],
  stores = [],
  hereApiKey = null,
  polylineProvider = 'here',
  polylineApiKey = null,
  driverId = null,
  userName = null,
  source = 'optimizer',
  toleranceM = TOLERANCE_M,
} = {}) {
  const patches = new Map();
  const result = { patches, misAnchored: [], checked: 0 };
  if (!Array.isArray(deliveries) || deliveries.length === 0) return result;

  const patientMap = new Map((patients || []).filter((p) => p?.id).map((p) => [p.id, p]));
  const storeMap = new Map((stores || []).filter((s) => s?.id).map((s) => [s.id, s]));

  // Post-run view: the optimization's own writes win over the in-memory record.
  const patchById = new Map();
  (writeBatch || []).forEach((w) => { if (w?.id) patchById.set(w.id, w.data || {}); });
  const merged = deliveries.map((d) => ({
    ...d,
    ...(patchById.get(d.id) || {}),
    id: d.id,
  }));

  const coordsOf = (d) => {
    try { return getDeliveryCoords(d, patientMap, storeMap) || null; } catch (_) { return null; }
  };

  const active = merged
    .filter((d) => d && ACTIVE_STATUSES.has(String(d.status || '').toLowerCase()))
    .sort((a, b) => (Number(a.stop_order) || 99999) - (Number(b.stop_order) || 99999));
  if (active.length === 0) return result;

  // Polyline origin: the finished stop with the highest stop_order (the same
  // rule the engines and the generator use for the chain's start).
  const finishedOrigin = merged
    .filter((d) => d && FINISHED_STATUSES.has(String(d.status || '').toLowerCase()))
    .sort((a, b) => (Number(b.stop_order) || 0) - (Number(a.stop_order) || 0))
    .map((d) => coordsOf(d))
    .find(Boolean) || null;

  const repairs = [];
  for (let i = 0; i < active.length; i++) {
    const stop = active[i];
    const expectedAnchor = i > 0 ? coordsOf(active[i - 1]) : finishedOrigin;
    if (!expectedAnchor) continue;
    const enc = stop.encoded_polyline;
    if (typeof enc !== 'string' || enc.length <= 10) continue; // no leg to mis-anchor
    let firstPoint = null;
    try {
      const pts = decodeGooglePolyline(enc);
      firstPoint = Array.isArray(pts) && pts.length > 0 ? pts[0] : null;
    } catch (_) { firstPoint = null; }
    if (!firstPoint) continue;
    result.checked += 1;
    const gap = _distanceM({ lat: firstPoint[0], lon: firstPoint[1] }, expectedAnchor);
    if (gap > toleranceM) {
      repairs.push({ stop, expectedAnchor, gap });
      result.misAnchored.push(stop.id);
    }
  }

  if (repairs.length === 0) return result;
  console.warn(`[LegAnchorRepair] ${source} — ${repairs.length} leg(s) anchored at the wrong stop: ${result.misAnchored.join(', ')}`);

  for (const { stop, expectedAnchor, gap } of repairs) {
    const stopCoords = coordsOf(stop);
    if (!stopCoords) continue;
    try {
      const map = await generateRoutePolylines({
        stops: [{ delivery: stop, lat: stopCoords.lat, lng: stopCoords.lon ?? stopCoords.lng }],
        originPoint: { lat: expectedAnchor.lat, lon: expectedAnchor.lon ?? expectedAnchor.lng },
        hereApiKey,
        polylineProvider,
        polylineApiKey,
        driverId,
        userName,
        source: `${source}_anchor_repair`,
        forceStopIds: [stop.id],
      });
      const seg = map?.get?.(stop.id) || null;
      if (!seg?.encodedPolyline) {
        console.warn(`[LegAnchorRepair] ${source} — no replacement leg for stop ${stop.id} (anchor ${gap.toFixed(0)}m off) — existing leg left as is`);
        continue;
      }
      patches.set(stop.id, {
        encoded_polyline: seg.encodedPolyline,
        polyline_from_order: Number(stop.stop_order) || null,
        ...(Number.isFinite(Number(seg.estimatedDistanceKm)) ? { estimated_distance_km: Number(seg.estimatedDistanceKm) } : {}),
        ...(Number.isFinite(Number(seg.estimatedDurationMinutes)) ? { estimated_duration_minutes: Number(seg.estimatedDurationMinutes) } : {}),
        ...(seg.transportMode ? { transport_mode: seg.transportMode } : {}),
      });
      console.log(`[LegAnchorRepair] ${source} — re-anchored stop ${stop.id} (#${stop.stop_order}) from ${gap.toFixed(0)}m off to its real predecessor`);
    } catch (err) {
      console.warn(`[LegAnchorRepair] ${source} — re-anchor failed for stop ${stop.id}:`, err?.message || err);
    }
  }

  return result;
}
