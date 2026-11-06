/**
 * remainingPolylineDistance — road distance still to drive to the next stop.
 *
 * OWNER REQUEST (Nov 5 2026): the immersive top panel's distance badge used a
 * crow-flies (haversine) distance, so a driver heading north/south along a
 * road could watch the number grow while actually getting closer. Reported:
 * "my nav system is showing 15 km but the badge is showing only 10 km".
 *
 * This reads the leg polyline that is ALREADY stored on the stop
 * (`encoded_polyline` — the planned leg into that stop), decodes it locally,
 * projects the driver's GPS onto the nearest segment, and sums the remaining
 * segment lengths. No API call, no recalculation loop: it is pure arithmetic
 * over cached geometry, cheap enough to run on every GPS tick.
 *
 * Fallbacks, in order:
 *   1. no usable polyline (pending stops have none, cycling markers may be
 *      coordinates only) → caller's crow-flies value is returned untouched.
 *   2. driver is far OFF the line (real deviation) → the perpendicular offset
 *      is ADDED to the remaining distance, so leaving the route can never read
 *      as progress.
 */

import { haversineKm } from './geoUtils';
import { decodeGooglePolyline } from './dynamicPolylineManager';

// Docs: purely local projection — no network.
const OFF_ROUTE_ADD_METERS = 120; // below this the offset is GPS noise

/**
 * @param {Object} delivery      stop record carrying the leg polyline
 * @param {number} driverLat
 * @param {number} driverLon
 * @param {number|null} fallbackKm  crow-flies value when no polyline exists
 * @returns {number|null} remaining road km, or fallbackKm
 */
export function remainingPolylineDistanceKm(delivery, driverLat, driverLon, fallbackKm = null) {
  const lat0 = Number(driverLat);
  const lon0 = Number(driverLon);
  if (!Number.isFinite(lat0) || !Number.isFinite(lon0)) return fallbackKm;
  if (!delivery) return fallbackKm;

  const encoded = delivery.encoded_polyline || delivery.polyline || delivery.finished_leg_encoded_polyline || null;
  if (!encoded || typeof encoded !== 'string') return fallbackKm;

  let coords = null;
  try {
    coords = decodeGooglePolyline(encoded);
  } catch (_) {
    return fallbackKm;
  }
  if (!Array.isArray(coords) || coords.length < 2) return fallbackKm;

  // Normalize to [lat, lon] pairs.
  const pts = coords
    .map((c) => (Array.isArray(c) ? { lat: Number(c[0]), lon: Number(c[1]) } : null))
    .filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon));
  if (pts.length < 2) return fallbackKm;

  // Segment lengths + running total.
  const segLen = new Array(pts.length - 1).fill(0);
  let total = 0;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const d = haversineKm(pts[i].lat, pts[i].lon, pts[i + 1].lat, pts[i + 1].lon);
    segLen[i] = d;
    total += d;
  }

  // Local flat projection around the driver (metres) — accurate at these scales.
  const mPerDegLat = 111320;
  const mPerDegLon = 111320 * Math.cos((lat0 * Math.PI) / 180) || 1;
  const toXY = (lat, lon) => ({ x: (lon - lon0) * mPerDegLon, y: (lat - lat0) * mPerDegLat });

  let bestDist = Infinity;
  let bestSeg = 0;
  let bestT = 0;
  let bestOffset = Infinity;

  for (let i = 0; i < pts.length - 1; i += 1) {
    const a = toXY(pts[i].lat, pts[i].lon);
    const b = toXY(pts[i + 1].lat, pts[i + 1].lon);
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const lenSq = vx * vx + vy * vy;
    let t = 0;
    if (lenSq > 0) {
      t = -((a.x * vx) + (a.y * vy)) / lenSq; // driver is origin (0,0)
      t = Math.max(0, Math.min(1, t));
    }
    const px = a.x + t * vx;
    const py = a.y + t * vy;
    const d = Math.hypot(px, py); // distance from driver to the closest point
    if (d < bestDist) {
      bestDist = d;
      bestSeg = i;
      bestT = t;
      bestOffset = d;
    }
  }

  // Remaining along the line: the rest of the matched segment + every later one.
  let remaining = segLen[bestSeg] * (1 - bestT);
  for (let i = bestSeg + 1; i < segLen.length; i += 1) remaining += segLen[i];

  if (remaining > total) remaining = total;
  if (bestOffset > OFF_ROUTE_ADD_METERS) remaining += bestOffset / 1000;

  return remaining;
}

export default remainingPolylineDistanceKm;
