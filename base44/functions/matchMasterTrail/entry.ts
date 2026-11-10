import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function dec(s, P = 1e7) {
  const o = []; let i = 0, la = 0, ln = 0;
  while (i < s.length) {
    for (let k = 0; k < 2; k++) {
      let sh = 0, r = 0, b = 0;
      do { b = s.charCodeAt(i++) - 63; r |= (b & 31) << sh; sh += 5; } while (b >= 32);
      const d = r & 1 ? ~(r >> 1) : r >> 1;
      if (k === 0) la += d; else ln += d;
    }
    o.push([la / P, ln / P]);
  }
  return o;
}
function hav(a, b) {
  const R = 6371000, d1 = (b[0] - a[0]) * Math.PI / 180, d2 = (b[1] - a[1]) * Math.PI / 180;
  const x = Math.sin(d1 / 2) ** 2 + Math.cos(a[0] * Math.PI / 180) * Math.cos(b[0] * Math.PI / 180) * Math.sin(d2 / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}
function brg(a, b) {
  const r = Math.PI / 180, y = Math.sin((b[1] - a[1]) * r) * Math.cos(b[0] * r);
  const x = Math.cos(a[0] * r) * Math.sin(b[0] * r) - Math.sin(a[0] * r) * Math.cos(b[0] * r) * Math.cos((b[1] - a[1]) * r);
  return Math.atan2(y, x) / r;
}
function sample(pts, sm, td) {
  if (!pts.length) return [];
  const o = [pts[0]]; let last = pts[0], lb = null;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i], d = hav(last, p), b = brg(last, p);
    let t = false;
    if (lb !== null) { let x = Math.abs(b - lb); if (x > 180) x = 360 - x; t = x >= td; }
    if (d >= sm || t) { o.push(p); last = p; lb = b; }
  }
  if (hav(o[o.length - 1], pts[pts.length - 1]) > 1) o.push(pts[pts.length - 1]);
  return o;
}
function nearest(trace, p) {
  let bi = 0, bd = Infinity;
  for (let i = 0; i < trace.length; i++) { const d = hav(trace[i], p); if (d < bd) { bd = d; bi = i; } }
  return { i: bi, d: bd };
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const q = await req.json().catch(() => ({}));
    const driverId = q.driver_id || '68570f3cd01bfa2d2408a9d7';
    const date = q.delivery_date || '2026-11-09';
    const sm = Number(q.sample_m) || 100, td = Number(q.turn_deg) || 20;

    let key = null, keyName = null;
    for (const n of ['Here_API_Key_2', 'HERE_API_KEY', 'Here_API_Key_3']) {
      const v = Deno.env.get(n);
      if (v) { key = v; keyName = n; break; }
    }
    if (!key) return Response.json({ error: 'no here key' }, { status: 500 });

    const crumbs = await base44.asServiceRole.entities.DeliveryBreadcrumbs.list('-updated_date', 400);
    const master = (crumbs || []).filter((r) => r && r.stop_order === -1 && r.driver_id === driverId && String(r.delivery_date) === date)
      .sort((a, b) => String(b.updated_date).localeCompare(String(a.updated_date)))[0];
    if (!master) return Response.json({ error: 'no master record' }, { status: 404 });

    const raw = dec(master.encoded_polyline, 1e7);
    const trace = sample(raw, sm, td);

    const dels = await base44.asServiceRole.entities.Delivery.filter({ driver_id: driverId, delivery_date: date }, 'stop_order', 400).catch(() => []);
    const patients = await base44.asServiceRole.entities.Patient.list('-updated_date', 3000).catch(() => []);
    const pmap = new Map((patients || []).map((p) => [p.id, p]));
    const stops = [];
    for (const d of (dels || [])) {
      if (!d || !d.patient_id || d.stop_order < 0) continue;
      const p = pmap.get(d.patient_id);
      const lat = Number(p?.latitude), lng = Number(p?.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      if (String(d.status) === 'cancelled') continue;
      stops.push({ lat, lng, order: Number(d.stop_order) || 0, status: d.status, offset: 0 });
    }
    stops.sort((a, b) => a.order - b.order);

    // Guard: a patient row with a placeholder or swapped coordinate would drag
    // the whole trace off the map, so every stop must sit within 60 km of the
    // record's own crumbs.
    const anchor = trace.length ? trace[Math.floor(trace.length / 2)] : null;
    const kept = [];
    let skippedStops = 0;
    for (const st of stops) {
      if (anchor && hav([st.lat, st.lng], anchor) > 60000) { skippedStops += 1; continue; }
      kept.push(st);
    }
    stops.length = 0;
    stops.push(...kept);

    const assigned = stops.map((st) => { const n = nearest(trace, [st.lat, st.lng]); return { lat: st.lat, lng: st.lng, dist: Math.round(n.d), order: st.order, ni: n.i }; });
    const byIdx = new Map();
    for (const st of assigned) { if (!byIdx.has(st.ni)) byIdx.set(st.ni, []); byIdx.get(st.ni).push(st); }
    const traceOut = [];
    const vias = [];
    for (let i = 0; i < trace.length; i++) {
      traceOut.push([trace[i][0], trace[i][1]]);
      const list = byIdx.get(i);
      if (list) for (const st of list) { traceOut.push([st.lat, st.lng]); vias.push({ index: traceOut.length, dist: st.dist, order: st.order }); }
    }
    const maxIdx = traceOut.length - 2;
    for (const v of vias) if (v.index > maxIdx) v.index = Math.max(1, maxIdx);
    const body = { trace: traceOut.map((p) => ({ lat: p[0], lng: p[1] })), via: vias.map((v) => ({ index: v.index })) };
    const url = `https://router.hereapi.com/v8/import?apiKey=${key}&transportMode=car&return=polyline`;
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const txt = await res.text();
    if (!res.ok) return Response.json({ error: 'import failed', status: res.status, body: txt.slice(0, 400), tracePoints: traceOut.length, viaCount: vias.length, keyName });

    const j = JSON.parse(txt);
    const route = (j.routes || [])[0];
    if (!route) return Response.json({ error: 'no route', notices: j.notices, tracePoints: traceOut.length });

    let km = 0, matched = [];
    for (const sec of (route.sections || [])) {
      const pts = dec(sec.polyline || '', 1e5);
      matched = matched.concat(pts);
      for (let i = 1; i < pts.length; i++) km += hav(pts[i - 1], pts[i]) / 1000;
    }
    let sum = 0, mx = 0, cnt = 0;
    const step = Math.max(1, Math.floor(traceOut.length / 300));
    for (let i = 0; i < traceOut.length; i += step) {
      const d = nearest(matched, traceOut[i]).d;
      sum += d; cnt += 1; if (d > mx) mx = d;
    }
    return Response.json({
      ok: true, keyName, stopsUsed: stops.length, skippedStops, viaCount: vias.length,
      rawPoints: raw.length, tracePoints: traceOut.length, matchedPoints: matched.length,
      sections: (route.sections || []).length, matchedKm: Math.round(km * 10) / 10,
      meanDevM: Math.round(sum / Math.max(1, cnt)), maxDevM: Math.round(mx),
      stopSnapDists: vias.map((v) => v.dist).sort((a, b) => b - a).slice(0, 5),
      notices: (j.notices || []).length,
    });
  } catch (e) {
    return Response.json({ error: String(e?.message || e) }, { status: 500 });
  }
});
