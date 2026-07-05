import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

// ─── consolidateBreadcrumbs ────────────────────────────────────────────────────
// "Master Timeline Slicer"
//
// Reads the single master 'TODAY' breadcrumb record (stop_order = -1) for a given
// driver/date and slices it into per-stop segments using delivery_time_end values.
//
// Slicing logic:
//   - Stop N's segment = all points where: prev_stop.delivery_time_end <= ts < this_stop.delivery_time_end
//   - Stop 1's segment starts from the first point in the master timeline (no previous stop boundary)
//
// This function can be called:
//   1. After a stop is completed (to slice that specific stop).
//   2. At end-of-day to slice all stops at once.
//   3. On-demand for replay/repair.
//
// If stop_order is omitted, ALL stops for the driver/date are sliced.
// ──────────────────────────────────────────────────────────────────────────────

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'returned']);
const EDMONTON_TZ = 'America/Edmonton';

function getEdmontonDateString(value) {
  if (value == null) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: EDMONTON_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const year = parts.find((p) => p.type === 'year')?.value;
  const month = parts.find((p) => p.type === 'month')?.value;
  const day = parts.find((p) => p.type === 'day')?.value;
  return year && month && day ? `${year}-${month}-${day}` : null;
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

// Parse "HH:mm" or "YYYY-MM-DDTHH:MM:SS" time string into a UTC milliseconds timestamp
// anchored to the given delivery_date in America/Edmonton time.
function parseDeliveryTimeMs(timeValue, deliveryDate) {
  if (!timeValue || !deliveryDate) return null;
  const trimmed = String(timeValue).trim();

  // Already a full ISO datetime (actual_delivery_time / arrival_time)
  if (trimmed.includes('T') || trimmed.includes(' ')) {
    const normalized = trimmed.replace(' ', 'T');
    // If no timezone info, treat as Edmonton local time (UTC-6 standard / UTC-7 MDT)
    const withTz = /[Zz]|[+-]\d{2}:?\d{2}$/.test(normalized)
      ? normalized
      : `${normalized}-06:00`;
    const ms = new Date(withTz).getTime();
    return Number.isNaN(ms) ? null : ms;
  }

  // "HH:mm" format — combine with delivery_date in Edmonton timezone
  if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(trimmed)) {
    const candidate = `${deliveryDate}T${trimmed}`;
    const withTz = `${candidate}-06:00`;
    const ms = new Date(withTz).getTime();
    return Number.isNaN(ms) ? null : ms;
  }

  return parseTimestampMs(trimmed);
}

function encodePolylineValue(value) {
  let v = Math.round(value * 1e5);
  v = v < 0 ? ~(v << 1) : v << 1;
  let result = '';
  while (v >= 0x20) {
    result += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
    v >>= 5;
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
    let shift = 0, result = 0, byte;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    coordinates.push([lat / 1e5, lng / 1e5]);
  }
  return coordinates;
}

