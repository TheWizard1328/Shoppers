import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

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

    // Fetch the delivery record
    const delivery = deliveryData?.id === delivery_id
      ? deliveryData
      : await base44.asServiceRole.entities.Delivery.get(delivery_id);
    if (!delivery) {
      return Response.json({ error: 'Delivery not found' }, { status: 404 });
    }

    // Skip if polyline already exists on the delivery
    if (delivery.encoded_polyline) {
      return Response.json({ success: true, skipped: true, reason: 'polyline_already_exists', delivery_id });
    }

    // Look up the matching DeliveryBreadcrumbs record by composite key: driver_id + delivery_date + stop_order
    const breadcrumbRecords = await base44.asServiceRole.entities.DeliveryBreadcrumbs.filter({
      driver_id,
      delivery_date,
      stop_order: Number(stop_order),
    }).catch(() => []);

    if (!breadcrumbRecords || breadcrumbRecords.length === 0) {
      return Response.json({ success: false, skipped: true, reason: 'no_breadcrumb_record', delivery_id, driver_id, delivery_date, stop_order });
    }

    // Use the most recently updated breadcrumb record if there are multiple
    const breadcrumb = breadcrumbRecords.sort((a, b) => {
      const aTime = new Date(a.updated_date || a.created_date || 0).getTime();
      const bTime = new Date(b.updated_date || b.created_date || 0).getTime();
      return bTime - aTime;
    })[0];

    const pointCount = Number(breadcrumb.point_count) || 0;
    const encodedPolyline = breadcrumb.encoded_polyline;

    // Enforce minimum point threshold — insufficient data produces unreliable polylines
    if (pointCount < MIN_BREADCRUMB_POINTS) {
      return Response.json({
        success: false,
        skipped: true,
        reason: 'insufficient_breadcrumb_points',
        point_count: pointCount,
        min_required: MIN_BREADCRUMB_POINTS,
        delivery_id,
      });
    }

    if (!encodedPolyline) {
      return Response.json({ success: false, skipped: true, reason: 'no_encoded_polyline_on_breadcrumb', delivery_id });
    }

    // Copy the pre-encoded polyline directly from the breadcrumb to the delivery
    await base44.asServiceRole.entities.Delivery.update(delivery_id, {
      encoded_polyline: encodedPolyline,
    });

    return Response.json({
      success: true,
      delivery_id,
      stop_order,
      point_count: pointCount,
    });

  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});