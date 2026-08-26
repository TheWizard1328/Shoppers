import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

// ─── purgeOldBreadcrumbs ──────────────────────────────────────────────────────
// Deletes DeliveryBreadcrumbs records whose delivery_date is older than the
// retention window (default 14 days). The per-stop slices have already been
// written back to the Delivery.encoded_polyline once saved_to_route is true, so
// the raw breadcrumb records are redundant past the retention window.
//
// Invoked daily by the "Purge Old Breadcrumbs" scheduled workflow (no user
// session). Also callable manually by an admin — if a user session is present
// it must be an admin; if none is present (workflow invocation) it proceeds
// under the service role.
// ──────────────────────────────────────────────────────────────────────────────

// Edmonton-local YYYY-MM-DD for N days ago. delivery_date is stored as a local
// (America/Edmonton) date string, so the cutoff must be computed in the same
// timezone to avoid off-by-one deletes at the boundary.
function edmontonDateDaysAgo(days) {
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Edmonton',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);

    // ── Auth: admin-only when called by a user; service-role when invoked by workflow ──
    try {
      const user = await base44.auth.me();
      if (user) {
        const appUsers = await base44.asServiceRole.entities.AppUser.filter({ user_id: user.id });
        const isAdmin = Array.isArray(appUsers?.[0]?.app_roles) && appUsers[0].app_roles.includes('admin');
        if (!isAdmin) return Response.json({ error: 'Admin only' }, { status: 403 });
      }
    } catch (_) {
      // No user session (scheduled-workflow invocation) — proceed with service role.
    }

    // Optional body: { retention_days?: number, dry_run?: boolean }
    let retentionDays = 14;
    let dryRun = false;
    try {
      const body = await req.json();
      if (body && Number.isFinite(body.retention_days)) retentionDays = Math.max(1, Math.floor(body.retention_days));
      if (body && body.dry_run === true) dryRun = true;
    } catch (_) { /* no body — workflow or GET probe */ }

    const cutoffDateStr = edmontonDateDaysAgo(retentionDays);

    // Enumerate all breadcrumb records (service role) and collect expired ids.
    // We delete by id rather than a ranged deleteMany filter so the behavior is
    // identical regardless of whether the entity filter supports $lt range
    // operators — the per-stop slices are bounded by the retention window once
    // this runs daily, so the enumerate cost stays small in steady state.
    const expiredIds = [];
    const seen = new Set();
    let page;
    try {
      page = await base44.asServiceRole.entities.DeliveryBreadcrumbs.list();
    } catch (e) {
      return Response.json({ error: 'Failed to list breadcrumbs: ' + (e?.message || e) }, { status: 500 });
    }

    if (Array.isArray(page)) {
      for (const rec of page) {
        if (!rec?.id || seen.has(rec.id)) continue;
        seen.add(rec.id);
        // Keep records without a delivery_date (safety — shouldn't happen, required by schema).
        if (!rec.delivery_date) continue;
        // String comparison of YYYY-MM-DD is lexicographically correct.
        if (rec.delivery_date < cutoffDateStr) expiredIds.push(rec.id);
      }
    }

    if (dryRun) {
      return Response.json({
        status: 'dry_run',
        cutoff_date: cutoffDateStr,
        retention_days: retentionDays,
        would_delete: expiredIds.length,
        scanned: seen.size,
      });
    }

    // Throttled delete: service-role entity deletes are rate-limited, so we run
    // small concurrent batches with a short pause between them instead of one
    // big 50-wide burst (which exhausts the rate window and leaves records behind).
    const BATCH = 5;
    const BATCH_GAP_MS = 250;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let deleted = 0;
    let failed = 0;
    for (let i = 0; i < expiredIds.length; i += BATCH) {
      const chunk = expiredIds.slice(i, i + BATCH);
      const results = await Promise.all(
        chunk.map((id) =>
          base44.asServiceRole.entities.DeliveryBreadcrumbs.delete(id)
            .then(() => 'ok')
            .catch((e) => {
              failed += 1;
              console.warn(`⚠️ [purgeOldBreadcrumbs] failed to delete ${id}:`, e?.message || e);
              return 'err';
            })
        )
      );
      deleted += results.filter((r) => r === 'ok').length;
      if (i + BATCH < expiredIds.length) await sleep(BATCH_GAP_MS);
    }

    console.log(`🧹 [purgeOldBreadcrumbs] cutoff=${cutoffDateStr} retention=${retentionDays}d deleted=${deleted} failed=${failed} scanned=${seen.size}`);
    return Response.json({
      status: 'complete',
      cutoff_date: cutoffDateStr,
      retention_days: retentionDays,
      scanned: seen.size,
      deleted,
      failed,
    });
  } catch (error) {
    console.error('❌ [purgeOldBreadcrumbs] Error:', error?.message || error);
    return Response.json({ error: error?.message || 'Unknown error' }, { status: 500 });
  }
}