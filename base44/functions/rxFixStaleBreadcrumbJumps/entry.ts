// ─── rxFixStaleBreadcrumbJumps ─────────────────────────────────────────────────
// Owner report Oct 25 2026 (Sharuk): on app restarts, Android handed the tracker
// an OS-cached lastKnownLocation from an EARLIER point in the day; it got
// stamped with the current time and appended to the master breadcrumb trail,
// drawing a "jump back along an earlier path, then forward to the driver's real
// location" artifact at each restart. (Client-side stale-fix gate deployed the
// same day in locationTracker.jsx stops NEW ones; this function removes the
// leftovers already saved in master records.)
//
// Detection — the "teleport sandwich" signature (impossible for real driving):
//   point A → [1..N points all >300m from A, each >500m hop] → point C where
//   C is within 300m of A AND C arrives < 120s after A. A real round trip of
// 1km+ cannot complete in under two minutes, so the enclosed run is injected.
//
// Params:
//   driver_id     — required unless driver_name given
//   driver_name   — partial/full name match (case-insensitive) to resolve the id
//   delivery_date — 'YYYY-MM-DD' (required)
//   dry_run       — default true: report only, no writes
// Response: { success, driver_id, delivery_date, anomalies: [...],
//            points_before, points_after, removed, repaired }
import { createClientFromRequest } from "@base44/sdk";

const JUMP_OUT_M = 500;      // A→B hop that qualifies as a teleport out
const RETURN_RADIUS_M = 300;  // a "return" point must land this close to A
const RETURN_WINDOW_MS = 120_000; // ...and within this time of A
const LOOKAHEAD = 8;         // max injected points in one run

function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function parseTimestampMs(value) {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 1e12) return value;
    if (value > 1e9) return value * 1000;
    return null;
  }
  if (typeof value === "string") {
    const t = value.trim();
    if (!t) return null;
    if (/^\d+$/.test(t)) {
      const n = Number(t);
      return n > 1e12 ? n : n > 1e9 ? n * 1000 : null;
    }
    const d = new Date(t).getTime();
    return Number.isFinite(d) ? d : null;
  }
  return null;
}

// Polyline codec — auto-detect 1e5/1e7 on decode; breadcrumbs are written at 1e7.
function decodePolyline(encoded) {
  if (!encoded) return [];
  const rawLats = [], rawLngs = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    let b, result = 0, multiplier = 1;
    do { b = encoded.charCodeAt(index++) - 63; result += (b % 32) * multiplier; multiplier *= 32; } while (b >= 0x20);
    lat += (result % 2 !== 0) ? -((result + 1) / 2) : (result / 2);
    result = 0; multiplier = 1;
    do { b = encoded.charCodeAt(index++) - 63; result += (b % 32) * multiplier; multiplier *= 32; } while (b >= 0x20);
    lng += (result % 2 !== 0) ? -((result + 1) / 2) : (result / 2);
    rawLats.push(lat); rawLngs.push(lng);
  }
  const firstLat = rawLats[0] ?? 0;
  const divisor = Math.abs(firstLat) > 9_000_000 ? 1e7 : 1e5;
  return rawLats.map((rl, i) => [rl / divisor, rawLngs[i] / divisor]);
}

const PRECISION = 1e7;
function encodeValue(value, prev) {
  let v = Math.round(value * PRECISION) - Math.round(prev * PRECISION);
  let s = "";
  // Zigzag with pure arithmetic (no bitwise — 32-bit overflow, see memory #30)
  v = v < 0 ? -2 * v - 1 : 2 * v;
  while (v >= 0x20) { s += String.fromCharCode((0x20 + (v % 0x20)) + 63); v = Math.floor(v / 0x20); }
  s += String.fromCharCode(v + 63);
  return s;
}
function encodePolyline(points) {
  let s = "", prevLat = 0, prevLng = 0;
  for (const [lat, lng] of points) {
    s += encodeValue(lat, prevLat); prevLat = lat;
    s += encodeValue(lng, prevLng); prevLng = lng;
  }
  return s;
}

