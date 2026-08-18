/* global Deno */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

/**
 * nativeLocationUpdate — Backend function that receives native GPS POSTs from
 * @capgo/background-geolocation's foreground service.
 *
 * The plugin POSTs location JSON directly from native code (bypassing the WebView),
 * so location updates reach the server even when Android throttles/suspends JS.
 *
 * Request body (from the plugin):
 *   { latitude, longitude, accuracy, altitude, bearing, speed, time, simulated, source: "native" }
 *
 * Headers:
 *   Authorization: Bearer <access_token>
 *   X-AppUser-Id: <app_user_id>
 *
 * This function does TWO things per POST:
 *   1. Updates the AppUser record with new coordinates + timestamp (+ WS broadcast)
 *   2. Appends the GPS point to the breadcrumb master trail (DeliveryBreadcrumbs, stop_order=-1)
 *      so other devices see the driver's trail even when the WebView is suspended.
 */

// ── Polyline encoding (1e5 precision, pure arithmetic — no bitwise ops) ──────
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

function isCorruptedPoint(lat, lng) {
  return Math.abs(lat) > 1 && Math.abs(lng) < 0.01;
}

// Get Edmonton date string (yyyy-MM-dd) for the breadcrumb delivery_date key
function getEdmontonDateString() {
  const now = new Date();
  const edmontonTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/Edmonton' }));
  return edmontonTime.toISOString().slice(0, 10);
}

export default async function(req) {
  try {
    // ── Parse headers ──────────────────────────────────────────────────────
    const authHeader = req.headers.get('Authorization') || req.headers.get('authorization') || '';
    const appUserId  = req.headers.get('X-AppUser-Id')   || req.headers.get('x-appuser-id')   || '';

    if (!authHeader || !appUserId) {
      return new Response(JSON.stringify({ error: 'Missing auth or AppUser ID' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ── Parse body ─────────────────────────────────────────────────────────
    let body;
    try {
      body = await req.json();
    } catch (_) {
      return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const latitude  = Number(body.latitude);
    const longitude = Number(body.longitude);
    const accuracy  = Number(body.accuracy ?? 0);
    const gpsTime   = body.time ? Number(body.time) : Date.now();

    // Validate coordinates
    if (!isFinite(latitude) || !isFinite(longitude) ||
        (Math.abs(latitude) < 0.0001 && Math.abs(longitude) < 0.0001)) {
      return new Response(JSON.stringify({ error: 'Invalid coordinates' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Skip corrupted points (old bitwise overflow encoder artifacts)
    if (isCorruptedPoint(latitude, longitude)) {
      return new Response(JSON.stringify({ error: 'Corrupted coordinates' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ── Create authenticated Base44 client ─────────────────────────────────
    const base44 = createClientFromRequest(req);

    // ── Build update data ──────────────────────────────────────────────────
    const nowISO = new Date().toISOString();
    const updateData = {
      current_latitude:  Math.round(latitude * 1e7) / 1e7,
      current_longitude: Math.round(longitude * 1e7) / 1e7,
      location_updated_at: nowISO,
      last_seen_at: nowISO,
    };

    let appUserUpdated = false;
    let breadcrumbAppended = false;
    let driverId = null;

    // ── Step 1: Update the AppUser record ──────────────────────────────────
    try {
      await base44.entities.AppUser.update(appUserId, updateData);
      appUserUpdated = true;
    } catch (updateErr) {
      // Try service-role as fallback (RLS edge cases)
      try {
        await base44.asServiceRole.entities.AppUser.update(appUserId, updateData);
        appUserUpdated = true;
      } catch (srErr) {
        console.error('❌ [nativeLocationUpdate] AppUser update failed:', srErr?.message);
      }
    }

    // ── Step 2: Append to breadcrumb master trail ───────────────────────────
    // The native POST gives us a single GPS point — append it to the
    // DeliveryBreadcrumbs master record (stop_order=-1) so other devices
    // can see the driver's trail even while the WebView is suspended.
    try {
      // Get the authenticated user's ID for the driver_id field
      const me = await base44.auth.me();
      if (me?.id) {
        driverId = me.id;
        const deliveryDate = getEdmontonDateString();

        // Fetch existing master record
        const existingRecords = await base44.asServiceRole.entities.DeliveryBreadcrumbs
          .filter({ driver_id: driverId, delivery_date: deliveryDate, stop_order: -1 })
          .catch(() => []);

        const existingRecord = existingRecords?.[0] || null;
        let mergedPoints = [];

        if (existingRecord?.encoded_polyline && existingRecord?.timestamps) {
          const coords = decodePolyline(existingRecord.encoded_polyline);
          const tsArr = existingRecord.timestamps.split(',').map(Number);
          coords.forEach((coord, i) => {
            const ts = tsArr[i];
            if (!ts || isCorruptedPoint(coord[0], coord[1])) return;
            mergedPoints.push([coord[0], coord[1], ts]);
          });
        }

        // Add the new point — dedup by timestamp
        const existingTs = new Set(mergedPoints.map(p => p[2]));
        if (!existingTs.has(gpsTime)) {
          mergedPoints.push([latitude, longitude, gpsTime]);
        }

        // Sort by timestamp
        mergedPoints.sort((a, b) => a[2] - b[2]);

        if (mergedPoints.length > 0) {
          const encodedPolyline = encodePolyline(mergedPoints);
          const timestamps = mergedPoints.map(p => p[2]).join(',');
          const masterRecord = {
            driver_id: driverId,
            delivery_date: deliveryDate,
            stop_order: -1,
            encoded_polyline: encodedPolyline,
            timestamps,
            transport_mode: 'driving',
            point_count: mergedPoints.length,
          };

          if (existingRecord?.id) {
            await base44.asServiceRole.entities.DeliveryBreadcrumbs.update(existingRecord.id, masterRecord);
          } else {
            await base44.asServiceRole.entities.DeliveryBreadcrumbs.create(masterRecord);
          }
          breadcrumbAppended = true;
        }
      }
    } catch (bcErr) {
      // Breadcrumb failure is non-fatal — GPS location update is the primary task
      console.warn('⚠️ [nativeLocationUpdate] Breadcrumb append failed:', bcErr?.message);
    }

    return new Response(JSON.stringify({
      success: true,
      appUserId,
      driverId,
      latitude,
      longitude,
      timestamp: nowISO,
      source: 'native',
      appUserUpdated,
      breadcrumbAppended,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({
      error: 'Internal error',
      detail: err?.message || String(err),
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
