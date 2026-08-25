import { createClientFromRequest } from 'npm:@base44/sdk@0.8.43';

// Backfills the denormalized `user_name` field on existing GoogleAPILog records
// by resolving each record's `user_id` against the AppUser collection.
//
// Two passes:
//   1) Records that already have user_name are left untouched.
//   2) Records that have a user_id but no user_name get user_name resolved from AppUser
//      (matched by AppUser.id OR AppUser.user_id — both identifier styles are stored
//      in GoogleAPILog.user_id depending on which backend function created the log).
//
// Records with no user_id at all cannot be backfilled (no identity to resolve from);
// going forward those are populated at creation time by the fixed client + backend loggers.
//
// Admin-only maintenance task.

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Forbidden — admin only' }, { status: 403 });

    const serviceRole = base44.asServiceRole;

    // Build lookup tables from AppUser — by AppUser.id and by AppUser.user_id.
    // GoogleAPILog.user_id is stored inconsistently: the Google Places/Directions
    // backend functions store AppUser.id, the client-side HERE engine stores the
    // driver's auth user_id. Index both so we can resolve any log.
    const appUsers = await serviceRole.entities.AppUser.list(undefined, 1000);
    const nameById = new Map<string, string>();
    const nameByUserId = new Map<string, string>();
    for (const au of appUsers) {
      if (!au) continue;
      const name = au.user_name || au.full_name || '';
      if (au.id && name) nameById.set(au.id, name);
      if (au.user_id && name) nameByUserId.set(au.user_id, name);
    }

    const stats = { processed: 0, updated: 0, skippedNoUserId: 0, skippedNoName: 0, alreadyHasName: 0, batches: 0 };
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

    // Bounded per run to stay under the platform's per-minute entity-read quota.
    // Re-invoke until hasMore=false to cover the full table.
    const MAX_PAGES = 12;       // ~2,400 records per run
    const PAGE_SIZE = 200;
    let hasMore = true;
    let pages = 0;
    while (hasMore && pages < MAX_PAGES) {
      const records = await serviceRole.entities.GoogleAPILog.list('-created_date', PAGE_SIZE);
      if (!records || records.length === 0) { hasMore = false; break; }

      const updates: Array<{ id: string; user_name: string }> = [];
      for (const log of records) {
        stats.processed++;
        const existing = (log as any).user_name;
        const uid = log.user_id;
        if (existing) { stats.alreadyHasName++; continue; }
        if (!uid) { stats.skippedNoUserId++; continue; }
        const resolved = nameById.get(uid) || nameByUserId.get(uid) || '';
        if (!resolved) { stats.skippedNoName++; continue; }
        updates.push({ id: log.id, user_name: resolved });
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

    return Response.json({ success: true, ...stats, appUsersFound: nameById.size + nameByUserId.size, hasMore });
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}