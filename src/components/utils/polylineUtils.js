/**
 * polylineUtils.js — Shared polyline encode/decode utilities
 * 
 * Consolidates 12+ duplicate implementations across the codebase into one source of truth.
 * 
 * Precision: 1e5 (~1.1m at Edmonton latitude) — standard Google/HERE polyline format.
 * 
 * IMPORTANT: Uses pure arithmetic (no bitwise operators) to avoid 32-bit signed integer
 * overflow. The old bitwise encoder (`v << 1`) overflowed at 1e7 precision for |lng| > ~107°.
 * While 1e5 precision is safe for bitwise ops, we keep arithmetic for robustness and
 * consistency across all callers.
 */

export const POLY_PRECISION = 1e5;

/**
 * Encode a single coordinate value using zigzag encoding (arithmetic, no bitwise).
 * @param {number} value - lat or lng delta
 * @returns {string} encoded string chunk
 */
function encodePolylineValue(value) {
  let v = Math.round(value * POLY_PRECISION);
  // Zigzag encode using arithmetic: 0→0, -1→1, 1→2, -2→3, etc.
  v = v < 0 ? (-v * 2 - 1) : (v * 2);
  let result = '';
  while (v >= 0x20) {
    result += String.fromCharCode((0x20 + (v % 0x20)) + 63);
    v = Math.floor(v / 0x20);
  }
  result += String.fromCharCode(v + 63);
  return result;
}

/**
 * Encode an array of [lat, lng] points into a Google/HERE polyline string.
 * @param {Array<[number, number]>} points - array of [lat, lng] pairs
 * @returns {string} encoded polyline
 */
export function encodePolyline(points) {
  let prevLat = 0, prevLon = 0, result = '';
  for (const point of points) {
    result += encodePolylineValue(point[0] - prevLat);
    result += encodePolylineValue(point[1] - prevLon);
    prevLat = point[0];
    prevLon = point[1];
  }
  return result;
}

/**
 * Decode a Google/HERE polyline string into an array of [lat, lng] pairs.
 * @param {string} encoded - encoded polyline string
 * @returns {Array<[number, number]>} array of [lat, lng] pairs
 */
export function decodePolyline(encoded) {
  if (!encoded || typeof encoded !== 'string') return [];
  let index = 0, lat = 0, lng = 0;
  const coordinates = [];
  while (index < encoded.length) {
    let result = 0, shift = 0, next;
    do {
      next = encoded.charCodeAt(index++) - 63;
      result |= (next & 0x1f) << shift;
      shift += 5;
    } while (next >= 0x20);
    const dLat = (result & 1) ? ~(result >> 1) : (result >> 1);
    lat += dLat;

    result = 0; shift = 0;
    do {
      next = encoded.charCodeAt(index++) - 63;
      result |= (next & 0x1f) << shift;
      shift += 5;
    } while (next >= 0x20);
    const dLng = (result & 1) ? ~(result >> 1) : (result >> 1);
    lng += dLng;

    coordinates.push([lat / POLY_PRECISION, lng / POLY_PRECISION]);
  }
  return coordinates;
}

/**
 * Decode a polyline and return points as {lat, lng} objects (for Leaflet/React-Leaflet).
 * @param {string} encoded - encoded polyline string
 * @returns {Array<{lat: number, lng: number}>} array of {lat, lng} objects
 */
export function decodePolylineToLatLng(encoded) {
  return decodePolyline(encoded).map(([lat, lng]) => ({ lat, lng }));
}

/**
 * Detect corrupted polyline records from the old bitwise-overflow encoder.
 * Returns true if the record has valid latitude but near-zero longitude
 * (|lat| > 1 and |lng| < 0.01), which indicates the old 1e7 encoder zeroed the lng.
 * @param {Array<{lat: number, lng: number}>|Array<[number, number]>} points
 * @returns {boolean}
 */
export function isCorruptedPolyline(points) {
  if (!Array.isArray(points) || points.length === 0) return false;
  const sample = points[0];
  const lat = Array.isArray(sample) ? sample[0] : sample.lat;
  const lng = Array.isArray(sample) ? sample[1] : sample.lng;
  return Math.abs(lat) > 1 && Math.abs(lng) < 0.01;
}
