// Authoritative server-side clear-all-then-promote for isNextDelivery flags.
//
// Called by handleStartDelivery (Start button) and handleStatusUpdate (Complete /
// Failed / Cancel-pickup) to guarantee that EVERY isNextDelivery=true flag on a
// driver+date route is set to false — and broadcast — BEFORE the single new next
// stop is promoted to true.
//
// Runs as the service role so the initial filter reads from primary (not a
// read replica), catching stale trues the client's app-user SDK filter can miss.
// All clears are awaited (so every false WS event is emitted) before the single
// promote write is issued — guaranteeing receiving devices see all clears first.
//
// Input:  { driverId, deliveryDate, promoteId }
// Output: { success, clearedIds, promotedId }

import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const driverId = body?.driverId;
    const deliveryDate = body?.deliveryDate;
    const promoteId = body?.promoteId || null;

    if (!driverId || !deliveryDate) {
      return Response.json({ error: 'Missing driverId or deliveryDate' }, { status: 400 });
    }

    // Authoritative read of every isNextDelivery=true on this route (service role
    // = primary, no replica lag). Catches stale trues the client snapshot missed.
    const trues = await base44.asServiceRole.entities.Delivery.filter({
      driver_id: driverId,
      delivery_date: deliveryDate,
      isNextDelivery: true,
    }, '-updated_date', 500);

    const toClear = (trues || []).filter((d) => d?.id && d.id !== promoteId);

    // Phase 1: clear every stale true EXCEPT the promote target. Await ALL clears
    // so the platform broadcasts every false event before the promote below.
    const clearedIds = [];
    if (toClear.length > 0) {
      await Promise.all(
        toClear.map(async (d) => {
          try {
            await base44.asServiceRole.entities.Delivery.update(d.id, { isNextDelivery: false });
            clearedIds.push(d.id);
          } catch (err) {
            console.warn(`[clearAndSetNextDelivery] clear failed for ${d.id}:`, err?.message || err);
          }
        })
      );
    }

    // Phase 2: promote the target LAST — its true broadcast arrives after every false.
    if (promoteId) {
      try {
        await base44.asServiceRole.entities.Delivery.update(promoteId, { isNextDelivery: true });
      } catch (err) {
        console.warn(`[clearAndSetNextDelivery] promote failed for ${promoteId}:`, err?.message || err);
      }
    }

    return Response.json({ success: true, clearedIds, promotedId: promoteId || null });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});