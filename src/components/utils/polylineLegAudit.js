// ── Orphaned polyline-leg audit (owner report Oct 29 2026) ───────────────────
// When a stop is moved to another driver or another date, the legs of its
// NEIGHBOURS on the source route are supposed to be regenerated. In practice
// the map kept showing polylines running to the moved stop's address, and after
// a re-optimization they came BACK: the stored leg on the stop that followed the
// moved stop was never invalidated, so any writer/replay/refresh that re-sent
// that record restored the old geometry.
//
// A stored leg is only valid when it STARTS at its current predecessor. This
// audit decodes each active stop's stored `encoded_polyline`, compares its FIRST
// point with the stop that precedes it in the route, and reports every leg that
// is anchored somewhere else (i.e. still chained through the moved stop, or
// through any stop that is no longer the predecessor).
//
// The caller CLEARS those legs before optimizing, so stale geometry cannot be
// inherited by the engine's skip logic or restored by a later stale write.
//
// Leg 0 is never reported: its origin is the route start (driver home, store or
// a live GPS point), which changes for legitimate reasons.
//
// Cycling markers, InterStore stops and same-address stops are all resolved
// through the engine's own getDeliveryCoords, and the tolerance is deliberately
// loose (350 m) so a shared plaza / same-building pair is never flagged.

import { decodeGooglePolyline } from './routePolylineGenerator';

export const ORPHAN_TOLERANCE_KM = 0.35;

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

const kmBetween = (aLat, aLng, bLat, bLng) => {
  const rad = Math.PI / 180;
  const dLat = (Number(bLat) - Number(aLat)) * 111.32;
  const dLng = (Number(bLng) - Number(aLng)) * 111.32 * Math.max(Math.cos(Number(aLat) * rad), 0.01);
  return Math.hypot(dLat, dLng);
};

/**
 * @param {Array} deliveries          route-scoped deliveries (any order)
 * @param {Object} ctx                { patients, stores } local arrays
 * @returns {Array<{id, stopOrder, legStartKm}>} orphaned legs (empty = clean)
 */
export async function findOrphanedPolylineLegs(deliveries = [], { patients = [], stores = [] } = {}) {
  const list = Array.isArray(deliveries) ? deliveries.filter(Boolean) : [];
  if (list.length < 2) return [];

  let getDeliveryCoords;
  try {
    ({ getDeliveryCoords } = await import('./clientRouteEngine'));
  } catch (_) {
    return []; // engine unavailable — never block the caller
  }
  const patientMap = new Map((patients || []).map((p) => [p?.id, p]));
  const storeMap = new Map((stores || []).map((s) => [s?.id, s]));

  // Active stops only, in route order. Terminal stops keep their finished legs
  // (they are history, not a live chain).
  const ordered = list
    .filter((d) => !TERMINAL.has(d.status))
    .slice()
    .sort((a, b) => (Number(a.stop_order) || 0) - (Number(b.stop_order) || 0));

  const orphans = [];
  for (let i = 1; i < ordered.length; i++) {
    const stop = ordered[i];
    const prev = ordered[i - 1];
    if (typeof stop?.encoded_polyline !== 'string' || stop.encoded_polyline.length <= 10) continue;

    const anchor = getDeliveryCoords(prev, patientMap, storeMap);
    if (!anchor) continue;

    let first = null;
    try {
      const pts = decodeGooglePolyline(stop.encoded_polyline);
      if (Array.isArray(pts) && pts.length) first = pts[0];
    } catch (_) { continue; }
    if (!first || !Number.isFinite(Number(first[0])) || !Number.isFinite(Number(first[1]))) continue;

    const km = kmBetween(anchor.lat, anchor.lng, first[0], first[1]);
    if (km > ORPHAN_TOLERANCE_KM) {
      orphans.push({ id: stop.id, stopOrder: Number(stop.stop_order) || 0, legStartKm: Number(km.toFixed(3)) });
    }
  }
  return orphans;
}

/**
 * Clear the orphaned legs (geometry + stamp only — NEVER travel_dist, which is
 * the stop's own mileage record) for one route, silently.
 * @returns {Promise<number>} number of records cleared
 */
export async function clearOrphanedPolylineLegs({ deliveries = [], patients = [], stores = [], source = 'orphan_leg_audit' } = {}) {
  const orphans = await findOrphanedPolylineLegs(deliveries, { patients, stores });
  if (!orphans.length) return 0;

  console.log(`[${source}] clearing ${orphans.length} orphaned leg(s) (anchored at a stop that is no longer the predecessor):`,
    orphans.map((o) => `stop ${o.stopOrder} start ${o.legStartKm}km off`).join(', '));

  try {
    const { commitDeliveryUpdatesSilently, fireRouteCommitMarker } = await import('./routeCommitMarker');
    const updates = orphans.map((o) => ({
      id: o.id,
      data: {
        encoded_polyline: null,
        polyline_from_order: null,
        estimated_distance_km: null,
        estimated_duration_minutes: null,
      },
    }));
    await commitDeliveryUpdatesSilently(updates);
    try { await fireRouteCommitMarker(updates[0].id, updates.length); } catch (_) { /* marker is best-effort */ }
  } catch (err) {
    console.warn(`[${source}] orphan leg clear failed:`, err?.message || err);
  }

  // Mirror the clear into IDB so the local-first engine (and the map) stop
  // seeing the stale geometry immediately, before the optimization re-runs.
  try {
    const { offlineDB } = await import('./offlineDatabase');
    for (const o of orphans) {
      const existing = await offlineDB.getById(offlineDB.STORES.DELIVERIES, o.id).catch(() => null);
      if (existing) {
        await offlineDB.save(offlineDB.STORES.DELIVERIES, {
          ...existing,
          encoded_polyline: null,
          polyline_from_order: null,
          estimated_distance_km: null,
          estimated_duration_minutes: null,
        }).catch(() => {});
      }
    }
  } catch (_) { /* IDB shape differs — the server clear still applies */ }

  return orphans.length;
}
