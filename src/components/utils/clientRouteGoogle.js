// Google Directions API multi-stop route generator.
//
// Google's Directions REST endpoint does NOT support CORS, so it cannot be called
// directly from the browser. This module delegates to the backend function
// `getGoogleDirectionsPolyline`, which calls Google server-side and returns the
// same { sections, usedFallbackPolyline } shape as getMultiStopRouteHere.
//
// Each section: { encoded_polyline, estimated_distance_km, estimated_duration_minutes, transport_mode }.
// One section per leg (points.length - 1), matching getMultiStopRouteHere's shape.

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

function encodePolylineValue(value) {
  let v = value < 0 ? (-value * 2 - 1) : (value * 2);
  let result = '';
  while (v >= 0x20) {
    result += String.fromCharCode((0x20 + (v % 0x20)) + 63);
    v = Math.floor(v / 0x20);
  }
  result += String.fromCharCode(v + 63);
  return result;
}

function encodeGooglePolyline(points) {
  let lastLat = 0, lastLng = 0, encoded = '';
  for (const [lat, lng] of points) {
    const latE5 = Math.round(lat * 1e5);
    const lngE5 = Math.round(lng * 1e5);
    encoded += encodePolylineValue(latE5 - lastLat);
    encoded += encodePolylineValue(lngE5 - lastLng);
    lastLat = latE5;
    lastLng = lngE5;
  }
  return encoded;
}

/**
 * @param {Array<{lat:number,lon:number}>} points
 * @param {string} transportMode 'driving'|'cycling'|'pedestrian'
 * @param {string} _googleApiKey UNUSED — the backend resolves the Google key server-side.
 * @param {{driverId?:string, userName?:string}} _opts unused (backend logs usage)
 */
// Short-lived in-memory cache: raw Google encoded_polyline → HERE-matched section.
// Avoids re-matching identical legs across frequent re-optimizations within a session.
const _hereMatchCache = new Map();
const HERE_MATCH_CACHE_MAX = 200;

export async function getMultiStopRouteGoogle(points, transportMode, _googleApiKey, _opts = {}) {
  const { mapMatchToHere = false } = _opts || {};
  const validPoints = (points || []).filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon));
  if (validPoints.length < 2) return { sections: [], usedFallbackPolyline: false };

  try {
    const res = await base44.functions.invoke('getGoogleDirectionsPolyline', {
      points: validPoints,
      transportMode,
    });
    const data = res?.data || res || {};
    let sections = Array.isArray(data.sections) ? data.sections : [];
    let usedFallbackPolyline = !!data.usedFallbackPolyline;

    // ── HERE map-matching ──────────────────────────────────────────────────
    // When map tiles are HERE and polylines are Google, re-snap each Google leg
    // onto HERE's road network so the drawn line aligns with the HERE tiles.
    // On any failure or mismatched result, the raw Google polylines are kept.
    if (mapMatchToHere && sections.length > 0) {
      try {
        const allCached = sections.every((s) => s?.encoded_polyline && _hereMatchCache.has(s.encoded_polyline));
        if (allCached) {
          sections = sections.map((s) => _hereMatchCache.get(s.encoded_polyline));
        } else {
          const matchRes = await base44.functions.invoke('matchPolylineToHere', {
            legs: sections.map((s) => ({
              encoded_polyline: s.encoded_polyline,
              transport_mode: s.transport_mode || transportMode || 'driving',
            })),
          });
          const matchData = matchRes?.data || matchRes || {};
          const matched = Array.isArray(matchData.sections) ? matchData.sections : [];
          if (matched.length === sections.length) {
            sections = sections.map((s, i) => {
              const m = matched[i];
              const merged = {
                encoded_polyline: m.encoded_polyline || s.encoded_polyline,
                estimated_distance_km: m.estimated_distance_km ?? s.estimated_distance_km ?? null,
                estimated_duration_minutes: m.estimated_duration_minutes ?? s.estimated_duration_minutes ?? null,
                transport_mode: m.transport_mode || s.transport_mode || transportMode || 'driving',
              };
              if (s.encoded_polyline && _hereMatchCache.size < HERE_MATCH_CACHE_MAX) {
                _hereMatchCache.set(s.encoded_polyline, merged);
              }
              return merged;
            });
            usedFallbackPolyline = usedFallbackPolyline || !!matchData.usedFallbackPolyline;
          } else {
            console.warn('[clientRouteGoogle] HERE map-match returned mismatched section count, keeping raw Google');
          }
        }
      } catch (err) {
        console.warn('[clientRouteGoogle] HERE map-match failed, keeping raw Google polylines:', err?.message || err);
      }
    }

    return { sections, usedFallbackPolyline };
  } catch (err) {
    console.warn('[clientRouteGoogle] backend Google Directions call failed, using local crow-flies:', err?.message || err);
    // Local crow-flies fallback so routing degrades gracefully if the backend call fails.
    const allSections = [];
    for (let i = 0; i < validPoints.length - 1; i++) {
      const from = validPoints[i], to = validPoints[i + 1];
      const d = calculateCrowFliesDistance(from.lat, from.lon, to.lat, to.lon);
      allSections.push({
        encoded_polyline: encodeGooglePolyline([[from.lat, from.lon], [to.lat, to.lon]]),
        estimated_distance_km: Number(d.toFixed(3)),
        estimated_duration_minutes: Math.ceil((d / 40) * 60),
        transport_mode: transportMode || 'driving',
      });
    }
    return { sections: allSections, usedFallbackPolyline: true };
  }
}