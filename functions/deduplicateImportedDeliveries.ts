import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Only admins can run deduplication
    if (user.role !== 'admin') {
      return Response.json({ error: 'Admin access required' }, { status: 403 });
    }

    const { driverId, deliveryDate, storeIds } = await req.json();

    console.log(`🔍 [Dedup] Checking for duplicates - driver: ${driverId}, date: ${deliveryDate}, stores: ${storeIds?.length || 'all'}`);

    // Step 1: Fetch ALL deliveries from online API
    let filter = {};
    if (deliveryDate) {
      filter.delivery_date = deliveryDate;
    }
    if (driverId) {
      filter.driver_id = driverId;
    }
    if (storeIds && storeIds.length > 0) {
      filter.store_id = { $in: storeIds };
    }

    const onlineDeliveries = await base44.asServiceRole.entities.Delivery.filter(filter, null, 10000);
    console.log(`📡 [Dedup] Loaded ${onlineDeliveries.length} online deliveries`);

    // Step 2: Group by stop_id + delivery_date + driver_id
    const duplicateGroups = new Map();

    onlineDeliveries.forEach((delivery) => {
      if (!delivery || !delivery.stop_id || !delivery.delivery_date) return;

      const key = `${delivery.driver_id}|${delivery.stop_id}|${delivery.delivery_date}`;

      if (!duplicateGroups.has(key)) {
        duplicateGroups.set(key, []);
      }
      duplicateGroups.get(key).push(delivery);
    });

    // Step 3: Find and delete duplicates (keep only the latest by updated_date)
    const toDelete = [];

    duplicateGroups.forEach((deliveries, key) => {
      if (deliveries.length > 1) {
        // Sort by updated_date DESC (newest first)
        deliveries.sort((a, b) => {
          const dateA = new Date(a.updated_date || a.created_date || 0);
          const dateB = new Date(b.updated_date || b.created_date || 0);
          return dateB - dateA;
        });

        // Keep the newest, delete the rest
        const [keepDelivery, ...deleteDuplicates] = deliveries;
        console.log(`⚠️ [Dedup] Found ${deleteDuplicates.length} duplicates for key "${key}" (keeping id: ${keepDelivery.id})`);
        toDelete.push(...deleteDuplicates);
      }
    });

    // Step 4: Delete duplicates in batches
    const deleteResults = [];
    const batchSize = 50;
    for (let i = 0; i < toDelete.length; i += batchSize) {
      const batch = toDelete.slice(i, i + batchSize);
      const ids = batch.map((d) => d.id);

      try {
        await base44.asServiceRole.entities.Delivery.delete({ id: { $in: ids } });
        deleteResults.push(...ids);
        console.log(`🗑️ [Dedup] Deleted batch of ${ids.length} duplicates`);
      } catch (error) {
        console.error(`❌ [Dedup] Failed to delete batch:`, error.message);
      }
    }

    console.log(`✅ [Dedup] Complete - Deleted ${deleteResults.length} duplicate deliveries`);

    return Response.json({
      success: true,
      totalOnline: onlineDeliveries.length,
      duplicateGroups: duplicateGroups.size,
      totalDuplicatesDeleted: deleteResults.length,
      deletedIds: deleteResults
    });
  } catch (error) {
    console.error('❌ [Dedup] Error:', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
});