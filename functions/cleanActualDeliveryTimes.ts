import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

/**
 * One-time cleanup function to sanitize actual_delivery_time across all Delivery records
 * Removes timezone offsets like -07:00, +05:00, Z from actual_delivery_time strings
 * 
 * Admin-only function - processes deliveries in batches to avoid rate limits
 */

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    // CRITICAL: Admin-only access
    if (user?.role !== 'admin') {
      return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
    }

    const { batchSize = 100, dryRun = false } = await req.json().catch(() => ({}));

    // Fetch all deliveries with a high limit
    const fetchedDeliveries = await base44.asServiceRole.entities.Delivery.list('-created_date', 50000);
    console.log(`Fetch result type: ${typeof fetchedDeliveries}, isArray: ${Array.isArray(fetchedDeliveries)}`);
    console.log(`Total deliveries fetched: ${fetchedDeliveries?.length || 0}`);
    
    // CRITICAL: SDK .list() might return the data wrapped - ensure we get the array
    const allDeliveries = Array.isArray(fetchedDeliveries) ? fetchedDeliveries : [];
    
    const deliveriesWithTime = allDeliveries.filter(d => d.actual_delivery_time);

    console.log(`Found ${deliveriesWithTime.length} deliveries with actual_delivery_time`);

    // Sanitize actual_delivery_time - remove timezone offsets
    const sanitizeTime = (timeString) => {
      if (!timeString || typeof timeString !== 'string') return timeString;
      return timeString.replace(/([+-]\d{2}:?\d{2}|Z)$/, '');
    };

    const deliveriesToUpdate = [];
    const alreadyClean = [];

    for (const delivery of deliveriesWithTime) {
      const original = delivery.actual_delivery_time;
      const sanitized = sanitizeTime(original);

      if (original !== sanitized) {
        deliveriesToUpdate.push({
          id: delivery.id,
          original,
          sanitized
        });
      } else {
        alreadyClean.push(delivery.id);
      }
    }

    console.log(`${deliveriesToUpdate.length} deliveries need cleaning`);
    console.log(`${alreadyClean.length} deliveries already clean`);

    if (dryRun) {
      return Response.json({
        message: 'Dry run completed - no changes made',
        totalDeliveries: deliveriesWithTime.length,
        needsCleaning: deliveriesToUpdate.length,
        alreadyClean: alreadyClean.length,
        samples: deliveriesToUpdate.slice(0, 5)
      });
    }

    // Process in batches to avoid rate limits
    const results = { updated: 0, errors: 0 };
    
    for (let i = 0; i < deliveriesToUpdate.length; i += batchSize) {
      const batch = deliveriesToUpdate.slice(i, i + batchSize);
      
      console.log(`Processing batch ${Math.floor(i / batchSize) + 1} of ${Math.ceil(deliveriesToUpdate.length / batchSize)}`);
      
      const batchPromises = batch.map(async ({ id, sanitized }) => {
        try {
          await base44.asServiceRole.entities.Delivery.update(id, {
            actual_delivery_time: sanitized
          });
          results.updated++;
        } catch (error) {
          console.error(`Failed to update delivery ${id}:`, error.message);
          results.errors++;
        }
      });

      await Promise.all(batchPromises);
      
      // Small delay between batches to be gentle on the system
      if (i + batchSize < deliveriesToUpdate.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    return Response.json({
      message: 'Cleanup completed',
      totalDeliveries: deliveriesWithTime.length,
      needsCleaning: deliveriesToUpdate.length,
      alreadyClean: alreadyClean.length,
      updated: results.updated,
      errors: results.errors
    });

  } catch (error) {
    console.error('Error in cleanActualDeliveryTimes:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});