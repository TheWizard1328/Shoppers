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

    if (user.role !== 'admin' && !roles.includes('admin')) {
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
    // 500/call — still ~25x the old per-id loop.
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