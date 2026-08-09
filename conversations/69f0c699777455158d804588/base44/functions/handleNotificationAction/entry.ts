import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

/**
 * handleNotificationAction — processes push notification action button clicks
 * that fire in the service worker while the app may be closed.
 *
 * Actions:
 *   - "mark_read":     marks a Message entity as read (by message_id)
 *   - "acknowledge":   marks Delivery records as acknowledged (by delivery_ids array)
 *
 * The SW reads the user's auth token from the IndexedDB bridge and sends it
 * as a Bearer token, so this function runs with the user's permissions.
 */
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { action, message_id, delivery_ids } = await req.json();

    if (action === 'mark_read') {
      if (!message_id) return Response.json({ error: 'message_id required' }, { status: 400 });

      // Mark the message as read
      await base44.entities.Message.update(message_id, { read: true });
      return Response.json({ success: true, action: 'mark_read', message_id });

    } else if (action === 'acknowledge') {
      if (!delivery_ids || !Array.isArray(delivery_ids) || delivery_ids.length === 0) {
        return Response.json({ error: 'delivery_ids array required' }, { status: 400 });
      }

      const now = new Date().toISOString();

      // Acknowledge all specified deliveries — scoped to the current user's driver_id
      // for security (only the assigned driver can acknowledge their own deliveries)
      const results = await Promise.all(delivery_ids.map(async (deliveryId) => {
        try {
          // Fetch the delivery to verify ownership
          const delivery = await base44.entities.Delivery.get(deliveryId);
          if (!delivery) return { id: deliveryId, success: false, error: 'not found' };
          if (delivery.driver_id !== user.id) return { id: deliveryId, success: false, error: 'not assigned to user' };

          await base44.entities.Delivery.update(deliveryId, {
            driver_acknowledged: true,
            driver_acknowledged_at: now
          });
          return { id: deliveryId, success: true };
        } catch (err) {
          return { id: deliveryId, success: false, error: err.message || String(err) };
        }
      }));

      const succeeded = results.filter(r => r.success).length;
      return Response.json({ success: true, action: 'acknowledge', acknowledged: succeeded, total: delivery_ids.length, results });

    } else {
      return Response.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }

  } catch (error) {
    return Response.json({ error: error.message || 'Unknown error' }, { status: 500 });
  }
});
