import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

// Backfills the denormalized `user_name` field on existing UserDevice records
// by resolving each device's `user_id` against the AppUser collection.
// Admin-only maintenance task.

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Forbidden — admin only' }, { status: 403 });

    const serviceRole = base44.asServiceRole;

    // 1) Load all AppUsers and build a user_id -> user_name lookup
    const appUsers = await serviceRole.entities.AppUser.list(undefined, 1000);
    const nameByUserId = new Map<string, string>();
    for (const au of appUsers) {
      if (au?.user_id && au.user_name) {
        nameByUserId.set(au.user_id, au.user_name);
      }
    }

    // 2) Load all UserDevice records (paginate to be safe)
    let processed = 0;
    let updated = 0;
    let skipped = 0;
    let page = 1;
    const pageSize = 500;
    let hasMore = true;

    while (hasMore) {
      const devices = await serviceRole.entities.UserDevice.list(undefined, pageSize);
      if (!devices || devices.length === 0) break;

      const updates: Array<{ id: string; user_name: string }> = [];
      for (const d of devices) {
        processed++;
        const existing = (d as any).user_name;
        const resolved = nameByUserId.get(d.user_id) || '';
        if (!resolved) {
          skipped++;
          continue;
        }
        if (existing === resolved) continue; // already correct
        updates.push({ id: d.id, user_name: resolved });
      }

      if (updates.length > 0) {
        await serviceRole.entities.UserDevice.bulkUpdate(updates);
        updated += updates.length;
      }

      hasMore = devices.length === pageSize;
    }

    return Response.json({
      success: true,
      processed,
      updated,
      skipped,
      appUsersFound: nameByUserId.size
    });
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}