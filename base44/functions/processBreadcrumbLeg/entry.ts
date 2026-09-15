import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

// ─── processBreadcrumbLeg ──────────────────────────────────────────────────────
// Called when a stop reaches a terminal status (completed/failed/etc).
// Triggers the master timeline slicer (consolidateBreadcrumbs) for this specific stop,
// then copies the resulting polyline to the Delivery record.
//
// With the new architecture, there is no per-stop breadcrumb writing on the mobile side.
// All GPS points accumulate in the master 'TODAY' record (stop_order = -1) and are sliced
// by consolidateBreadcrumbs using delivery_time_end boundaries.
// ──────────────────────────────────────────────────────────────────────────────

const MIN_BREADCRUMB_POINTS = 5;

// ── Polyline precision shim ──────────────────────────────────────────────────
// Breadcrumb polylines (DeliveryBreadcrumbs.encoded_polyline) are encoded at 1e7.
// Delivery.encoded_polyline is consumed by the HERE/Google route renderer at 1e5.
// Before copying a sliced breadcrumb into the Delivery record, decode at breadcrumb
// precision (auto-detect 1e5/1e7 for transition safety) and re-encode at 1e5.
function decodeBreadcrumbPolyline(encoded) {
  if (!encoded || typeof encoded !== 'string') return [];
  let index = 0, len = encoded.length, lat = 0, lng = 0;
  const rawLats = [], rawLngs = [];
  while (index < len) {
    let b, result = 0, multiplier = 1;
    do { b = encoded.charCodeAt(index++) - 63; result += (b % 32) * multiplier; multiplier *= 32; } while (b >= 0x20);
    lat += ((result % 2 !== 0) ? -((result + 1) / 2) : (result / 2));
    result = 0; multiplier = 1;
    do { b = encoded.charCodeAt(index++) - 63; result += (b % 32) * multiplier; multiplier *= 32; } while (b >= 0x20);
    lng += ((result % 2 !== 0) ? -((result + 1) / 2) : (result / 2));
    rawLats.push(lat); rawLngs.push(lng);
  }
  const firstLat = rawLats[0] ?? 0;
  const divisor = Math.abs(firstLat) > 9_000_000 ? 1e7 : 1e5;
  return rawLats.map((rl, i) => [rl / divisor, rawLngs[i] / divisor]);
}
function encodePolylineAt(points, precision) {
  const encodeValue = (val) => {
    let v = Math.round(val * precision);
    v = v < 0 ? (-v * 2 - 1) : (v * 2);
    let result = '';
    while (v >= 0x20) { result += String.fromCharCode((0x20 + (v % 0x20)) + 63); v = Math.floor(v / 0x20); }
    result += String.fromCharCode(v + 63);
    return result;
  };
  let prevLat = 0, prevLng = 0, encoded = '';
  for (const [lat, lng] of points) {
    encoded += encodeValue(lat - prevLat) + encodeValue(lng - prevLng);
    prevLat = lat; prevLng = lng;
  }
  return encoded;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);

    const payload = req.method === 'POST' ? await req.json().catch(() => ({})) : {};

    const deliveryData = payload.data || null;
    const delivery_id = payload.delivery_id || payload.event?.entity_id || deliveryData?.id;
    const driver_id = payload.driver_id || deliveryData?.driver_id;
    const delivery_date = payload.delivery_date || deliveryData?.delivery_date;
    const stop_order = payload.stop_order ?? deliveryData?.stop_order;

    if (!delivery_id || !driver_id || !delivery_date || stop_order == null) {
      return Response.json({ error: 'delivery_id, driver_id, delivery_date, and stop_order are required' }, { status: 400 });
    }

    // ── Step 1: Trigger the slicer for this specific stop ────────────────────
    // consolidateBreadcrumbs will slice the master 'TODAY' timeline and write
    // a per-stop DeliveryBreadcrumbs record for this stop_order.
    const sliceResult = await base44.asServiceRole.functions.invoke('consolidateBreadcrumbs', {
      driver_id,
      delivery_date,
      stop_order: Number(stop_order),
    });

    const slicedStop = sliceResult?.results?.find((r) => Number(r.stop_order) === Number(stop_order));

    if (!slicedStop?.sliced || slicedStop.point_count < MIN_BREADCRUMB_POINTS) {
      return Response.json({
        success: false,
        skipped: true,
        reason: slicedStop?.reason || 'insufficient_points_after_slice',
        point_count: slicedStop?.point_count ?? 0,
        min_required: MIN_BREADCRUMB_POINTS,
        delivery_id,
      });
    }

    // ── Step 2: Read the freshly sliced per-stop record ──────────────────────
    const breadcrumbRecords = await base44.asServiceRole.entities.DeliveryBreadcrumbs.filter({
      driver_id,
      delivery_date,
      stop_order: Number(stop_order),
    }).catch(() => []);

    const breadcrumb = (breadcrumbRecords || []).sort((a, b) =>
      new Date(b.updated_date || b.created_date || 0).getTime() -
      new Date(a.updated_date || a.created_date || 0).getTime()
    )[0];

    if (!breadcrumb?.encoded_polyline) {
      return Response.json({ success: false, skipped: true, reason: 'no_sliced_polyline_found', delivery_id });
    }

    // ── Step 3: Copy sliced polyline to the Delivery record ──────────────────
    // Breadcrumb is 1e7; Delivery.encoded_polyline expects 1e5 (HERE/Google standard).
    const bcCoords = decodeBreadcrumbPolyline(breadcrumb.encoded_polyline);
    const deliveryPolyline = encodePolylineAt(bcCoords, 1e5);
    await base44.asServiceRole.entities.Delivery.update(delivery_id, {
      encoded_polyline: deliveryPolyline,
    });

    return Response.json({
      success: true,
      delivery_id,
      stop_order,
      point_count: breadcrumb.point_count || slicedStop.point_count,
    });

  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});