export default async function main(req, base44) {
  try {
    const body = await req.json().catch(() => ({}));
    const { driver_name, delivery_date, dry_run = true } = body;
    let { driver_id } = body;

    if (!delivery_date) return Response.json({ success: false, error: "delivery_date is required (YYYY-MM-DD)" }, { status: 400 });

    if (!driver_id && driver_name) {
      const users = await base44.asServiceRole.entities.AppUser.filter({}).catch(() => []);
      const needle = String(driver_name).toLowerCase();
      const match = (users || []).find((u) =>
        String(u.full_name || u.name || "").toLowerCase().includes(needle));
      if (!match) return Response.json({ success: false, error: `No user matching '${driver_name}'` }, { status: 404 });
      driver_id = match.id;
    }
    if (!driver_id) return Response.json({ success: false, error: "driver_id or driver_name required" }, { status: 400 });

    const masters = await base44.asServiceRole.entities.DeliveryBreadcrumbs.filter({
      driver_id, delivery_date, stop_order: -1,
    }).catch(() => []);
    if (!masters || masters.length === 0) {
      return Response.json({ success: false, error: "No master record (stop_order = -1)" }, { status: 404 });
    }
    // Pick the record with the most points (duplicates possible from sync races)
    const master = [...masters].sort((a, b) => (b.point_count || 0) - (a.point_count || 0))[0];

    const rawCoords = decodePolyline(master.encoded_polyline || "");
    const rawTs = String(master.timestamps || "").split(",").map(Number);
    const points = rawCoords
      .map((c, i) => {
        const ts = parseTimestampMs(rawTs[i]);
        return ts ? [c[0], c[1], ts] : null;
      })
      .filter(Boolean);

    if (points.length < 3) {
      return Response.json({ success: true, driver_id, delivery_date, points_before: points.length, anomalies: [], removed: 0, note: "fewer than 3 points — nothing to scan" });
    }

    // ── Sandwich scan ────────────────────────────────────────────────────────
    const remove = new Set();
    const anomalies = [];
    let i = 1;
    while (i < points.length - 1) {
      const a = points[i];
      const b = points[i + 1];
      const hopOut = haversineM(a[0], a[1], b[0], b[1]);
      if (hopOut > JUMP_OUT_M) {
        // look ahead for a return to within RETURN_RADIUS_M of A in the time window
        let returnIdx = -1;
        const maxK = Math.min(i + 1 + LOOKAHEAD, points.length - 1);
        for (let k = i + 2; k <= maxK; k++) {
          const pk = points[k];
          if (haversineM(a[0], a[1], pk[0], pk[1]) <= RETURN_RADIUS_M) { returnIdx = k; break; }
        }
        const windowOk = returnIdx !== -1 && (points[returnIdx][2] - a[2]) <= RETURN_WINDOW_MS && points[returnIdx][2] >= a[2];
        if (returnIdx !== -1 && windowOk && returnIdx > i + 1) {
          const runPts = [];
          for (let j = i + 1; j < returnIdx; j++) { remove.add(j); runPts.push(points[j]); }
          anomalies.push({
            anchor_idx: i,
            removed_idxs: `${i + 1}–${returnIdx - 1}`,
            anchor_time: new Date(a[2]).toISOString(),
            jump_out_m: Math.round(hopOut),
            injected_points: runPts.length,
            injected_coords: runPts.map((p) => [+p[0].toFixed(5), +p[1].toFixed(5)]),
            return_gap_s: Math.round((points[returnIdx][2] - a[2]) / 1000),
          });
          i = returnIdx; // continue scanning after the return point
          continue;
        }
      }
      i++;
    }

    if (anomalies.length === 0) {
      return Response.json({ success: true, driver_id, delivery_date, points_before: points.length, anomalies: [], removed: 0, note: "no stale-jump sandwiches detected" });
    }

    if (dry_run) {
      return Response.json({
        success: true, driver_id, delivery_date, dry_run: true, master_id: master.id,
        points_before: points.length, anomalies, removed: remove.size, repaired: false,
        note: "dry run — no changes written (pass dry_run:false to repair)",
      });
    }

    // ── Repair: drop the injected runs, re-encode, save ──────────────────────
    const kept = points.filter((_, idx) => !remove.has(idx));
    const encoded = encodePolyline(kept.map((p) => [p[0], p[1]]));
    const timestamps = kept.map((p) => p[2]).join(",");
    await base44.asServiceRole.entities.DeliveryBreadcrumbs.update(master.id, {
      encoded_polyline: encoded,
      timestamps,
      point_count: kept.length,
    });

    return Response.json({
      success: true, driver_id, delivery_date, dry_run: false, master_id: master.id,
      points_before: points.length, points_after: kept.length, anomalies, removed: remove.size, repaired: true,
    });
  } catch (e) {
    return Response.json({ success: false, error: e?.message || String(e) }, { status: 500 });
  }
}
