// Google Directions API multi-stop route generator.
// Extracted from clientRouteEngine.js to keep that file focused.
//
// Mirrors getMultiStopRouteHere's return shape: { sections[], usedFallbackPolyline }.
// Each section: { encoded_polyline, estimated_distance_km, estimated_duration_minutes, transport_mode }.

import { base44 } from '@/api/base44Client';

const calculateCrowFliesDistance = (lat1, lng1, lat2, lng2) => {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

function encodeSigned(value) {
  let signed = value << 1;
  if (value < 0) signed = ~signed;
  let encoded = '';
  while (signed >= 0x20) {
    encoded += String.fromCharCode((0x20 | (signed & 0x1f)) + 63);
    signed >>= 5;
  }
  encoded += String.fromCharCode(signed + 63);
  return encoded;
}

function encodeGooglePolyline(points) {
  let lastLat = 0, lastLng = 0, encoded = '';
  for (const [lat, lng] of points) {
    const latE5 = Math.round(lat * 1e5);
    const lngE5 = Math.round(lng * 1e5);
    encoded += encodeSigned(latE5 - lastLat);
    encoded += encodeSigned(lngE5 - lastLng);
    lastLat = latE5;
    lastLng = lngE5;
  }
  return encoded;
}

function decodeGooglePolyline(encoded) {
  if (!encoded || typeof encoded !== 'string') return [];
  let index = 0, lat = 0, lng = 0;
  const coordinates = [];
  while (index < encoded.length) {
    let result = 0, shift = 0, byte;
    do { byte = encoded.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    result = 0; shift = 0;
    do { byte = encoded.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    coordinates.push([lat / 1e5, lng / 1e5]);
  }
  return coordinates;
}

async function logGoogleDirectionsCall({ driverId, userName }) {
  try {
    await base44.entities.GoogleAPILog.create({
      timestamp: new Date().toISOString(),
      api_type: 'Directions',
      purpose: 'Polyline generation (Google Directions)',
      function_name: 'clientRouteEngine',
      user_id: driverId || null,
      user_name: userName || null,
      metadata: { provider: 'google', source: 'client', call_count: 1 },
    });
  } catch { /* best-effort */ }
}

/**
 * @param {Array<{lat:number,lon:number}>} points
 * @param {string} transportMode 'driving'|'cycling'|'pedestrian'
 * @param {string} googleApiKey
 */
export async function getMultiStopRouteGoogle(points, transportMode, googleApiKey, { driverId = null, userName = null } = {}) {
  const validPoints = (points || []).filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon));
  if (validPoints.length < 2) return { sections: [], usedFallbackPolyline: false };

  const travelMode = transportMode === 'cycling' ? 'bicycling' : transportMode === 'pedestrian' ? 'walking' : 'driving';

  // Google Directions allows up to 25 points total (origin + 23 waypoints + destination).
  // Chunk overlapping at the boundary so legs stitch into a continuous polyline.
  const MAX_POINTS = 25;
  const chunks = [];
  if (validPoints.length <= MAX_POINTS) {
    chunks.push(validPoints);
  } else {
    let idx = 0;
    while (idx < validPoints.length - 1) {
      const end = Math.min(idx + MAX_POINTS, validPoints.length);
      chunks.push(validPoints.slice(idx, end));
      if (end >= validPoints.length) break;
      idx = end - 1; // overlap last point as next chunk origin
    }
  }

  const allSections = [];
  let anyFallback = false;

  for (const chunk of chunks) {
    if (chunk.length < 2) continue;
    const params = new URLSearchParams();
    params.set('origin', `${chunk[0].lat},${chunk[0].lon}`);
    params.set('destination', `${chunk[chunk.length - 1].lat},${chunk[chunk.length - 1].lon}`);
    params.set('key', googleApiKey);
    params.set('mode', travelMode);
    const wps = chunk.slice(1, -1).map((p) => `${p.lat},${p.lon}`);
    if (wps.length) params.set('waypoints', wps.join('|'));

    let routeData = null;
    let httpOk = false;
    try {
      const resp = await fetch(`https://maps.googleapis.com/maps/api/directions/json?${params.toString()}`, {
        signal: AbortSignal.timeout(20000), headers: { accept: 'application/json' }
      });
      httpOk = resp.ok;
      routeData = await resp.json().catch(() => null);
    } catch (err) {
      console.warn('[clientRouteGoogle] Google Directions fetch threw', err?.message || err);
    }
    logGoogleDirectionsCall({ driverId, userName }).catch(() => {});

    const legs = Array.isArray(routeData?.routes?.[0]?.legs) ? routeData.routes[0].legs : [];

    if (!httpOk || legs.length === 0) {
      console.warn('[clientRouteGoogle] Google Directions returned no legs', {
        status: routeData?.status, error: routeData?.error_message, pointsCount: chunk.length
      });
      for (let i = 0; i < chunk.length - 1; i++) {
        const from = chunk[i], to = chunk[i + 1];
        const d = calculateCrowFliesDistance(from.lat, from.lon, to.lat, to.lon);
        allSections.push({
          encoded_polyline: encodeGooglePolyline([[from.lat, from.lon], [to.lat, to.lon]]),
          estimated_distance_km: Number(d.toFixed(3)),
          estimated_duration_minutes: Math.ceil((d / 40) * 60),
          transport_mode: transportMode || 'driving'
        });
        anyFallback = true;
      }
      continue;
    }

    legs.forEach((leg) => {
      const coords = [];
      for (const step of (leg.steps || [])) {
        const s = decodeGooglePolyline(step?.polyline?.points);
        if (!s.length) continue;
        if (coords.length && coords[coords.length - 1][0] === s[0][0] && coords[coords.length - 1][1] === s[0][1]) {
          coords.push(...s.slice(1));
        } else {
          coords.push(...s);
        }
      }
      allSections.push({
        encoded_polyline: coords.length > 1 ? encodeGooglePolyline(coords) : null,
        estimated_distance_km: Number(leg?.distance?.value) ? Number((Number(leg.distance.value) / 1000).toFixed(3)) : null,
        estimated_duration_minutes: Number(leg?.duration?.value) ? Math.ceil(Number(leg.duration.value) / 60) : null,
        transport_mode: transportMode || 'driving'
      });
    });
  }

  return { sections: allSections, usedFallbackPolyline: anyFallback };
}