import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// One-time repair: find any user with MORE THAN ONE UserDevice record
// flagged is_primary_tracker=true (should be impossible — caused by a
// bug in DevicesPanel.jsx's edit-device form handler that didn't clear
// the old primary when a new one was set). Keeps the most recently
// active device as primary, demotes the rest.
//
// Safe to call multiple times — it's idempotent (no-ops if already clean).
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const isAuthenticated = await base44.auth.isAuthenticated();
    if (!isAuthenticated) {
      return new Response(JSON.stringify({ error: 'Not authenticated' }), { status: 401 });
    }
    const me = await base44.auth.me();
    if (me?.role !== 'admin') {
      return new Response(JSON.stringify({ error: 'Admin only' }), { status: 403 });
    }

    const allPrimary = await base44.asServiceRole.entities.UserDevice.filter({ is_primary_tracker: true });

    const byUser = new Map<string, any[]>();
    for (const dev of allPrimary || []) {
      const uid = dev.user_id;
      if (!uid) continue;
      if (!byUser.has(uid)) byUser.set(uid, []);
      byUser.get(uid)!.push(dev);
    }

    const fixed: any[] = [];
    for (const [userId, devs] of byUser.entries()) {
      if (devs.length <= 1) continue;

      const sorted = [...devs].sort((a, b) =>
        new Date(b.last_active_at || 0).getTime() - new Date(a.last_active_at || 0).getTime()
      );
      const keep = sorted[0];
      const demote = sorted.slice(1);

      for (const d of demote) {
        await base44.asServiceRole.entities.UserDevice.update(d.id, { is_primary_tracker: false });
        fixed.push({
          user_id: userId,
          demoted_device_id: d.id,
          demoted_device_name: d.device_name,
          demoted_last_active: d.last_active_at,
          kept_device_id: keep.id,
          kept_device_name: keep.device_name,
          kept_last_active: keep.last_active_at,
        });
      }
    }

    return new Response(JSON.stringify({
      success: true,
      usersScanned: byUser.size,
      duplicatesFixed: fixed.length,
      details: fixed,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err?.message || String(err) }), { status: 500 });
  }
});
