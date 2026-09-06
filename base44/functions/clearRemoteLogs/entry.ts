import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const appUsers = await base44.asServiceRole.entities.AppUser.filter({ user_id: user.id }, '', 1);
    const appUser = appUsers?.[0];
    const roles = appUser?.app_roles || [];
    const isAdmin = user.role === 'admin' || roles.includes('admin');

    let payload: any = {};
    try { payload = await req.json(); } catch (_) {}
    const retentionHours = Number(payload?.retention_hours) || 0;

    // ── TRIM MODE: keep only the last N hours of logs ──────────────────────
    // Authorized for admins AND users included in the logging settings (the
    // same people whose devices produce the logs). Auto-invoked hourly by the
    // client logger's flush cycle, so retention is enforced without any
    // scheduler dependency.
    if (retentionHours > 0) {
      if (!isAdmin) {
        const settingsRows = await base44.asServiceRole.entities.RemoteLoggingSettings.filter({ scope: 'global' }, '-updated_date', 1);
        const included = settingsRows?.[0]?.included_user_ids;
        if (!Array.isArray(included) || !included.includes(user.id)) {
          return Response.json({ error: 'Forbidden: Admin or included logger required' }, { status: 403 });
        }
      }

      const cutoff = new Date(Date.now() - retentionHours * 3600 * 1000).toISOString();

      // Fast path: operator-based bulk delete on the indexed created_date.
      try {
        const result = await base44.asServiceRole.entities.RemoteLogEntry.deleteMany({ created_date: { $lt: cutoff } });
        return Response.json({ success: true, deleted: result?.deleted || 0, has_more: false, mode: 'trim-deleteMany' });
      } catch (_) {
        // Fallback: collect old ids (indexed created_date filter) and batch-delete.
        const BATCH = 500;
        const rows = await base44.asServiceRole.entities.RemoteLogEntry.filter({ created_date: { $lt: cutoff } }, 'created_date', BATCH, 0, ['id']);
        const ids = (rows || []).map((r) => r?.id).filter(Boolean);

        if (ids.length === 0) {
          return Response.json({ success: true, deleted: 0, has_more: false, mode: 'trim-empty' });
        }

        try {
          const result = await base44.asServiceRole.entities.RemoteLogEntry.deleteMany({ id: ids });
          return Response.json({ success: true, deleted: result?.deleted || ids.length, has_more: ids.length === BATCH, mode: 'trim-ids' });
        } catch (_) {
          let deleted = 0;
          for (const id of ids) {
            try {
              await base44.asServiceRole.entities.RemoteLogEntry.delete(id);
              deleted += 1;
            } catch (_) {}
          }
          return Response.json({ success: true, deleted, has_more: ids.length === BATCH, mode: 'trim-per-id' });
        }
      }
    }

    // ── PURGE-ALL MODE: Clear Logs button (admin only) ────────────────────
    if (!isAdmin) {
      return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
    }

    // Fast path: deleteMany with an empty query — instant server-side bulk
    // purge of the whole table (admin explicitly clicked Clear Logs).
    try {
      const result = await base44.asServiceRole.entities.RemoteLogEntry.deleteMany({});
      return Response.json({ success: true, deleted: result?.deleted || 0, has_more: false, mode: 'deleteMany-empty' });
    } catch (_) {
      // Some deployments reject empty-query deleteMany — fall through to the
      // id-batch path below.
    }

    // Fallback: list a batch of ids and deleteMany via the array-shorthand
    // query (Partial<T> supports arrays as "match any listed value").
    const BATCH = 500;
    const rows = await base44.asServiceRole.entities.RemoteLogEntry.list('-created_date', BATCH);
    const ids = (rows || []).map((r) => r?.id).filter(Boolean);

    if (ids.length === 0) {
      return Response.json({ success: true, deleted: 0, has_more: false, mode: 'empty-table' });
    }

    try {
      const result = await base44.asServiceRole.entities.RemoteLogEntry.deleteMany({ id: ids });
      return Response.json({ success: true, deleted: result?.deleted || ids.length, has_more: ids.length === BATCH, mode: 'deleteMany-ids' });
    } catch (_) {
      // Last resort: sequential per-id deletes (old behavior, but 500/call)
      let deleted = 0;
      for (const id of ids) {
        try {
          await base44.asServiceRole.entities.RemoteLogEntry.delete(id);
          deleted += 1;
        } catch (_) {}
      }
      return Response.json({ success: true, deleted, has_more: ids.length === BATCH, mode: 'per-id' });
    }
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});
