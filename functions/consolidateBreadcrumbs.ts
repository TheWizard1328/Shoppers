import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const { delivery_id, delivery_status } = body;

    if (!delivery_id || !delivery_status) {
      return Response.json({ error: 'Missing delivery_id or delivery_status' }, { status: 400 });
    }

    // Only process if delivery is marked complete, failed, or cancelled
    if (!['completed', 'failed', 'cancelled'].includes(delivery_status)) {
      return Response.json({ error: 'Invalid delivery status for breadcrumb consolidation' }, { status: 400 });
    }

    // Get the delivery record
    const delivery = await base44.entities.Delivery.filter({ id: delivery_id });
    if (!delivery || delivery.length === 0) {
      return Response.json({ error: 'Delivery not found' }, { status: 404 });
    }

    const deliveryRecord = delivery[0];
    const driver_id = deliveryRecord.driver_id;

    if (!driver_id) {
      return Response.json({ error: 'Delivery has no assigned driver' }, { status: 400 });
    }

    // TODO: Fetch pending breadcrumbs from offline DB via client-side function
    // This function receives pre-collected breadcrumbs from the client
    const { breadcrumbs } = body;

    if (!breadcrumbs || breadcrumbs.length === 0) {
      console.log(`📍 [ConsolidateBreadcrumbs] No breadcrumbs to consolidate for delivery ${delivery_id}`);
      return Response.json({
        success: true,
        message: 'No breadcrumbs to consolidate',
        delivery_id: delivery_id
      });
    }

    // Update delivery with breadcrumbs
    const updatedDelivery = await base44.entities.Delivery.update(delivery_id, {
      delivery_route_breadcrumbs: breadcrumbs
    });

    if (!updatedDelivery) {
      return Response.json({ error: 'Failed to update delivery with breadcrumbs' }, { status: 500 });
    }

    console.log(`✅ [ConsolidateBreadcrumbs] Consolidated ${breadcrumbs.length} breadcrumbs for delivery ${delivery_id}`);

    return Response.json({
      success: true,
      message: `Consolidated ${breadcrumbs.length} breadcrumbs`,
      delivery_id: delivery_id,
      breadcrumb_count: breadcrumbs.length
    });
  } catch (error) {
    console.error('❌ [ConsolidateBreadcrumbs] Error:', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
});