/* global Deno */
// TEMP DIAGNOSTIC (read-only) — verify a driver's GPS position vs a store at a
// pickup-cancel moment, using the master breadcrumb trail (stop_order -1).
// Softened auth: no user context required for READ-ONLY service-role queries.
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    const DRIVER_ID = body.driver_id || '6a41857fe03681a2a1d3ca7b'; // Anna
    const DELIVERY_DATE = body.delivery_date || '2026-09-18';
    const STORE_ID = body.store_id || '685cd33055969a07cb634fe7'; // West Park (13:50 cancel)
    const CANCEL_UTC_MS = body.cancel_utc_ms || Date.parse('2026-09-18T19:50:48Z'); // 13:50:48 MDT
    const WINDOW_MS = 5 * 60 * 1000;

    // ── Store coords ──
    let allStores = [];
    let storeListError = null;
    try { allStores = await base44.asServiceRole.entities.Store.list(); } catch (e) { storeListError = String(e && e.message ? e.message : e); }
    const store = (allStores || []).find((s) => s && s.id === STORE_ID) || null;
    if (!store) {
      return Response.json({
        error: 'store not found',
        storeId: STORE_ID,
        storeListError,
        storeCount: (allStores || []).length,
        storeSample: (allStores || []).slice(0, 12).map((s) => ({ id: s.id, name: s.name })),
      });
    }

    // ── Breadcrumb records for the driver+date (find the master trail) ──
    const crumbs = await base44.asServiceRole.entities.DeliveryBreadcrumbs.filter({
      driver_id: DRIVER_ID, delivery_date: DELIVERY_DATE,
    }).catch(() => []);
    const recordsSummary = (crumbs || []).map((r) => ({
      id: r.id, stop_order: r.stop_order, point_count: r.point_count,
      encodedLen: (r.encoded_polyline || '').length, tsLen: String(r.timestamps || '').split(',').length,
    }));
    const master = (crumbs || []).find((r) => String(r.stop_order) === '-1')
      || (crumbs || []).find((r) => Number(r.stop_order) === -1)
      || (crumbs || [])[0] || null;
    if (!master) {
      return Response.json({ error: 'no breadcrumb records', recordsSummary, store: { name: store.name } });
    }

    // ── Decode: 1e7 precision, PURE ARITHMETIC (no bitwise — 1e7 longitude overflows 32-bit) ──
    const decodeSafe = (encoded) => {
      const points = []; let index = 0, lat = 0, lng = 0;
      const readVarint = () => {
        let result = 0, shift = 1;
        for (;;) {
          const c = encoded.charCodeAt(index++) - 63;
          result += (c % 32) * shift;
          shift *= 32;
          if (c < 32) break;
        }
        return result;
      };
      const readDelta = () => {
        const r = readVarint();
        return r % 2 === 1 ? -((r + 1) / 2) : r / 2; // zigzag
      };
      while (index < encoded.length) {
        lat += readDelta(); lng += readDelta();
        points.push([lat / 1e7, lng / 1e7]);
      }
      return points;
    };

    const points = decodeSafe(master.encoded_polyline || '');
    const rawTs = master.timestamps;
    const timestamps = Array.isArray(rawTs)
      ? rawTs.map(Number).filter(Number.isFinite)
      : String(rawTs || '').split(',').map(Number).filter(Number.isFinite);

    const hav = (lat1, lon1, lat2, lon2) => {
      const R = 6371000, toRad = (v) => (v * Math.PI) / 180;
      const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
      const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
      return 2 * R * Math.asin(Math.sqrt(a));
    };

    const storeLat = Number(store.latitude), storeLon = Number(store.longitude);
    const validCoords = Number.isFinite(storeLat) && Number.isFinite(storeLon);

    // ── Points within ±5 min of the cancel ──
    const inWindow = [];
    for (let i = 0; i < points.length; i++) {
      const ts = timestamps[i];
      if (!Number.isFinite(ts)) continue;
      if (Math.abs(ts - CANCEL_UTC_MS) <= WINDOW_MS) {
        inWindow.push({
          utc: new Date(ts).toISOString().slice(11, 19),
          lat: Math.round(points[i][0] * 1e5) / 1e5,
          lon: Math.round(points[i][1] * 1e5) / 1e5,
          distToStoreM: validCoords ? Math.round(hav(points[i][0], points[i][1], storeLat, storeLon)) : null,
        });
      }
    }
    const minDistInWindow = inWindow.reduce((m, p) =>
      (p.distToStoreM !== null && (m === null || p.distToStoreM < m)) ? p.distToStoreM : m, null);

    // ── Closest approach to the store at ANY time in the trail ──
    let closest = null;
    if (validCoords) {
      for (let i = 0; i < points.length; i++) {
        const d = hav(points[i][0], points[i][1], storeLat, storeLon);
        if (!closest || d < closest.d) {
          closest = { d: Math.round(d), utc: timestamps[i] ? new Date(timestamps[i]).toISOString().slice(11, 19) : null };
        }
      }
    }

    return Response.json({
      store: { id: store.id, name: store.name, lat: storeLat, lon: storeLon },
      masterRecord: { id: master.id, stop_order: master.stop_order, point_count: master.point_count },
      decodeSanity: { firstPoint: points[0] || null, pointCount: points.length, timestampCount: timestamps.length },
      trailSpan: {
        firstTs: timestamps[0] ? new Date(timestamps[0]).toISOString() : null,
        lastTs: timestamps.length ? new Date(timestamps[timestamps.length - 1]).toISOString() : null,
      },
      cancelAt: new Date(CANCEL_UTC_MS).toISOString(),
      windowPoints: inWindow.length,
      windowMinDistM: minDistInWindow,
      windowSample: inWindow.slice(0, 8),
      closestEver: closest,
      recordsSummary,
    });
  } catch (e) {
    return Response.json({ error: String(e && e.message ? e.message : e) }, { status: 500 });
  }
});
