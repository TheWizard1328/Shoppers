/**
 * FULL ACTIVE-SET REPOLYLINE (owner rule, Nov 27 2026)
 *
 * "When the polyline generator runs after a route optimization it's the entire
 * active set of stops that need to get re-polylined completely. We're not trying
 * to save time by deciding whether a leg changed. Polyline everything from the
 * origin point of the most recent finished stop all the way through to the last
 * stop in the order the sequencer generated, including the current stop's
 * deviation points and the driver's current location if he is not at a stop.
 * It's that simple."
 *
 * So this module has NO staleness detection, NO stamp comparison and NO leg
 * reuse. It takes the sequenced order, chains the whole active set from the
 * finished origin in ONE generator call, and returns a fresh leg for every
 * active stop. The coordinator merges the result straight into the
 * optimization's writeBatch, so what the map draws is exactly the route that
 * was just sequenced.
 */

import { encodeGooglePolyline } from './routePolylineGenerator';
import { buildSequentialLegs } from './sequentialPolylineBuilder';
import { getDeliveryCoords } from './clientRouteEngine';

const ACTIVE_STATUSES = new Set(['pending', 'en_route', 'in_transit']);
const FINISHED_STATUSES = new Set(['completed', 'failed', 'cancelled']);

/**
 * @returns {Promise<{ patches: Map<string, object>, stops: number, legs: number }>}
 */
export async function repolylineActiveRoute({
  deliveries = [],
  writeBatch = [],
  patients = [],
  stores = [],
  appUsers = [],
  hereApiKey = null,
  polylineProvider = 'here',
  polylineApiKey = null,
  driverId = null,
  userName = null,
  currentLocation = null,
  source = 'optimizer',
} = {}) {
  const patches = new Map();
  const out = { patches, stops: 0, legs: 0 };
  if (!Array.isArray(deliveries) || deliveries.length === 0) return out;

  const patientMap = new Map((patients || []).filter((p) => p?.id).map((p) => [p.id, p]));
  const storeMap = new Map((stores || []).filter((s) => s?.id).map((s) => [s.id, s]));

  // Post-run view: the optimization's own writes win over the in-memory record.
  const patchById = new Map();
  (writeBatch || []).forEach((w) => { if (w?.id) patchById.set(w.id, w.data || {}); });
  const merged = deliveries.map((d) => ({ ...d, ...(patchById.get(d.id) || {}), id: d.id }));

  const coordsOf = (d) => {
    try { return getDeliveryCoords(d, patientMap, storeMap) || null; } catch (_) { return null; }
  };

  // 1. The sequenced order — stop_order as the optimizer just wrote it.
  const active = merged
    .filter((d) => d && ACTIVE_STATUSES.has(String(d.status || '').toLowerCase()))
    .sort((a, b) => (Number(a.stop_order) || 99999) - (Number(b.stop_order) || 99999));
  if (active.length === 0) return out;
  out.stops = active.length;

  // 2. Origin: the most recent finished stop (highest stop_order among finished).
  const finishedOriginStop = merged
    .filter((d) => d && FINISHED_STATUSES.has(String(d.status || '').toLowerCase()) && coordsOf(d))
    .sort((a, b) => (Number(b.stop_order) || 0) - (Number(a.stop_order) || 0))[0] || null;
  const originPoint = finishedOriginStop ? coordsOf(finishedOriginStop) : null;

  // 3. The driver's live position rides on the first leg when he is not at a stop.
  //    The generator drops it itself when the driver already sits on the stop
  //    (shared 50 m rule), so no extra guessing here.
  let liveVia = null;
  if (currentLocation && Number.isFinite(Number(currentLocation.lat))) {
    liveVia = { lat: Number(currentLocation.lat), lon: Number(currentLocation.lng ?? currentLocation.lon) };
  } else {
    const rec = (appUsers || []).find((au) => String(au?.user_id || '') === String(driverId) || String(au?.id || '') === String(driverId)) || null;
    const lat = Number(rec?.current_latitude);
    const lng = Number(rec?.current_longitude);
    if (Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0) liveVia = { lat, lon: lng };
  }

  const chain = active
    .map((d) => {
      const c = coordsOf(d);
      if (!c) return null;
      return { delivery: d, lat: Number(c.lat), lng: Number(c.lon ?? c.lng) };
    })
    .filter(Boolean);
  if (chain.length === 0) return out;

  try {
    // OWNER INSTRUCTION (Nov 27 2026): "just build the polylines from the origin
    // to the destination with all the waypoints in between... there is only one
    // order the polylines should be generated in and that is the stop order
    // number for each stop." The sequential builder takes the order and returns
    // one leg per stop by position. No anchor rules, no pending rules, no
    // co-located rules, no reuse.
    const { legs } = await buildSequentialLegs({
      stops: chain.map((c) => ({
        id: c.delivery.id,
        lat: c.lat,
        lng: c.lng,
        stopOrder: Number(c.delivery.stop_order) || 0,
        transportMode: c.delivery.transport_mode || 'driving',
      })),
      // The driver's real position is the head of the chain; otherwise the most
      // recent finished stop is.
      origin: liveVia
        ? { lat: liveVia.lat, lon: liveVia.lon }
        : (originPoint ? { lat: Number(originPoint.lat), lon: Number(originPoint.lon ?? originPoint.lng) } : null),
      hereApiKey,
      driverId,
      userName,
      source,
    });

    let _fallbackCount = 0;
    for (let ci = 0; ci < chain.length; ci += 1) {
      const { delivery, lat, lng } = chain[ci];
      const seg = legs.get(delivery.id) || null;
      let encoded = seg?.encodedPolyline || null;
      if (!encoded) {
        const prev = ci > 0 ? chain[ci - 1] : null;
        const pLat = prev ? Number(prev.lat) : (liveVia ? liveVia.lat : Number(originPoint?.lat));
        const pLng = prev ? Number(prev.lng) : (liveVia ? liveVia.lon : Number(originPoint?.lon ?? originPoint?.lng));
        if ([pLat, pLng, Number(lat), Number(lng)].every(Number.isFinite)) {
          encoded = encodeGooglePolyline([[pLat, pLng], [Number(lat), Number(lng)]]);
          _fallbackCount += 1;
        }
      }
      if (!encoded) continue;
      patches.set(delivery.id, {
        encoded_polyline: encoded,
        polyline_from_order: Number(delivery.stop_order) || null,
        ...(Number.isFinite(Number(seg?.estimatedDistanceKm)) ? { estimated_distance_km: Number(seg.estimatedDistanceKm) } : {}),
        ...(Number.isFinite(Number(seg?.estimatedDurationMinutes)) ? { estimated_duration_minutes: Number(seg.estimatedDurationMinutes) } : {}),
        ...(seg?.transportMode ? { transport_mode: seg.transportMode } : {}),
      });
    }
    out.legs = patches.size;
    if (_fallbackCount > 0) {
      console.warn(`[FullRepolyline] ${source} — ${_fallbackCount} leg(s) had no provider section and were drawn straight from their real predecessor (stale legs replaced)`);
    }
    console.log(`[FullRepolyline] ${source} — ${out.legs}/${chain.length} active stop leg(s) redrawn from origin ${originPoint ? `${Number(originPoint.lat).toFixed(5)},${Number(originPoint.lon ?? originPoint.lng).toFixed(5)}` : 'none'}${liveVia ? ' + live GPS' : ''}`);
  } catch (err) {
    console.warn(`[FullRepolyline] ${source} — full active-set repolyline failed:`, err?.message || err);
  }

  return out;
}
