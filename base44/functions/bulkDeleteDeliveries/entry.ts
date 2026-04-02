import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const payload = await req.json().catch(() => ({}));
    const deliveryIds = Array.from(new Set((payload?.deliveryIds || []).filter(Boolean)));

    if (deliveryIds.length === 0) {
      return Response.json({ success: true, deletedIds: [], failedIds: [] });
    }

    const BATCH_SIZE = 200;
    const deletedIds = [];
    const failedIds = [];

    for (let i = 0; i < deliveryIds.length; i += BATCH_SIZE) {
      const batchIds = deliveryIds.slice(i, i + BATCH_SIZE);
      const existingRecords = await base44.asServiceRole.entities.Delivery.filter({ id: { $in: batchIds } }, '-updated_date', BATCH_SIZE);
      const existingIds = new Set((existingRecords || []).map((record) => record.id).filter(Boolean));

      await Promise.allSettled(
        batchIds.map(async (id) => {
          if (!existingIds.has(id)) {
            return;
          }
          await base44.asServiceRole.entities.Delivery.delete(id);
        })
      ).then((results) => {
        results.forEach((result, index) => {
          const id = batchIds[index];
          if (!existingIds.has(id)) {
            deletedIds.push(id);
            return;
          }
          if (result.status === 'fulfilled') {
            deletedIds.push(id);
          } else {
            failedIds.push(id);
          }
        });
      });
    }

    return Response.json({
      success: failedIds.length === 0,
      deletedIds,
      failedIds
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});