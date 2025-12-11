import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { deliveryId, driverId, deliveryDate } = await req.json();

    if (!deliveryId || !driverId || !deliveryDate) {
      return Response.json({ 
        error: 'Missing required fields: deliveryId, driverId, deliveryDate' 
      }, { status: 400 });
    }

    console.log(`🎯 [updateNextDeliveryFlag] Processing for delivery ${deliveryId}`);

    // Get the delivery that just changed status
    const changedDelivery = await base44.asServiceRole.entities.Delivery.filter({ id: deliveryId });
    if (!changedDelivery || changedDelivery.length === 0) {
      return Response.json({ error: 'Delivery not found' }, { status: 404 });
    }

    const delivery = changedDelivery[0];
    const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];

    // Only proceed if the status is a finished status
    if (!finishedStatuses.includes(delivery.status)) {
      console.log('  ⏭️ Not a finished status, skipping');
      return Response.json({ success: true, message: 'Not a finished status' });
    }

    // Set this delivery's isNextDelivery to false
    console.log('  ✅ Setting isNextDelivery=false for current delivery');
    await base44.asServiceRole.entities.Delivery.update(deliveryId, {
      isNextDelivery: false
    });

    // Get all deliveries for this driver on this date
    const allDeliveries = await base44.asServiceRole.entities.Delivery.filter({
      driver_id: driverId,
      delivery_date: deliveryDate
    });

    // Filter to incomplete stops only (EXCLUDE PENDING)
    const incompleteDeliveries = allDeliveries.filter(d => 
      d && !finishedStatuses.includes(d.status) && d.status !== 'pending'
    );

    console.log(`  📊 Found ${incompleteDeliveries.length} incomplete non-pending deliveries`);

    if (incompleteDeliveries.length === 0) {
      console.log('  ✅ No incomplete non-pending deliveries - route completed or only pending remains');
      return Response.json({ 
        success: true, 
        message: 'Route completed - no next delivery to set' 
      });
    }

    // Find the delivery with the lowest stop_order
    incompleteDeliveries.sort((a, b) => (a.stop_order || 999) - (b.stop_order || 999));
    const nextDelivery = incompleteDeliveries[0];

    console.log(`  🎯 Setting isNextDelivery=true for delivery ${nextDelivery.id} (stop #${nextDelivery.stop_order})`);

    // Clear isNextDelivery from all other deliveries first
    const otherDeliveries = allDeliveries.filter(d => d && d.id !== nextDelivery.id && d.isNextDelivery);
    for (const otherDelivery of otherDeliveries) {
      await base44.asServiceRole.entities.Delivery.update(otherDelivery.id, {
        isNextDelivery: false
      });
    }

    // Set the next delivery
    await base44.asServiceRole.entities.Delivery.update(nextDelivery.id, {
      isNextDelivery: true
    });

    console.log('  ✅ Next delivery flag updated successfully');

    return Response.json({ 
      success: true, 
      nextDeliveryId: nextDelivery.id,
      nextStopOrder: nextDelivery.stop_order
    });

  } catch (error) {
    console.error('Error in updateNextDeliveryFlag:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});