function dedupeSequential(points) {
  const result = [];
  for (const point of points) {
    const prev = result[result.length - 1];
    if (!prev || prev[0] !== point[0] || prev[1] !== point[1] || prev[2] !== point[2]) {
      result.push(point);
    }
  }
  return result;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));

    // Support both direct call and entity automation payload
    const deliveryData = body.data || null;
    const driver_id = body.driver_id || deliveryData?.driver_id;
    const delivery_date = body.delivery_date || deliveryData?.delivery_date;
    // Optional: if stop_order is provided, only slice that specific stop. Otherwise slice all.
    const target_stop_order = body.stop_order != null ? Number(body.stop_order) : null;

    if (!driver_id || !delivery_date) {
      return Response.json({ error: 'driver_id and delivery_date are required' }, { status: 400 });
    }

    // ── 1. Fetch the master 'TODAY' breadcrumb record (stop_order = -1) ──────
    const masterRecords = await base44.asServiceRole.entities.DeliveryBreadcrumbs.filter({
      driver_id,
      delivery_date,
      stop_order: -1,
    }).catch(() => []);
    const masterRecord = masterRecords?.[0] || null;

    if (!masterRecord?.encoded_polyline || !masterRecord?.timestamps) {
      return Response.json({
        success: true,
        skipped: true,
        reason: 'no_master_timeline_record',
        driver_id,
        delivery_date,
      });
    }

    // Parse master timeline into [[lat, lon, ts_ms], ...] sorted by time
    const masterCoords = decodePolyline(masterRecord.encoded_polyline);
    const masterTs = masterRecord.timestamps.split(',').map(Number);
    const masterPoints = masterCoords
      .map((coord, i) => {
        const ts = parseTimestampMs(masterTs[i]);
        return ts ? [coord[0], coord[1], ts] : null;
      })
      .filter(Boolean)
      .sort((a, b) => a[2] - b[2]);

    if (masterPoints.length === 0) {
      return Response.json({ success: true, skipped: true, reason: 'empty_master_timeline' });
    }

    // ── 2. Fetch all deliveries for this driver/date, sorted by stop_order ───
    const allDeliveries = await base44.asServiceRole.entities.Delivery.filter(
      { driver_id, delivery_date },
      'stop_order',
      50000
    );

    // Only process terminal (completed/failed/etc) stops so we don't slice mid-transit stops
    const terminalStops = (allDeliveries || [])
      .filter((d) => d && d.stop_order != null && TERMINAL_STATUSES.has(String(d.status || '')))
      .sort((a, b) => Number(a.stop_order) - Number(b.stop_order));

    if (terminalStops.length === 0) {
      return Response.json({ success: true, skipped: true, reason: 'no_terminal_stops', driver_id, delivery_date });
    }

    // Filter to just the target stop if specified
    const stopsToSlice = target_stop_order != null
      ? terminalStops.filter((d) => Number(d.stop_order) === target_stop_order)
      : terminalStops;

    if (stopsToSlice.length === 0) {
      return Response.json({ success: true, skipped: true, reason: 'target_stop_not_found_or_not_terminal', target_stop_order });
    }

    // ── 3. Fetch existing per-stop breadcrumb records for bulk upsert ─────────
    const existingStopRecords = await base44.asServiceRole.entities.DeliveryBreadcrumbs.filter(
      { driver_id, delivery_date },
      'stop_order',
      50000
    ).catch(() => []);

    // Build a lookup: stop_order -> existing record (exclude master sentinel)
    const existingByStopOrder = new Map();
    for (const rec of (existingStopRecords || [])) {
      if (rec?.stop_order != null && Number(rec.stop_order) !== -1) {
        existingByStopOrder.set(Number(rec.stop_order), rec);
      }
    }

    // ── 4. Slice master timeline into per-stop segments ───────────────────────
    // Boundary rule:
    //   Stop N covers points where: prevStopEndMs <= ts < thisStopEndMs
    //   Stop 1 has no lower bound (takes all points from the start of the day)
    //
    // delivery_time_end is the authoritative boundary. If unavailable, fall back to
    // actual_delivery_time, then arrival_time.

    const results = [];

    for (let i = 0; i < stopsToSlice.length; i++) {
      const stop = stopsToSlice[i];
      const numericStopOrder = Number(stop.stop_order);

      // Upper boundary: this stop's completion time
      const stopEndMs = parseDeliveryTimeMs(
        stop.delivery_time_end || stop.actual_delivery_time || stop.arrival_time,
        delivery_date
      );

      if (!stopEndMs) {
        results.push({ stop_order: numericStopOrder, skipped: true, reason: 'no_end_time' });
        continue;
      }

      // Lower boundary: the previous terminal stop's completion time (if any)
      // The previous stop is the highest stop_order below this one that is terminal
      const prevTerminalStop = terminalStops
        .filter((d) => Number(d.stop_order) < numericStopOrder)
        .at(-1) || null;

      const prevStopEndMs = prevTerminalStop
        ? parseDeliveryTimeMs(
            prevTerminalStop.delivery_time_end || prevTerminalStop.actual_delivery_time || prevTerminalStop.arrival_time,
            delivery_date
          )
        : null;

      // Slice: include points in [prevStopEndMs, stopEndMs)
      const slicedPoints = masterPoints.filter((pt) => {
        const ts = pt[2];
        if (ts >= stopEndMs) return false; // After this stop ends
        if (prevStopEndMs && ts < prevStopEndMs) return false; // Before this leg started
        return true;
      });

      if (slicedPoints.length === 0) {
        results.push({ stop_order: numericStopOrder, skipped: true, reason: 'no_points_in_window', prevStopEndMs, stopEndMs });
        continue;
      }

      const dedupedPoints = dedupeSequential(slicedPoints);
      const encodedPolyline = encodePolyline(dedupedPoints);
      const timestamps = dedupedPoints.map((p) => p[2]).join(',');

      const breadcrumbData = {
        driver_id,
        delivery_date,
        stop_order: numericStopOrder,
        encoded_polyline: encodedPolyline,
        timestamps,
        transport_mode: stop.transport_mode || 'driving',
        point_count: dedupedPoints.length,
      };

      const existingRec = existingByStopOrder.get(numericStopOrder);
      if (existingRec?.id) {
        await base44.asServiceRole.entities.DeliveryBreadcrumbs.update(existingRec.id, breadcrumbData);
      } else {
        await base44.asServiceRole.entities.DeliveryBreadcrumbs.create(breadcrumbData);
      }

      results.push({ stop_order: numericStopOrder, point_count: dedupedPoints.length, sliced: true });
    }

    return Response.json({
      success: true,
      driver_id,
      delivery_date,
      master_point_count: masterPoints.length,
      stops_sliced: results.filter((r) => r.sliced).length,
      stops_skipped: results.filter((r) => r.skipped).length,
      results,
    });

  } catch (error) {
    console.error('[consolidateBreadcrumbs] Error:', error?.message || error);
    return Response.json({ error: error?.message || 'Internal error' }, { status: 500 });
  }
});