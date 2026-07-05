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
    await base44.asServiceRole.entities.Delivery.update(delivery_id, {
      encoded_polyline: breadcrumb.encoded_polyline,
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