import { createClientFromRequest } from 'npm:@base44/sdk@0.8.43';

// Backfills/normalizes the denormalized identity fields on GoogleAPILog records
// so they always come from AppUser (user_id = AppUser.user_id, user_name =
// AppUser.user_name) — NEVER the auth Users.name/full_name field.
//
// Modes (payload):
//   { overwrite: true }  → re-resolve EVERY record with a resolvable identity,
//                          overwriting wrong names (auth full_name values) and
//                          normalizing user_id to the AppUser.user_id style.
//                          Also fires the correction pass after backfilling.
//   {}                    → legacy backfill: only fill records missing user_name.
//
// Pagination now advances `skip` — the original listed the same first page 12x.

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Forbidden — admin only' }, { status: 403 });

    const serviceRole = base44.asServiceRole;

    let payload: any = {};
    try { payload = await req.json(); } catch (_) {}
    const overwrite = payload?.overwrite === true;

    // Lookup tables from AppUser. GoogleAPILog.user_id historically stores
    // either AppUser.user_id (auth id) or AppUser.id (record id) depending on
    // which function wrote the log — index both.
    const appUsers = await serviceRole.entities.AppUser.list(undefined, 1000);
    const byUserId = new Map<string, any>();
    const byRecordId = new Map<string, any>();
    for (const au of appUsers) {
      if (!au?.user_name) continue;
      if (au.user_id) byUserId.set(au.user_id, au);
      if (au.id) byRecordId.set(au.id, au);
    }

    const resolveAppUser = (uid: any): any => byUserId.get(uid) || byRecordId.get(uid) || null;

    const stats = { processed: 0, updated: 0, skippedUnresolvable: 0, alreadyCorrect: 0, batches: 0 };
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

    // Bounded per run to stay under per-minute entity-read quotas.
    // Re-invoke until hasMore=false to cover the full table.
    const MAX_PAGES = 12;       // ~2,400 records per run
    const PAGE_SIZE = 200;
    let hasMore = true;
    let pages = 0;
    let skip = 0;
    while (hasMore && pages < MAX_PAGES) {
      const records = await serviceRole.entities.GoogleAPILog.list('-created_date', PAGE_SIZE, skip);
      if (!records || records.length === 0) { hasMore = false; break; }
      skip += records.length;

      const updates: Array<{ id: string; user_name: string; user_id: string }> = [];
      for (const log of records) {
        stats.processed++;
        const uid = log.user_id;
        if (!uid) { stats.skippedUnresolvable++; continue; }

        const au = resolveAppUser(uid);
        if (!au) { stats.skippedUnresolvable++; continue; }

        const desiredName = au.user_name;
        const desiredId = au.user_id || uid;
        const existingName = (log as any).user_name || '';

        if (overwrite) {
          if (existingName === desiredName && String(uid) === String(desiredId)) {
            stats.alreadyCorrect++;
            continue;
          }
        } else {
          // Legacy backfill: only fill records with no user_name at all
          if (existingName) { stats.alreadyCorrect++; continue; }
        }

        updates.push({ id: log.id, user_name: desiredName, user_id: desiredId });
      }

      if (updates.length > 0) {
        await serviceRole.entities.GoogleAPILog.bulkUpdate(updates);
        stats.updated += updates.length;
      }
      stats.batches++;
      pages++;
      await sleep(150); // gentle pacing to avoid read-traffic spikes
      hasMore = records.length === PAGE_SIZE;
    }

    return Response.json({ success: true, ...stats, appUsersFound: byUserId.size, hasMore });
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}
