/**
 * deviationTransferOnStart — Start TRANSFERS deviation points (owner directive
 * Nov 2 2026).
 *
 * "The start button should transfer the deviation points. This way the driver's
 * current route still deviates through the same points because he still
 * actually traveled."
 *
 * This SUPERSEDES the Oct 27 evening "START CLEARS WAYPOINTS" rule. When the
 * driver starts the next stop, the points recorded while driving toward the
 * previous next stop are part of the leg he ACTUALLY drove, so they ride onto
 * the newly started stop and the regenerated current leg bends back through
 * them instead of snapping to the theoretical line.
 *
 * Keeps the safety guards that made the transfer safe in the first place:
 *   • only points that sit closer to the NEW stop than to the leg origin are
 *     kept (points behind the driver would draw a zigzag / round trip),
 *   • merged with the started stop's own points, chronological, capped at 3
 *     (same cap as currentLegRegenerator / routePolylineGenerator),
 *   • the old holder is emptied — a point lives on exactly one leg.
 *
 * Coordinate resolution is the caller's job (it has patient/store maps); this
 * module only does the bookkeeping so both start paths are identical.
 */

export const DEVIATION_TRANSFER_CAP = 3;

const isValidPoint = (p) => p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng));

const tsOf = (p) => String(p?.timestamp || '');

const sortChrono = (list) => [...list].sort((a, b) => tsOf(a).localeCompare(tsOf(b)));

const haversineKmLocal = (lat1, lon1, lat2, lon2) => {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
};

/**
 * Work out the deviation_waypoints changes for a Start action.
 *
 * @param {object}   args
 * @param {Array}    args.deliveries      Route deliveries (or any iterable).
 * @param {string}   args.fromId          The previous next stop's delivery id.
 * @param {string}   args.toId            The newly started stop's delivery id.
 * @param {object=}  args.originPoint     { lat, lng } leg origin (driver GPS or last finished stop).
 * @param {object=}  args.toPoint         { lat, lng } of the started stop.
 * @returns {Map<string, Array>} deliveryId -> new deviation_waypoints
 *          (empty array = cleared). Empty Map = nothing changed.
 */
export function computeDeviationTransferOnStart({ deliveries, fromId, toId, originPoint = null, toPoint = null }) {
  const changes = new Map();
  if (!fromId || !toId || fromId === toId) return changes;

  const list = Array.isArray(deliveries) ? deliveries : Array.from(deliveries || []);
  const fromStop = list.find((d) => d?.id === fromId) || null;
  const toStop = list.find((d) => d?.id === toId) || null;
  if (!toStop) return changes;

  const fromPts = (Array.isArray(fromStop?.deviation_waypoints) ? fromStop.deviation_waypoints : []).filter(isValidPoint);
  const toPts = (Array.isArray(toStop?.deviation_waypoints) ? toStop.deviation_waypoints : []).filter(isValidPoint);

  let movedPts = sortChrono(fromPts);

  // Behind-the-driver guard: a point closer to the leg origin than to the new
  // stop has already been passed — routing back through it draws a zigzag.
  if (originPoint && toPoint
    && Number.isFinite(Number(originPoint.lat)) && Number.isFinite(Number(originPoint.lng))
    && Number.isFinite(Number(toPoint.lat)) && Number.isFinite(Number(toPoint.lng))) {
    movedPts = movedPts.filter((pt) => {
      const dOrigin = haversineKmLocal(Number(originPoint.lat), Number(originPoint.lng), Number(pt.lat), Number(pt.lng));
      const dNext = haversineKmLocal(Number(toPoint.lat), Number(toPoint.lng), Number(pt.lat), Number(pt.lng));
      return dNext <= dOrigin;
    });
  }

  const merged = sortChrono([...toPts, ...movedPts]).slice(-DEVIATION_TRANSFER_CAP);

  if (fromPts.length === 0 && movedPts.length === 0) return changes; // nothing driven to carry
  if (fromPts.length > 0) changes.set(fromId, []);
  if (merged.length > 0 && JSON.stringify(merged) !== JSON.stringify(sortChrono(toPts))) {
    changes.set(toId, merged);
  }

  if (changes.size > 0) {
    console.log(`[deviationTransferOnStart] ${fromPts.length} point(s) from ${fromId} -> ${toId}: kept ${movedPts.length}, total ${merged.length}`);
  }
  return changes;
}

export default computeDeviationTransferOnStart;
