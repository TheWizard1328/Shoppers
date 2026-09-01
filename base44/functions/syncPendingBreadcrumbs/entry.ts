import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

// ─── syncPendingBreadcrumbs ────────────────────────────────────────────────────
// Receives the full 'TODAY' master breadcrumb timeline from the mobile client and
// appends any new points to the single master record for that driver/date.
// stop_order = -1 is the sentinel for the unsegmented master timeline.
// The consolidateBreadcrumbs function is responsible for slicing this into stops.
// ──────────────────────────────────────────────────────────────────────────────

// Polyline encoding — 1e5 precision (~1m accuracy, standard Google/HERE polyline format)
// MUST match the client encoder in locationBreadcrumbService.jsx and breadcrumbsManager.jsx.
// Uses pure arithmetic (no bitwise ops) to avoid 32-bit overflow for |longitude| > ~107°.
const POLY_PRECISION = 1e5;

function encodePolylineValue(value) {
  let v = Math.round(value * POLY_PRECISION);
  v = v < 0 ? (-v * 2 - 1) : (v * 2);
  let result = '';
  while (v >= 0x20) {
    result += String.fromCharCode((0x20 + (v % 0x20)) + 63);
    v = Math.floor(v / 0x20);
  }
  result += String.fromCharCode(v + 63);
  return result;
}

function encodePolyline(points) {
  let prevLat = 0, prevLon = 0, result = '';
  for (const point of points) {
    result += encodePolylineValue(point[0] - prevLat);
    result += encodePolylineValue(point[1] - prevLon);
    prevLat = point[0];
    prevLon = point[1];
  }
  return result;
}

function decodePolyline(encoded) {
  if (!encoded || typeof encoded !== 'string') return [];
  let index = 0, lat = 0, lng = 0;
  const coordinates = [];
  while (index < encoded.length) {
    let result = 0, multiplier = 1, byte;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result += (byte % 32) * multiplier;
      multiplier *= 32;
    } while (byte >= 0x20);
    lat += (result % 2 !== 0) ? -((result + 1) / 2) : (result / 2);
    result = 0; multiplier = 1;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result += (byte % 32) * multiplier;
      multiplier *= 32;
    } while (byte >= 0x20);
    lng += (result % 2 !== 0) ? -((result + 1) / 2) : (result / 2);
    coordinates.push([lat / POLY_PRECISION, lng / POLY_PRECISION]);
  }
  return coordinates;
}

// Detect corrupted points from the old bitwise-overflow encoder.
// The old encoder zeroed out longitude for |lng| > ~107° at 1e5 precision.
function isCorruptedPoint(lat, lng) {
  return Math.abs(lat) > 1 && Math.abs(lng) < 0.01;
}

