import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

/**
 * Updates last_used_at for the PushSubscription matching the given endpoint.
 *
 * Called by the PWA service worker (map-tile-sw.js) when a push event fires
 * on a specific device. This ensures last_used_at reflects when THAT device
 * actually received the push, rather than when the server sent to all of the
 * user's subscriptions in parallel.
 *
 * No user auth is required — the subscription endpoint is treated as a
 * shared secret (it is unique per device/browser and only known to that
 * device's service worker).
 */
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const { endpoint } = await req.json();
    if (!endpoint) return Response.json({ error: 'endpoint is required' }, { status: 400 });

    const subs = await base44.asServiceRole.entities.PushSubscription.filter({ endpoint });
    if (!subs || subs.length === 0) {
      return Response.json({ updated: 0, message: 'No subscription found for endpoint' });
    }

    await base44.asServiceRole.entities.PushSubscription.update(subs[0].id, {
      last_used_at: new Date().toISOString()
    });

    return Response.json({ updated: 1, last_used_at: new Date().toISOString() });
  } catch (error) {
    return Response.json({ error: error.message || 'Unknown error' }, { status: 500 });
  }
});