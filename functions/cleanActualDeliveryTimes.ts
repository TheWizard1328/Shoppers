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

    const { batchSize = 100, dryRun = false, startDate = '2026-01-01', endDate = '2027-01-01' } = await req.json().catch(() => ({}));

    // Fetch deliveries in the specified date range (inclusive start, exclusive end)
    const response = await base44.asServiceRole.entities.Delivery.filter({ delivery_date: { $gte: startDate, $lt: endDate } });

    // Handle different response structures
    const allDeliveries = Array.isArray(response) ? response : (response?.data || response?.records || []);
    console.log(`Total deliveries fetched: ${allDeliveries?.length || 0}`);

    const deliveriesWithTime = allDeliveries.filter(d => d.actual_delivery_time);
    console.log(`Found ${deliveriesWithTime.length} deliveries with actual_delivery_time`);

    // Find deliveries with timezone offset (string length > 19)
    // "2026-02-13T17:10:00" is 19 chars, anything longer has timezone info
    const deliveriesToUpdate = [];
    const alreadyClean = [];

    for (const delivery of deliveriesWithTime) {
      const original = delivery.actual_delivery_time;

      // Check if string is longer than 19 characters (has timezone offset)
      if (original.length > 19) {
        const sanitized = original.substring(0, 19);
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

      // Process each delivery sequentially within the batch to avoid rate limits
      for (const { id, sanitized } of batch) {
        try {
          await base44.asServiceRole.entities.Delivery.update(id, {
            actual_delivery_time: sanitized
          });
          results.updated++;

          // Small delay between each update
          await new Promise(resolve => setTimeout(resolve, 100));
        } catch (error) {
          console.error(`Failed to update delivery ${id}:`, error.message);
          results.errors++;
        }
      }

      // Longer delay between batches
      if (i + batchSize < deliveriesToUpdate.length) {
        console.log('Waiting 2 seconds before next batch...');
        await new Promise(resolve => setTimeout(resolve, 2000));
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