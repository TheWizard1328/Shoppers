// Diagnostic: extract gap coordinates from the master breadcrumb and test HERE routing
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function decodePolyline(encoded) {
  if (!encoded) return [];
  const poly = [];
  let index = 0, len = encoded.length, lat = 0, lng = 0;
  while (index < len) {
    let b, result = 0, multiplier = 1;
    do { b = encoded.charCodeAt(index++) - 63; result += (b % 32) * multiplier; multiplier *= 32; } while (b >= 0x20);
    lat += ((result % 2 !== 0) ? -((result + 1) / 2) : (result / 2));
    result = 0; multiplier = 1;
    do { b = encoded.charCodeAt(index++) - 63; result += (b % 32) * multiplier; multiplier *= 32; } while (b >= 0x20);
    lng += ((result % 2 !== 0) ? -((result + 1) / 2) : (result / 2));
    poly.push([lat / 1e5, lng / 1e5]);
  }
  return poly;
}

const HERE_ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const HERE_DECODE_MAP = {};
for (let i = 0; i < HERE_ALPHA.length; i++) HERE_DECODE_MAP[HERE_ALPHA[i]] = i;

function decodeHereFlexiblePolyline(encoded) {
  if (!encoded) return [];
  const values = [];
  let cur = 0, shift = 0;
  for (const ch of encoded) {
    const v = HERE_DECODE_MAP[ch];
    if (v == null) return [];
    cur += (v % 32) * (2 ** shift);
    if (v >= 32) { shift += 5; continue; }
    values.push(cur); cur = 0; shift = 0;
  }
  if (values.length < 2 || values[0] !== 1) return [];
  const precision = values[1] % 16;
  const third_dim = Math.floor(values[1] / 16) % 8;
  const factor = 10 ** precision;
  const dim = third_dim ? 3 : 2;
  const toSigned = (v) => (v % 2 !== 0) ? -((v + 1) / 2) : (v / 2);
  let latAcc = 0, lngAcc = 0;
  const coords = [];
  for (let i = 2; i < values.length; i += dim) {
    latAcc += toSigned(values[i]);
    lngAcc += toSigned(values[i + 1]);
    coords.push([latAcc / factor, lngAcc / factor]);
  }
  return coords;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { driver_id, delivery_date, gap_threshold_m = 500 } = body;

    const records = await base44.asServiceRole.entities.DeliveryBreadcrumbs.filter({
      driver_id, delivery_date, stop_order: -1,
    });
    const master = records?.[0];
    if (!master?.encoded_polyline) return Response.json({ error: 'No master' });

    const coords = decodePolyline(master.encoded_polyline);
    const tsArr = (master.timestamps || '').split(',').map(Number);

    // Find gaps
    const gaps = [];
    for (let i = 0; i < coords.length - 1; i++) {
      const d = haversineM(coords[i][0], coords[i][1], coords[i+1][0], coords[i+1][1]);
      if (d > gap_threshold_m) {
        gaps.push({ idx: i, dist: Math.round(d), p1: coords[i], p2: coords[i+1] });
      }
    }

    // For each gap, call HERE Router v8 directly
    const hereApiKey = await resolveFeatureApiKeySimple(base44);
    const gapDiagnostics = [];

    for (const gap of gaps.slice(0, 5)) {
      const fromLat = gap.p1[0], fromLon = gap.p1[1];
      const toLat = gap.p2[0], toLon = gap.p2[1];

      // Context: 3 points before and after
      const ctxBefore = [];
      for (let j = Math.max(0, gap.idx - 3); j < gap.idx; j++) {
        ctxBefore.push(coords[j]);
      }
      const ctxAfter = [];
      for (let j = gap.idx + 2; j < Math.min(coords.length, gap.idx + 5); j++) {
        ctxAfter.push(coords[j]);
      }

      const originPt = ctxBefore.length > 0 ? ctxBefore[ctxBefore.length - 1] : [fromLat, fromLon];
      const destPt = ctxAfter.length > 0 ? ctxAfter[0] : [toLat, toLon];

      const params = new URLSearchParams();
      params.set('apiKey', hereApiKey);
      params.set('transportMode', 'car');
      params.set('origin', `${originPt[0].toFixed(7)},${originPt[1].toFixed(7)}`);
      params.set('destination', `${destPt[0].toFixed(7)},${destPt[1].toFixed(7)}`);
      params.set('return', 'polyline,summary');
      params.append('via', `${fromLat.toFixed(7)},${fromLon.toFixed(7)}!passThrough=true`);
      params.append('via', `${toLat.toFixed(7)},${toLon.toFixed(7)}!passThrough=true`);

      const resp = await fetch(`https://router.hereapi.com/v8/routes?${params.toString()}`, {
        signal: AbortSignal.timeout(15000),
        headers: { accept: 'application/json' },
      });
      const data = await resp.json().catch(() => null);

      // Decode all sections
      const sections = data?.routes?.[0]?.sections ?? [];
      const allCoords = [];
      for (const section of sections) {
        const decoded = section?.polyline ? decodeHereFlexiblePolyline(section.polyline) : [];
        if (allCoords.length === 0) allCoords.push(...decoded);
        else allCoords.push(...decoded.slice(1));
      }

      // Check for gaps in the routed result
      const routedGaps = [];
      let maxSegment = 0;
      for (let i = 0; i < allCoords.length - 1; i++) {
        const d = haversineM(allCoords[i][0], allCoords[i][1], allCoords[i+1][0], allCoords[i+1][1]);
        if (d > maxSegment) maxSegment = d;
        if (d > gap_threshold_m) {
          routedGaps.push({ idx: i, dist: Math.round(d) });
        }
      }

      gapDiagnostics.push({
        gap_idx: gap.idx,
        gap_dist_m: gap.dist,
        from: [fromLat.toFixed(6), fromLon.toFixed(6)],
        to: [toLat.toFixed(6), toLon.toFixed(6)],
        origin: [originPt[0].toFixed(6), originPt[1].toFixed(6)],
        destination: [destPt[0].toFixed(6), destPt[1].toFixed(6)],
        here_status: resp.status,
        here_sections: sections.length,
        here_route_points: allCoords.length,
        routed_max_segment_m: Math.round(maxSegment),
        routed_gaps_over_threshold: routedGaps,
        first_5_routed_points: allCoords.slice(0, 5).map(p => [p[0].toFixed(6), p[1].toFixed(6)]),
        last_5_routed_points: allCoords.slice(-5).map(p => [p[0].toFixed(6), p[1].toFixed(6)]),
        here_error: data?.error_description || data?.error || null,
      });
    }

    return Response.json({
      success: true,
      master_id: master.id,
      is_snapped: master.is_snapped,
      total_points: coords.length,
      total_gaps: gaps.length,
      here_api_key_present: !!hereApiKey,
      gap_diagnostics: gapDiagnostics,
    });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
});
