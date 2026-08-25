import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

// Backfills the denormalized `user_name` field on existing UserDevice AND
// UserSettings records by resolving each record's `user_id` against the
// AppUser collection. Admin-only maintenance task.

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

    const result = {
      userDevices: { processed: 0, updated: 0, skipped: 0 },
      userSettings: { processed: 0, updated: 0, skipped: 0 },
      appUsersFound: nameByUserId.size
    };

    // 2) Backfill UserDevice records
    await backfillEntity('UserDevice', serviceRole, nameByUserId, result.userDevices);

    // 3) Backfill UserSettings records
    await backfillEntity('UserSettings', serviceRole, nameByUserId, result.userSettings);

    return Response.json({ success: true, ...result });
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}

// Shared per-entity backfill: paginate, filter records needing an update,
// and apply a single bulkUpdate per page.
async function backfillEntity(entityName: string, serviceRole: any, nameByUserId: Map<string, string>, stats: { processed: number; updated: number; skipped: number }) {
  let page = 0;
  const pageSize = 500;
  let hasMore = true;

  while (hasMore) {
    const records = await serviceRole.entities[entityName].list(undefined, pageSize);
    if (!records || records.length === 0) break;

    const updates: Array<{ id: string; user_name: string }> = [];
    for (const r of records) {
      stats.processed++;
      const existing = (r as any).user_name;
      const resolved = nameByUserId.get(r.user_id) || '';
      if (!resolved) {
        stats.skipped++;
        continue;
      }
      if (existing === resolved) continue; // already correct
      updates.push({ id: r.id, user_name: resolved });
    }

    if (updates.length > 0) {
      await serviceRole.entities[entityName].bulkUpdate(updates);
      stats.updated += updates.length;
    }

    hasMore = records.length === pageSize;
  }
}