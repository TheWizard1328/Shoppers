import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

/**
 * Updates last_used_at for the PushSubscription matching the given endpoint.
 *
 * Called by the PWA service worker (map-tile-sw.js) when a push event fires
 * on a specific device. This ensures last_used_at reflects when THAT device
 * actually received the push, rather than when the server sent to all of the
 * user's subscriptions in parallel.
 *
 * Devices that have push notifications explicitly disabled in their per-device
 * UserSettings profile should never receive a push (sendPushNotification skips
 * them). As defense-in-depth, this function ALSO refuses to update last_used_at
 * for a device whose notifications_enabled === false — so a stray push that
 * slipped through (e.g. sent before the toggle flipped) does not pollute the
 * "last used" timestamp and falsely imply the device is active.
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

    const sub = subs[0];

    // Defense-in-depth: do not stamp last_used_at for a device that has
    // notifications explicitly disabled. The server already skips sending
    // to these devices; this guard catches stray pushes that arrived out of
    // order (e.g. sent before the toggle was flipped).
    if (sub.device_identifier) {
      const userSettingsRecords = await base44.asServiceRole.entities.UserSettings
        .filter({ user_id: sub.user_id })
        .catch(() => []);
      const deviceProfiles = userSettingsRecords?.[0]?.device_settings_profiles || {};
      const profile = deviceProfiles[sub.device_identifier];
      if (profile && profile.notifications_enabled === false) {
        return Response.json({ updated: 0, skipped: true, reason: 'notifications_disabled_on_device' });
      }
    }

    await base44.asServiceRole.entities.PushSubscription.update(sub.id, {
      last_used_at: new Date().toISOString()
    });

    return Response.json({ updated: 1, last_used_at: new Date().toISOString() });
  } catch (error) {
    return Response.json({ error: error.message || 'Unknown error' }, { status: 500 });
  }
});