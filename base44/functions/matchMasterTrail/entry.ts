// TEMPORARY READ-ONLY PROTOTYPE (owner approval Nov 10 2026).
// One HERE Route Matching call over a whole master breadcrumb trail. Writes nothing.
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const PREC_IN = 1e7;
const PREC_OUT = 1e5;
const KEY_NAMES = ['Here_API_Key_2', 'HERE_API_KEY', 'Here_API_Key_3', 'Here_API_Key'];

function decodePolyline(enc: string, precision = PREC_IN) {
  const pts: number[][] = [];
  let i = 0, lat = 0, lng = 0;
  while (i < enc.length) {
    for (let k = 0; k < 2; k++) {
      let shift = 0, result = 0, b = 0;
      do { b = enc.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (k === 0) lat += delta; else lng += delta;
    }
    pts.push([lat / precision, lng / precision]);
  }
  return pts;
}

function encodePolyline(pts: number[][], precision = PREC_OUT) {
  const enc = (v: number) => {
    let x = v < 0 ? ~(v << 1) : (v << 1);
    let s = '';
    while (x >= 0x20) { s += String.fromCharCode((0x20 | (x & 0x1f)) + 63); x >>= 5; }
    return s + String.fromCharCode(x + 63);
  };
  let out = '', plat = 0, plng = 0;
  for (const [la, ln] of pts) {
    const a = Math.round(la * precision), b = Math.round(ln * precision);
    out += enc(a - plat) + enc(b - plng);
    plat = a; plng = b;
  }
  return out;
}

function hav(a: number[], b: number[]) {
  const R = 6371000, toRad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * toRad, dLng = (b[1] - a[1]) * toRad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * toRad) * Math.cos(b[0] * toRad) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

function bearing(a: number[], b: number[]) {
  const toRad = Math.PI / 180;
  const y = Math.sin((b[1] - a[1]) * toRad) * Math.cos(b[0] * toRad);
  const x = Math.cos(a[0] * toRad) * Math.sin(b[0] * toRad) - Math.sin(a[0] * toRad) * Math.cos(b[0] * toRad) * Math.cos((b[1] - a[1]) * toRad);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

function buildTrace(pts: number[][], sampleM: number, turnDeg: number) {
  if (!pts.length) return [];
  const out = [pts[0]];
  let last = pts[0];
  let lastBearing: number | null = null;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i];
    const d = hav(last, p);
    const b = bearing(last, p);
    let turned = false;
    if (lastBearing !== null) {
      let delta = Math.abs(b - lastBearing);
      if (delta > 180) delta = 360 - delta;
      turned = delta >= turnDeg;
    }
    if (d >= sampleM || turned) { out.push(p); last = p; lastBearing = b; }
  }
  const tail = pts[pts.length - 1];
  const prev = out[out.length - 1];
  if (prev[0] !== tail[0] || prev[1] !== tail[1]) out.push(tail);
  return out;
}

async function resolveKey(base44: any) {
  for (const k of KEY_NAMES) {
    const v = Deno.env.get(k);
    if (v) return { key: v, name: k };
  }
  try {
    const rows = await base44.asServiceRole.entities.AppSettings.list('-updated_date', 50);
    for (const r of rows || []) {
      const name = r?.setting_value?.per_feature_api_keys?.route_optimization;
      if (name) { const k = Deno.env.get(name); if (k) return { key: k, name }; }
    }
  } catch (_) { /* ignore */ }
  return { key: null, name: null };
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const driverId = body.driver_id || '68570f3cd01bfa2d2408a9d7';
    const date = body.delivery_date || '2026-11-09';
    const sampleM = Number(body.sample_m || 100);
    const turnDeg = Number(body.turn_deg || 20);

    const rows = await base44.asServiceRole.entities.DeliveryBreadcrumbs.filter({ driver_id: driverId, delivery_date: date });
    const master = (rows || []).find((r: any) => Number(r?.stop_order) === -1);
    if (!master) return Response.json({ error: 'no master record', driverId, date }, { status: 404 });

    const rawPts = decodePolyline(master.encoded_polyline || '', PREC_IN);
    const trace = buildTrace(rawPts, sampleM, turnDeg);
    const tracePolyline = encodePolyline(trace, PREC_OUT);

    const { key, name } = await resolveKey(base44);
    if (!key) return Response.json({ error: 'HERE key not resolvable', tried: KEY_NAMES, rawPoints: rawPts.length, tracePoints: trace.length }, { status: 500 });

    const url = `https://routematching.hereapi.com/v8/match/routematch?routeMatch=1&mode=car&apiKey=${encodeURIComponent(key)}`;
    const started = Date.now();
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: tracePolyline });
    const text = await res.text();
    if (!res.ok) return Response.json({ error: 'here match failed', status: res.status, body: text.slice(0, 400), tracePoints: trace.length, keyName: name }, { status: 502 });

    let parsed: any = {};
    try { parsed = JSON.parse(text); } catch (_) { /* ignore */ }
    const links = parsed?.RouteLinks || [];
    const allMatched: number[][] = [];
    let totalM = 0, confSum = 0, confCount = 0;
    for (const link of links) {
      const shape = decodePolyline(link?.Shape || '', PREC_OUT);
      for (let i = 0; i < shape.length; i++) allMatched.push(shape[i]);
      for (let i = 1; i < shape.length; i++) totalM += hav(shape[i - 1], shape[i]);
      const c = Number(link?.Confidence ?? link?.confidence);
      if (Number.isFinite(c)) { confSum += c; confCount += 1; }
    }

    const sampleEvery = Math.max(1, Math.floor(trace.length / 300));
    let devSum = 0, devCount = 0, devMax = 0;
    for (let i = 0; i < trace.length; i += sampleEvery) {
      const p = trace[i];
      let best = Infinity;
      for (const q of allMatched) { const d = hav(p, q); if (d < best) best = d; }
      if (Number.isFinite(best)) { devSum += best; devCount += 1; if (best > devMax) devMax = best; }
    }

    let traceM = 0;
    for (let i = 1; i < trace.length; i++) traceM += hav(trace[i - 1], trace[i]);

    return Response.json({
      ok: true,
      readOnly: true,
      driverId, date,
      keyName: name,
      rawPoints: rawPts.length,
      tracePoints: trace.length,
      traceKm: Math.round((traceM / 1000) * 100) / 100,
      matchedLinks: links.length,
      matchedKm: Math.round((totalM / 1000) * 100) / 100,
      meanConfidence: confCount ? Math.round((confSum / confCount) * 1000) / 1000 : null,
      meanDeviationM: devCount ? Math.round(devSum / devCount) : null,
      maxDeviationM: devCount ? Math.round(devMax) : null,
      elapsedMs: Date.now() - started,
      sample_m: sampleM,
      turn_deg: turnDeg,
    });
  } catch (e) {
    return Response.json({ error: e?.message || 'failed' }, { status: 500 });
  }
});
