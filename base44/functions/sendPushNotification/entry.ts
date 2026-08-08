import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import webpush from 'npm:web-push@3.6.7';

// Payload: user_id (required), title (required), body (required), url (optional, default '/'), tag (optional), requireInteraction (optional), force (optional — bypass per-device push preference, used for app update broadcasts)
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { user_id, title, body, url, tag, requireInteraction, force } = await req.json();
    if (!user_id || !title || !body) return Response.json({ error: 'user_id, title, and body are required' }, { status: 400 });

    const vapidPublicKey = Deno.env.get('VAPID_PUBLIC_KEY');
    const vapidPrivateKey = Deno.env.get('VAPID_PRIVATE_KEY');
    const vapidSubject = Deno.env.get('VAPID_SUBJECT');
    if (!vapidPublicKey || !vapidPrivateKey || !vapidSubject) return Response.json({ error: 'VAPID keys not configured' }, { status: 500 });

    webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);

    // Fetch user settings ONCE to get per-device notification preferences.
    // notifications_enabled is now a DEVICE-SPECIFIC setting — each device
    // can independently enable/disable its own pushes. We map each
    // PushSubscription to its device profile via device_identifier.
    // Legacy subscriptions without device_identifier are conservatively
    // skipped if the user has explicitly disabled notifications on ANY
    // device (signals active use of the per-device toggle).
    let deviceProfiles = {};
    let hasAnyExplicitFalse = false;
    if (!force) {
      const userSettingsRecords = await base44.asServiceRole.entities.UserSettings.filter({ user_id }).catch(() => []);
      deviceProfiles = userSettingsRecords?.[0]?.device_settings_profiles || {};
      hasAnyExplicitFalse = Object.values(deviceProfiles).some(
        (p: any) => p?.notifications_enabled === false
      );
    }

    const subscriptions = await base44.asServiceRole.entities.PushSubscription.filter({ user_id });
    if (!subscriptions || subscriptions.length === 0) return Response.json({ sent: 0, message: 'No push subscriptions for this user' });

    const payload = JSON.stringify({ title, body, url: url || '/', tag: tag || undefined, requireInteraction: !!requireInteraction });

    let sent = 0, removed = 0, skipped = 0;
    const errors = [];
    await Promise.all(subscriptions.map(async (sub) => {
      // Per-device notification preference check (skip when force=true)
      if (!force) {
        let deviceEnabled = true; // default: allow unless explicitly disabled
        if (sub.device_identifier && deviceProfiles[sub.device_identifier]) {
          deviceEnabled = deviceProfiles[sub.device_identifier].notifications_enabled ?? true;
        } else if (hasAnyExplicitFalse) {
          // Legacy subscription (no device_identifier) — the user has explicitly
          // disabled notifications on at least one device, so conservatively skip
          // this unattributed subscription rather than guessing which device owns it.
          deviceEnabled = false;
        }
        if (!deviceEnabled) {
          skipped++;
          return;
        }
      }

      const pushSubscription = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh_key, auth: sub.auth_key } };
      try {
        await webpush.sendNotification(pushSubscription, payload);
        sent++;
        await base44.asServiceRole.entities.PushSubscription.update(sub.id, { last_used_at: new Date().toISOString() }).catch(() => {});
      } catch (err) {
        if (err?.statusCode === 410 || err?.statusCode === 404) {
          await base44.asServiceRole.entities.PushSubscription.delete(sub.id).catch(() => {});
          removed++;
        } else {
          errors.push({ endpoint: sub.endpoint, error: err.message || String(err) });
        }
      }
    }));

    return Response.json({ sent, removed, skipped, errors });
  } catch (error) {
    return Response.json({ error: error.message || 'Unknown error' }, { status: 500 });
  }
});