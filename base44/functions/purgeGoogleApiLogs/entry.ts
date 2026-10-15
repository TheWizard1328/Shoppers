import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

/**
 * purgeGoogleApiLogs — Oct 15 2026.
 *
 * The GoogleAPILog entity (usage badge + admin viewer) had grown so large that
 * every timestamp-filtered query times out: the ApiUsageBadge 15s fetch failed
 * on all 5 retry attempts, and even service-role reads against the collection
 * hit MongoDB's 20s timeout. This function purges records older than the
 * retention window (default 7 days) in bounded, re-invokable batches:
 *
 *   { retain_days: 7, max_seconds: 40 }
 *
 * Pages through the oldest records via the created_date filter (the platform's
 * built-in field), deletes by id in throttled batches, and returns progress.
 * Re-invoke while `remaining` is true — each call continues from where the
 * cutoff query lands until nothing older remains.
 */
Deno.serve(async (req) => {
  const startedAt = Date.now();
  try {
    const base44 = createClientFromRequest(req);

    // Auth: admin-only when called by a user; service-role when invoked by workflow
    try {
      const user = await base44.auth.me();
      if (user) {
        const appUsers = await base44.asServiceRole.entities.AppUser.filter({ user_id: user.id });
        const isAdmin = Array.isArray(appUsers?.[0]?.app_roles) && appUsers[0].app_roles.includes('admin');
        if (!isAdmin) return Response.json({ error: 'Admin only' }, { status: 403 });
      }
    } catch (_) { /* no user session — workflow invocation, proceed */ }

    let body = {};
    try { body = await req.json(); } catch (_) { /* GET probe / empty body */ }
    const retainDays = Number(body?.retain_days) > 0 ? Number(body.retain_days) : 7;
    const maxSeconds = Number(body?.max_seconds) > 0 ? Number(body.max_seconds) : 40;
    const dryRun = body?.dry_run === true;

    const cutoff = new Date(Date.now() - retainDays * 24 * 60 * 60 * 1000).toISOString();

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let deleted = 0;
    let failed = 0;
    let scannedPages = 0;
    let remaining = true;

    while (Date.now() - startedAt < maxSeconds * 1000) {
      // Pull a page of expired records (oldest first via created_date sort where the
      // platform honors it; the filter does the heavy bounding).
      let page;
      try {
        page = await base44.asServiceRole.entities.GoogleAPILog.list({
          filter: { created_date: { $lt: cutoff } },
          limit: 200
        });
      } catch (e) {
        return Response.json({
          error: 'list failed: ' + (e?.message || e),
          deleted_this_run: deleted,
          failed_this_run: failed,
          cutoff
        }, { status: 500 });
      }
      scannedPages += 1;
      if (!Array.isArray(page) || page.length === 0) { remaining = false; break; }

      if (dryRun) {
        return Response.json({
          status: 'dry_run',
          cutoff,
          retain_days: retainDays,
          expired_in_first_page: page.length
        });
      }

      // Throttled deletes: small batches with a short gap (same pattern as
      // purgeOldBreadcrumbs) so the account rate window is never exhausted.
      const BATCH = 5;
      for (let i = 0; i < page.length; i += BATCH) {
        if (Date.now() - startedAt > maxSeconds * 1000) break;
        const chunk = page.slice(i, i + BATCH);
        const results = await Promise.all(
          chunk.map((rec) =>
            base44.asServiceRole.entities.GoogleAPILog.delete(rec.id)
              .then(() => 'ok')
              .catch((e) => { failed += 1; console.warn('delete failed', rec.id, e?.message || e); return 'err'; })
          )
        );
        deleted += results.filter((r) => r === 'ok').length;
        await sleep(150);
      }
    }

    return Response.json({
      success: true,
      cutoff,
      retain_days: retainDays,
      deleted_this_run: deleted,
      failed_this_run: failed,
      pages_scanned: scannedPages,
      remaining,
      elapsed_ms: Date.now() - startedAt
    });
  } catch (e) {
    return Response.json({ error: e?.message || String(e) }, { status: 500 });
  }
});
