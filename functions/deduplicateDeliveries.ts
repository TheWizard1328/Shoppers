import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const { incomingDeliveries } = body;

    if (!Array.isArray(incomingDeliveries) || incomingDeliveries.length === 0) {
      return Response.json({
        deletedCount: 0,
        deletedIds: [],
        message: 'No incoming deliveries to process'
      });
    }

    // Get unique stop_id + address + delivery_date tuples from incoming deliveries
    const incomingDuplicateKeys = new Map();
    incomingDeliveries.forEach((delivery) => {
      if (delivery.stop_id && delivery.delivery_address && delivery.delivery_date) {
        const key = `${delivery.stop_id}|${delivery.delivery_address.toLowerCase().trim()}|${delivery.delivery_date}`;
        if (!incomingDuplicateKeys.has(key)) {
          incomingDuplicateKeys.set(key, []);
        }
        incomingDuplicateKeys.get(key).push(delivery.id);
      }
    });

    // Query existing deliveries with matching stop_id and address
    const matchingKeys = Array.from(incomingDuplicateKeys.keys());
    if (matchingKeys.length === 0) {
      return Response.json({
        deletedCount: 0,
        deletedIds: [],
        message: 'No matching delivery patterns found for deduplication'
      });
    }

    // Build filter to find all existing deliveries with matching stop_id + address + delivery_date
    const existingDeliveriesToDelete = [];
    
    for (const key of matchingKeys) {
      const [stopId, address, deliveryDate] = key.split('|');
      
      try {
        const matches = await base44.entities.Delivery.filter({
          stop_id: stopId,
          delivery_address: address,
          delivery_date: deliveryDate
        }, '-created_date', 1000);

        // Only delete existing deliveries, not the ones being imported
        const incomingIds = new Set(incomingDuplicateKeys.get(key));
        const existingMatches = matches.filter(d => !incomingIds.has(d.id));
        
        existingDeliveriesToDelete.push(...existingMatches);
      } catch (error) {
        console.warn(`⚠️ [deduplicateDeliveries] Filter error for key "${key}":`, error.message);
      }
    }

    // Delete matching existing deliveries
    const deletedIds = [];
    for (const delivery of existingDeliveriesToDelete) {
      try {
        await base44.entities.Delivery.delete(delivery.id);
        deletedIds.push(delivery.id);
        console.log(`✅ [deduplicateDeliveries] Deleted duplicate delivery: ${delivery.id} (Date: ${delivery.delivery_date}, SID: ${delivery.stop_id}, Address: ${delivery.delivery_address})`);
      } catch (error) {
        console.warn(`⚠️ [deduplicateDeliveries] Failed to delete delivery ${delivery.id}:`, error.message);
      }
    }

    return Response.json({
      deletedCount: deletedIds.length,
      deletedIds,
      message: `Deleted ${deletedIds.length} duplicate deliveries with matching stop_id, address, and delivery_date`
    });
  } catch (error) {
    console.error('❌ [deduplicateDeliveries] Error:', error.message);
    return Response.json(
      { error: error.message },
      { status: 500 }
    );
  }
});