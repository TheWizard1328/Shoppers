import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { updates } = await req.json();
    if (!Array.isArray(updates) || updates.length === 0) {
      return Response.json({ error: 'updates must be a non-empty array' }, { status: 400 });
    }

    // Validate each update has id + data
    const valid = updates.every(u => u && typeof u.id === 'string' && u.data && typeof u.data === 'object');
    if (!valid) {
      return Response.json({ error: 'Each update must have { id: string, data: object }' }, { status: 400 });
    }

    // CRITICAL: Use USER-SCOPED writes (not asServiceRole) so each update triggers
    // a WebSocket broadcast to all connected devices. The previous asServiceRole
    // bulkUpdate silently updated the database WITHOUT triggering WS events,
    // causing remote devices to never receive the optimizer's stop_order, ETA,
    // polyline, and transport_mode updates. This was the root cause of the
    // 3-minute delay for Start Delivery data to appear on other devices.
    //
    // We use individual base44.entities.Delivery.update() calls in parallel
    // (Promise.allSettled) instead of asServiceRole.bulkUpdate() to ensure each
    // record's WS broadcast fires. The performance impact is acceptable
    // (N parallel HTTP calls vs 1 bulk call) — typical routes have 5-20 stops.
    const results = await Promise.allSettled(
      updates.map(u =>
        base44.entities.Delivery.update(u.id, u.data)
      )
    );

    const succeeded = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;

    if (failed > 0) {
      console.warn(`[bulkUpdateDeliveries] ${failed}/${updates.length} updates failed`);
      results.forEach((r, i) => {
        if (r.status === 'rejected') {
          console.warn(`[bulkUpdateDeliveries] Failed for ${updates[i].id}:`, r.reason?.message || r.reason);
        }
      });
    }

    return Response.json({ success: true, updatedCount: succeeded, failedCount: failed });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});
