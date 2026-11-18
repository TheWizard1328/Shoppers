import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

/**
 * announceWebBuild — publish watchdog (owner request Nov 17 2026).
 *
 * "All of the web versions auto updated whenever a publish is made, whether it's
 * minimized or backgrounded."
 *
 * A suspended page cannot run its own timers, so this runs as a schedule
 * (every 5 minutes). It reads the LIVE published version.json, compares the
 * buildId against the last one it announced (AppSettings key
 * 'web_build_announcement'), and when the build changes it:
 *   1. writes one "System Updates" message per user, so every device that comes
 *      back to the foreground sees the update bubble / prompt, and
 *   2. pushes to every device with type 'update_available', which push-sw.js
 *      uses to navigate backgrounded windows straight onto the new bundle.
 *
 * Idempotent: the marker is written before pushing, so a second run in the same
 * build does nothing. `force` overrides the marker (used for manual testing).
 */

const LIVE_BUILD_URL = 'https://rxdeliver.wizardworxx.com/version.json';
const MARKER_KEY = 'web_build_announcement';
const SYSTEM_SENDER_ID = 'system_updates';
const SYSTEM_SENDER_NAME = 'System Updates';
const TRIGGER_PHRASE = 'Your app has just been updated.';
const BROADCAST_BODY = `${TRIGGER_PHRASE} Please click the update button to complete the update. Will restart your app and apply the update.`;

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    let payload = {};
    try { payload = await req.json(); } catch { /* allow empty */ }
    const force = payload?.force === true;
    const dryRun = payload?.dryRun === true;

    // ── 1. What is published right now? ────────────────────────────────────
    const res = await fetch(`${LIVE_BUILD_URL}?cb=${Date.now()}`, { headers: { 'Cache-Control': 'no-cache' } });
    if (!res.ok) return Response.json({ success: false, error: `version.json HTTP ${res.status}` }, { status: 502 });
    const live = await res.json();
    const liveBuildId = live?.buildId || null;
    const liveBuildNumber = live?.buildNumber ?? null;
    if (!liveBuildId) return Response.json({ success: false, error: 'version.json had no buildId' }, { status: 502 });

    // ── 2. What did we announce last? ──────────────────────────────────────
    const markerRows = await base44.asServiceRole.entities.AppSettings.filter({ setting_key: MARKER_KEY });
    const marker = Array.isArray(markerRows) ? markerRows[0] : null;
    const announcedBuildId = marker?.setting_value?.buildId || null;

    if (!force && announcedBuildId === liveBuildId) {
      return Response.json({ success: true, action: 'none', buildId: liveBuildId, announcedBuildId });
    }
    if (dryRun) {
      return Response.json({ success: true, action: 'would_announce', buildId: liveBuildId, announcedBuildId, buildNumber: liveBuildNumber });
    }

    // Marker first: a failure part-way must not re-announce on the next tick.
    const markerValue = { buildId: liveBuildId, buildNumber: liveBuildNumber, announced_at: new Date().toISOString() };
    if (marker?.id) {
      await base44.asServiceRole.entities.AppSettings.update(marker.id, { setting_value: markerValue });
    } else {
      await base44.asServiceRole.entities.AppSettings.create({
        setting_key: MARKER_KEY,
        setting_value: markerValue,
        description: 'Last published web build announced to devices (auto-update watchdog)',
      });
    }

    // ── 3. Tell every user ─────────────────────────────────────────────────
    const users = await base44.asServiceRole.entities.AppUser.list();
    const list = Array.isArray(users) ? users : (users?.items || []);
    let messages = 0;
    let pushes = 0;
    const errors = [];

    for (const user of list) {
      const userId = user?.user_id || user?.id;
      if (!user?.id || !userId) continue;
      let messageId = null;
      try {
        const message = await base44.asServiceRole.entities.Message.create({
          sender_id: SYSTEM_SENDER_ID,
          sender_name: SYSTEM_SENDER_NAME,
          receiver_id: user.id,
          receiver_name: user.user_name || user.full_name || 'User',
          conversation_id: [SYSTEM_SENDER_ID, user.id].sort().join('_'),
          content: BROADCAST_BODY,
          read: false,
        });
        messageId = message?.id || null;
        messages += 1;
      } catch (e) {
        errors.push({ stage: 'message', user: user.id, error: String(e?.message || e) });
      }

      try {
        await base44.asServiceRole.functions.invoke('sendPushNotification', {
          user_id: userId,
          title: 'App Update Available',
          body: 'There is an update available. App restart required.',
          url: '/',
          force: true,
          requireInteraction: true,
          actions: [{ action: 'update_now', title: 'Update Now' }],
          data: {
            type: 'update_available',
            message_id: messageId || undefined,
            build_id: liveBuildId,
          },
        });
        pushes += 1;
      } catch (e) {
        errors.push({ stage: 'push', user: user.id, error: String(e?.message || e) });
      }
    }

    return Response.json({
      success: true,
      action: 'announced',
      buildId: liveBuildId,
      previousBuildId: announcedBuildId,
      buildNumber: liveBuildNumber,
      users: list.length,
      messages,
      pushes,
      errors: errors.slice(0, 10),
    });
  } catch (e) {
    return Response.json({ success: false, error: String(e?.message || e) }, { status: 500 });
  }
});
