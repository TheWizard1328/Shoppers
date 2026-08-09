import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

/**
 * Handles push notification action button clicks from the PWA service worker.
 *
 * Called by map-tile-sw.js when a user taps a button on a persistent push
 * notification (e.g. "Mark Read", "Acknowledge", "Reply"). The SW passes the
 * auth token from the bridge IndexedDB so base44.auth.me() identifies the
 * user who tapped the button.
 *
 * Supported actions:
 *   mark_read   — marks a Message entity as read (only the receiver's own
 *                 messages can be marked; receiver_id must match auth user id).
 *   acknowledge — a driver acknowledges receipt of pending deliveries.
 *                 Sends a Message back to the dispatcher(s) who assigned the
 *                 stops: "[Driver] has Acknowledged receipt of pending deliveries."
 *                 Also sets driver_acknowledged=true + driver_acknowledged_at
 *                 on the matched Delivery records.
 */
export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { action, message_id, delivery_ids } = await req.json();

    // ── mark_read: mark a message as read ──────────────────────────────────
    if (action === 'mark_read' && message_id) {
      // Defense-in-depth: verify the message belongs to this user before
      // marking it (the service-role update bypasses RLS). The filter can
      // throw on invalid/non-existent ids, so wrap it.
      let msg: any = null;
      try {
        const messages = await base44.asServiceRole.entities.Message.filter({ id: message_id });
        msg = messages?.[0] || null;
      } catch { /* treat as not found */ }
      if (!msg) {
        return Response.json({ ok: true, action: 'mark_read', skipped: 'not_found' });
      }
      if (msg.receiver_id !== user.id) {
        return Response.json({ ok: true, action: 'mark_read', skipped: 'not_authorized' });
      }
      await base44.asServiceRole.entities.Message.update(message_id, { read: true });
      return Response.json({ ok: true, action: 'mark_read' });
    }

    // ── acknowledge: driver acknowledges pending deliveries ────────────────
    if (action === 'acknowledge' && Array.isArray(delivery_ids) && delivery_ids.length > 0) {
      // Fetch the matched deliveries (filter one-by-one for SDK compatibility)
      const deliveries = [];
      for (const did of delivery_ids) {
        try {
          const d = await base44.asServiceRole.entities.Delivery.filter({ id: did });
          if (d && d.length > 0) deliveries.push(d[0]);
        } catch { /* skip missing */ }
      }
      if (deliveries.length === 0) {
        return Response.json({ ok: true, action: 'acknowledge', skipped: 'no_deliveries' });
      }

      // Get the driver's AppUser for display name
      const driverAppUsers = await base44.asServiceRole.entities.AppUser.filter({ user_id: user.id });
      const driverAppUser = driverAppUsers?.[0];
      const driverName = driverAppUser?.user_name || user.full_name || 'Driver';
      const messageContent = `${driverName} has Acknowledged receipt of pending deliveries.`;

      // Find recipients: dispatchers for the deliveries' stores + admins + delivery creator
      const storeIds = [...new Set(deliveries.map(d => d.store_id).filter(Boolean))];
      const creatorIds = [...new Set(deliveries.map(d => d.created_by_app_user_id).filter(Boolean))];

      const allAppUsers = await base44.asServiceRole.entities.AppUser.list(200);

      const dispatchers = (allAppUsers || []).filter((au: any) =>
        au.status === 'active' &&
        Array.isArray(au.app_roles) &&
        au.app_roles.includes('dispatcher') &&
        Array.isArray(au.store_ids) &&
        au.store_ids.some((sid: string) => storeIds.includes(sid))
      );

      const admins = (allAppUsers || []).filter((au: any) =>
        au.status === 'active' &&
        Array.isArray(au.app_roles) &&
        au.app_roles.includes('admin')
      );

      const creatorAppUsers = (allAppUsers || []).filter((au: any) => creatorIds.includes(au.id));

      // Combine and deduplicate by user_id
      const allRecipients = [...dispatchers, ...admins, ...creatorAppUsers];
      const seen = new Set<string>();
      let notifiedCount = 0;

      for (const recipient of allRecipients) {
        const rid = recipient.user_id || recipient.id;
        if (!rid || rid === user.id || seen.has(rid)) continue;
        seen.add(rid);

        const conversationId = [user.id, rid].sort().join('_');
        try {
          await base44.asServiceRole.entities.Message.create({
            sender_id: user.id,
            sender_name: driverName,
            receiver_id: rid,
            receiver_name: recipient.user_name || 'User',
            conversation_id: conversationId,
            content: messageContent,
            read: false,
          });
          notifiedCount++;
        } catch { /* skip individual failures */ }
      }

      // Mark deliveries as driver_acknowledged (best-effort, non-blocking for response)
      const updatePayload = delivery_ids.map((id: string) => ({
        id,
        driver_acknowledged: true,
        driver_acknowledged_at: new Date().toISOString(),
      }));
      await base44.asServiceRole.entities.Delivery.bulkUpdate(updatePayload).catch(() => {});

      return Response.json({ ok: true, action: 'acknowledge', notified: notifiedCount });
    }

    return Response.json({ error: 'Unknown action or missing parameters' }, { status: 400 });
  } catch (error) {
    return Response.json({ error: (error as Error).message || 'Unknown error' }, { status: 500 });
  }
}