function parseTimestampMs(value) {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 1e12) return value;
    if (value > 1e9) return value * 1000;
    return null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d+$/.test(trimmed)) {
      const numeric = Number(trimmed);
      return numeric > 1e12 ? numeric : numeric > 1e9 ? numeric * 1000 : null;
    }
    const parsed = new Date(trimmed).getTime();
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { driver_id, delivery_date, encoded_polyline: incomingPolyline, timestamps: incomingTimestamps, point_count } = body;

    if (!driver_id || !delivery_date || !incomingPolyline) {
      return Response.json({ error: 'driver_id, delivery_date, and encoded_polyline are required' }, { status: 400 });
    }

    // Security: driver can only write their own record (admins may pass any driver_id)
    const appUsers = await base44.asServiceRole.entities.AppUser.filter({ user_id: user.id });
    const appUser = appUsers?.[0] || null;
    const isAdmin = Array.isArray(appUser?.app_roles) && appUser.app_roles.includes('admin');
    if (driver_id !== user.id && !isAdmin) {
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Decode incoming points from the client
    const incomingCoords = decodePolyline(incomingPolyline);
    const incomingTs = (incomingTimestamps || '').split(',').map(Number);
    const incomingPoints = incomingCoords
      .map((coord, i) => [coord[0], coord[1], incomingTs[i] || 0])
      .filter(pt => !isCorruptedPoint(pt[0], pt[1])); // Drop any corrupted points

    // Fetch ALL existing master records (stop_order = -1) for this driver/date.
    // NOTE: this is intentionally NOT just [0] — there is a known race where two
    // concurrent invocations (the routine 15s GPS sync + the "flush before slice"
    // call fired on every stop completion) can both read "no existing record" and
    // both create() a fresh master record, producing duplicate -1 rows over the
    // course of a day. Rather than trying to eliminate the race with locking
    // (not available on this platform for entity writes), we self-heal on every
    // sync: merge ALL duplicates' points together, keep the oldest record as the
    // single source of truth, and delete the rest. Because syncs happen every
    // ~15s while on_duty, any duplicate created by the race gets folded back into
    // one record almost immediately, instead of accumulating for the rest of the day.
    const existingRecords = await base44.asServiceRole.entities.DeliveryBreadcrumbs.filter({
      driver_id,
      delivery_date,
      stop_order: -1,
    }).catch(() => []);

    // Oldest record (by created_date, falling back to id) is the one we keep/update.
    const sortedExisting = Array.isArray(existingRecords) && existingRecords.length > 0
      ? [...existingRecords].sort((a, b) => {
          const aTime = a?.created_date ? new Date(a.created_date).getTime() : 0;
          const bTime = b?.created_date ? new Date(b.created_date).getTime() : 0;
          return aTime - bTime;
        })
      : [];
    const existingRecord = sortedExisting[0] || null;
    const duplicateRecordIds = sortedExisting.slice(1).map((r) => r.id).filter(Boolean);

    if (duplicateRecordIds.length > 0) {
      console.warn(`⚠️ [syncPendingBreadcrumbs] Found ${duplicateRecordIds.length} duplicate master record(s) for driver=${driver_id} date=${delivery_date} — merging into one.`);
    }

    // Merge: ALL existing duplicates' points + incoming points, de-duplicated by timestamp, sorted
    const existingPoints = [];
    let corruptedSkipped = 0;
    for (const rec of sortedExisting) {
      if (!rec?.encoded_polyline || !rec?.timestamps) continue;
      const coords = decodePolyline(rec.encoded_polyline);
      const tsArr = rec.timestamps.split(',').map(Number);
      coords.forEach((coord, i) => {
        const ts = parseTimestampMs(tsArr[i]);
        if (!ts) return;
        // Skip corrupted points from the old bitwise-overflow encoder
        if (isCorruptedPoint(coord[0], coord[1])) {
          corruptedSkipped++;
          return;
        }
        existingPoints.push([coord[0], coord[1], ts]);
      });
    }

    if (corruptedSkipped > 0) {
      console.log(`🍞 [syncPendingBreadcrumbs] Skipped ${corruptedSkipped} corrupted points from existing record(s) (bitwise overflow)`);
    }

    // Merge by timestamp — but NEVER let raw incoming GPS points overwrite
    // existing SNAPPED points. When snapMasterTimeline fills a gap zone, it
    // interpolates unique strictly-increasing timestamps for the HERE-routed
    // bridge points. However, the driver's device still has the ORIGINAL raw
    // GPS points (with the original timestamps) in its offline buffer, and
    // flushes them on every 15s sync. Without this guard, those raw points
    // at the original timestamps would overwrite the snapped bridge points
    // — silently undoing the snap and restoring the gaps.
    // When the existing master is snapped, we keep its points for any
    // timestamp it already covers, and only ADD incoming points for
    // timestamps the snapped master doesn't have (i.e. new GPS collected
    // AFTER the snap was saved).
    const hasSnappedMaster = sortedExisting.some((r) => r?.is_snapped === true);
    const tsMap = new Map();
    for (const pt of existingPoints) tsMap.set(pt[2], pt);
    if (hasSnappedMaster) {
      // Snapped master exists — only add incoming points for NEW timestamps
      // not already covered by the snapped trail. This preserves all snapped
      // bridge points while still appending any genuinely new GPS data.
      for (const pt of incomingPoints) {
        if (pt[2] && !tsMap.has(pt[2])) tsMap.set(pt[2], pt);
      }
      console.log(`🍞 [syncPendingBreadcrumbs] Snapped master detected — preserving ${existingPoints.length} snapped pts, only adding new timestamps from incoming ${incomingPoints.length} pts`);
    } else {
      // No snapped master — original behavior: incoming points win on conflict
      for (const pt of incomingPoints) { if (pt[2]) tsMap.set(pt[2], pt); }
    }

    const mergedPoints = Array.from(tsMap.values()).sort((a, b) => a[2] - b[2]);

    if (mergedPoints.length === 0) {
      return Response.json({ status: 'skipped', reason: 'no_valid_points' });
    }

    const encodedPolyline = encodePolyline(mergedPoints);
    const timestamps = mergedPoints.map((p) => p[2]).join(',');

    // Preserve is_snapped flag: if the existing master was snapped, the merged
    // result (which preserves all snapped bridge points) is still snapped.
    // Don't silently downgrade a snapped master back to raw by omitting the flag.
    const isSnapped = hasSnappedMaster || (existingRecord?.is_snapped === true);

    const masterRecord = {
      driver_id,
      delivery_date,
      stop_order: -1, // Sentinel: master timeline
      encoded_polyline: encodedPolyline,
      timestamps,
      transport_mode: 'driving',
      point_count: mergedPoints.length,
      ...(isSnapped ? { is_snapped: true } : {}),
    };

    if (existingRecord?.id) {
      await base44.asServiceRole.entities.DeliveryBreadcrumbs.update(existingRecord.id, masterRecord);
    } else {
      await base44.asServiceRole.entities.DeliveryBreadcrumbs.create(masterRecord);

      // ── POST-CREATE DEDUP ──────────────────────────────────────────────────
      // Even with the client-side mutex, two different devices could race to
      // create. Re-query immediately after create; if we now see >1 record,
      // merge into the oldest and delete the rest. This catches duplicates in
      // the SAME call that created them, rather than waiting for the next sync.
      const postCreateRecords = await base44.asServiceRole.entities.DeliveryBreadcrumbs.filter({
        driver_id,
        delivery_date,
        stop_order: -1,
      }).catch(() => []);

      if (Array.isArray(postCreateRecords) && postCreateRecords.length > 1) {
        console.warn(`⚠️ [syncPendingBreadcrumbs] Post-create dedup: found ${postCreateRecords.length} master records after create — merging.`);

        // Re-merge ALL records (including the one we just created) into oldest
        const postSorted = [...postCreateRecords].sort((a, b) => {
          const aTime = a?.created_date ? new Date(a.created_date).getTime() : 0;
          const bTime = b?.created_date ? new Date(b.created_date).getTime() : 0;
          return aTime - bTime;
        });
        const postOldest = postSorted[0];
        const postDupIds = postSorted.slice(1).map((r) => r.id).filter(Boolean);

        // Re-merge points from all records — snapped records take priority
        const postHasSnapped = postSorted.some((r) => r?.is_snapped === true);
        const postPointsMap = new Map();
        for (const rec of postSorted) {
          if (!rec?.encoded_polyline || !rec?.timestamps) continue;
          const coords = decodePolyline(rec.encoded_polyline);
          const tsArr = rec.timestamps.split(',').map(Number);
          coords.forEach((coord, i) => {
            const ts = parseTimestampMs(tsArr[i]);
            if (!ts || isCorruptedPoint(coord[0], coord[1])) return;
            postPointsMap.set(ts, [coord[0], coord[1], ts]);
          });
        }
        // Only add incoming raw points for timestamps not already covered
        // (preserves snapped bridge points from overwrite)
        if (postHasSnapped) {
          for (const pt of incomingPoints) { if (pt[2] && !postPointsMap.has(pt[2])) postPointsMap.set(pt[2], pt); }
        } else {
          for (const pt of incomingPoints) { if (pt[2]) postPointsMap.set(pt[2], pt); }
        }
        const postMerged = Array.from(postPointsMap.values()).sort((a, b) => a[2] - b[2]);

        if (postMerged.length > 0 && postOldest?.id) {
          await base44.asServiceRole.entities.DeliveryBreadcrumbs.update(postOldest.id, {
            driver_id,
            delivery_date,
            stop_order: -1,
            encoded_polyline: encodePolyline(postMerged),
            timestamps: postMerged.map((p) => p[2]).join(','),
            transport_mode: 'driving',
            point_count: postMerged.length,
          });
          await Promise.all(
            postDupIds.map((id) =>
              base44.asServiceRole.entities.DeliveryBreadcrumbs.delete(id).catch((err) =>
                console.warn(`⚠️ [syncPendingBreadcrumbs] Post-create dedup: failed to delete ${id}:`, err?.message || err)
              )
            )
          );
          console.log(`✅ [syncPendingBreadcrumbs] Post-create dedup: merged ${postSorted.length} records into 1 (${postMerged.length} points).`);
        }
      }
    }

    // Clean up duplicate master records that existed at read time.
    // Do this AFTER the save succeeds so a failure here never loses data.
    if (duplicateRecordIds.length > 0) {
      await Promise.all(
        duplicateRecordIds.map((id) =>
          base44.asServiceRole.entities.DeliveryBreadcrumbs.delete(id).catch((err) =>
            console.warn(`⚠️ [syncPendingBreadcrumbs] Failed to delete duplicate master record ${id}:`, err?.message || err)
          )
        )
      );
    }

    return Response.json({
      status: 'synced',
      driver_id,
      delivery_date,
      point_count: mergedPoints.length,
      new_points: incomingPoints.length,
      merged: existingPoints.length > 0,
      corrupted_skipped: corruptedSkipped,
      duplicates_merged: duplicateRecordIds.length,
    });
  } catch (error) {
    console.error('❌ [syncPendingBreadcrumbs] Error:', error?.message || error);
    return Response.json({ error: error?.message || 'Unknown error' }, { status: 500 });
  }
});
