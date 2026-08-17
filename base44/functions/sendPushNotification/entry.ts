import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import webpush from 'npm:web-push@3.6.7';

// Payload: user_id (required), title (required), body (required), url (optional, default '/'), tag (optional), requireInteraction (optional), force (optional — bypass per-device push preference, used for app update broadcasts)
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { user_id, title, body, url, tag, requireInteraction, force, actions, data } = await req.json();
    if (!user_id || !title || !body) return Response.json({ error: 'user_id, title, and body are required' }, { status: 400 });

    // ── VAPID config (Web Push) ──────────────────────────────────────
    const vapidPublicKey = Deno.env.get('VAPID_PUBLIC_KEY');
    const vapidPrivateKey = Deno.env.get('VAPID_PRIVATE_KEY');
    const vapidSubject = Deno.env.get('VAPID_SUBJECT');

    // ── FCM config (Native Android) ───────────────────────────────────
    const fcmServerKey = Deno.env.get('FCM_SERVER_KEY');

    // Fetch user settings ONCE to get per-device notification preferences.
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

    const notifData = { title, body, url: url || '/', tag: tag || undefined, requireInteraction: !!requireInteraction };
    if (actions) notifData.actions = actions;
    if (data) notifData.data = data;

    let sent = 0, removed = 0, skipped = 0, fcmSent = 0, webSent = 0;
    const errors = [];

    await Promise.all(subscriptions.map(async (sub) => {
      if (!force) {
        let deviceEnabled = true;
        if (sub.device_identifier && deviceProfiles[sub.device_identifier]) {
          deviceEnabled = deviceProfiles[sub.device_identifier].notifications_enabled ?? true;
        } else if (hasAnyExplicitFalse) {
          deviceEnabled = false;
        }
        if (!deviceEnabled) { skipped++; return; }
      }

      const isFCM = sub.endpoint?.startsWith('fcm://');

      if (isFCM) {
        const fcmToken = sub.endpoint.replace('fcm://', '');
        if (!fcmToken) { skipped++; return; }
        if (!fcmServerKey) {
          errors.push({ endpoint: sub.endpoint, error: 'FCM_SERVER_KEY not configured' });
          return;
        }
        try {
          const fcmPayload = {
            to: fcmToken,
            notification: { title, body, tag: tag || undefined },
            data: { url: url || '/', ...(data || {}) },
            android: { notification: { tag: tag || undefined, click_action: url || '/' }, priority: 'high' },
          };
          const fcmResponse = await fetch('https://fcm.googleapis.com/fcm/send', {
            method: 'POST',
            headers: { 'Authorization': `key=${fcmServerKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(fcmPayload),
          });
          if (fcmResponse.ok) {
            const fcmResult = await fcmResponse.json();
            if (fcmResult.success) { sent++; fcmSent++; }
            else if (fcmResult.results?.[0]?.error === 'InvalidRegistration' || fcmResult.results?.[0]?.error === 'NotRegistered') {
              await base44.asServiceRole.entities.PushSubscription.delete(sub.id).catch(() => {});
              removed++;
            } else {
              errors.push({ endpoint: sub.endpoint, error: fcmResult.results?.[0]?.error || 'FCM send failed' });
            }
          } else if (fcmResponse.status === 400 || fcmResponse.status === 404) {
            await base44.asServiceRole.entities.PushSubscription.delete(sub.id).catch(() => {});
            removed++;
          } else {
            errors.push({ endpoint: sub.endpoint, error: `FCM HTTP ${fcmResponse.status}` });
          }
        } catch (err) {
          errors.push({ endpoint: sub.endpoint, error: err.message || String(err) });
        }
      } else {
        if (!vapidPublicKey || !vapidPrivateKey || !vapidSubject) {
          errors.push({ endpoint: sub.endpoint, error: 'VAPID keys not configured' });
          return;
        }
        try {
          webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
          const pushSubscription = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh_key, auth: sub.auth_key } };
          await webpush.sendNotification(pushSubscription, JSON.stringify(notifData));
          sent++; webSent++;
        } catch (err) {
          if (err?.statusCode === 410 || err?.statusCode === 404) {
            await base44.asServiceRole.entities.PushSubscription.delete(sub.id).catch(() => {});
            removed++;
          } else {
            errors.push({ endpoint: sub.endpoint, error: err.message || String(err) });
          }
        }
      }
    }));

    return Response.json({ sent, removed, skipped, fcmSent, webSent, errors });
  } catch (error) {
    return Response.json({ error: error.message || 'Unknown error' }, { status: 500 });
  }
});
