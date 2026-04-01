// Backend function - not imported into frontend
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { deliveryIds } = await req.json();

    if (!Array.isArray(deliveryIds) || deliveryIds.length === 0) {
      return Response.json({ error: 'deliveryIds must be a non-empty array' }, { status: 400 });
    }

    const uniqueDeliveryIds = [...new Set(deliveryIds.filter(Boolean))];
    const failedIds = [];
    let deletedCount = 0;

    for (const id of uniqueDeliveryIds) {
      try {
        await base44.asServiceRole.entities.Delivery.delete(id);
        deletedCount += 1;
      } catch (error) {
        const message = error?.message || '';
        const status = error?.response?.status;
        if (message.includes('not found') || message.includes('404') || status === 404) {
          continue;
        }
        failedIds.push(id);
      }
    }

    return Response.json({
      success: failedIds.length === 0,
      deletedCount,
      failedIds
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});