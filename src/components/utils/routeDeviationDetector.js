/**
 * routeDeviationDetector — geometry + settings for GPS-triggered current-leg regen.
 * (Built Sep 14 2026 — this is the "route deviation detection" system that the
 * RouteOptimizationSettings admin panel has been promising since the Aug 29
 * removal of the crude 100m-movement refresh from locationTracker.)
 *
 * The trigger hook (useRouteDeviationMonitor.jsx) uses these helpers to measure
 * the driver's perpendicular distance from the NEXT in-flight stop's current-leg
 * polyline. When that distance exceeds the admin threshold (default 200m) and
 * the cooldown has elapsed, the hook fires performRouteOptimization with
 * preserveExistingOrder — the engine's live-GPS via-point (Sep 11) then bends
 * the regenerated current leg through the driver's actual position, and the
 * next stop's ETA/distance use the GPS→stop portion only.
 */
import { decodeGooglePolyline } from '@/components/utils/routePolylineGenerator';

// ── Settings (same storage the admin panel writes) ─────────────────────────
const SETTINGS_KEY = 'rxdeliver_route_optimization_settings';
export const DEFAULT_DEVIATION_SETTINGS = {
  enableRouteDeviationDetection: true,
  routeDeviationThresholdMeters: 200,
  routeDeviationCooldownMinutes: 5,
};

export function getDeviationSettings() {
  try {
    const stored = localStorage.getItem(SETTINGS_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      return { ...DEFAULT_DEVIATION_SETTINGS, ...parsed };
    }
  } catch (_) { /* corrupted settings — fall back to defaults */ }
  return { ...DEFAULT_DEVIATION_SETTINGS };
}

// ── Geometry ────────────────────────────────────────────────────────────────
// Equirectangular projection around the segment's own latitude — plenty
// accurate for ≤1 km deviation checks, and ~100x cheaper than haversine per
// segment (the polyline for a leg can be hundreds of points).

function pointToSegmentMeters(pLat, pLon, aLat, aLon, bLat, bLon) {
  const mPerDegLat = 111320;
  const mPerDegLon = 111320 * Math.cos((aLat * Math.PI) / 180);
  const px = pLon * mPerDegLon; const py = pLat * mPerDegLat;
  const ax = aLon * mPerDegLon; const ay = aLat * mPerDegLat;
  const bx = bLon * mPerDegLon; const by = bLat * mPerDegLat;
  const dx = bx - ax; const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = 0;
  if (lenSq > 0) {
    t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
  }
  const cx = ax + t * dx; const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/**
 * Minimum distance in METERS from a GPS point to a decoded polyline.
 * @param {number} lat
 * @param {number} lon
 * @param {[number, number][]} points — decoded polyline [[lat, lng], ...]
 * @returns {number} distance in meters (Infinity when the polyline is unusable)
 */
export function distanceToPolylineMeters(lat, lon, points) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Array.isArray(points) || points.length === 0) {
    return Infinity;
  }
  // Single-point "polyline": plain point-to-point distance.
  if (points.length === 1) {
    return pointToSegmentMeters(lat, lon, points[0][0], points[0][1], points[0][0], points[0][1]);
  }
  let min = Infinity;
  for (let i = 1; i < points.length; i++) {
    const d = pointToSegmentMeters(lat, lon, points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]);
    if (d < min) min = d;
  }
  return min;
}

/**
 * Decode a delivery's stored current-leg polyline (Google 1e5, arithmetic decoder
 * — no bitwise ops, per the 32-bit safety rule) and measure the driver's
 * distance from it. Returns Infinity on any unusable input so callers can
 * simply compare against the threshold.
 */
export function deviationFromDeliveryPolylineMeters(gpsLat, gpsLon, encodedPolyline) {
  if (!encodedPolyline || typeof encodedPolyline !== 'string') return Infinity;
  const points = decodeGooglePolyline(encodedPolyline);
  return distanceToPolylineMeters(gpsLat, gpsLon, points);
}
