import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

// Lightweight Flexible Polyline decoder for HERE (returns array of {lat,lng})
function decodeFlexiblePolyline(encoded) {
  if (!encoded || typeof encoded !== 'string') return [];
  const DECODING_TABLE = (function () {
    const table = new Int32Array(128).fill(-1);
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    for (let i = 0; i < chars.length; i++) table[chars.charCodeAt(i)] = i;
    return table;
  })();

  const factorDegree = 1e5; // default precision 5
  let index = 0;
  const len = encoded.length;
  let lat = 0, lng = 0;
  const coords = [];

  function decodeUnsignedVarint() {
    let result = 0;
    let shift = 0;
    let byte = 0;
    do {
      if (index >= len) return null;
      byte = DECODING_TABLE[encoded.charCodeAt(index++)];
      if (byte < 0) return null;
      result |= byte << shift;
      shift += 6;
    } while (byte >= 0x20);
    return result;
  }

  function decodeSignedVarint() {
    const res = decodeUnsignedVarint();
    if (res === null) return null;
    const negative = res & 1;
    const shifted = res >> 1;
    return negative ? ~shifted : shifted;
  }

  while (index < len) {
    const deltaLat = decodeSignedVarint();
    const deltaLng = decodeSignedVarint();
    if (deltaLat === null || deltaLng === null) break;
    lat += deltaLat;
    lng += deltaLng;
    coords.push({ lat: lat / factorDegree, lng: lng / factorDegree });
  }

  return coords;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { origin, destination, transportMode = 'car' } = await req.json();
    if (!origin?.lat || !origin?.lon || !destination?.lat || !destination?.lon) {
      return Response.json({ error: 'Missing origin/destination coordinates' }, { status: 400 });
    }

    const apiKey = Deno.env.get('HERE_API_KEY');
    if (!apiKey) {
      return Response.json({ error: 'HERE_API_KEY not configured' }, { status: 500 });
    }

    const url = new URL('https://router.hereapi.com/v8/routes');
    url.searchParams.set('transportMode', transportMode);
    url.searchParams.set('origin', `${origin.lat},${origin.lon}`);
    url.searchParams.set('destination', `${destination.lat},${destination.lon}`);
    url.searchParams.set('return', 'polyline,summary');
    url.searchParams.set('routingMode', 'fast');
    url.searchParams.set('units', 'metric');
    url.searchParams.set('apiKey', apiKey);

    const res = await fetch(url.toString());
    if (!res.ok) {
      const text = await res.text();
      return Response.json({ error: 'HERE API error', details: text }, { status: res.status });
    }

    const data = await res.json();
    const route = data?.routes?.[0];
    const section = route?.sections?.[0];
    const poly = section?.polyline; // flexible polyline string
    const summary = section?.summary || route?.summary || {};

    const decoded = poly ? decodeFlexiblePolyline(poly) : [];
    const coordinates = decoded.map((p) => ({ lat: p.lat, lng: p.lng }));

    return Response.json({
      coordinates,
      distance_km: summary?.length ? summary.length / 1000 : null,
      duration_seconds: summary?.duration ?? null,
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});