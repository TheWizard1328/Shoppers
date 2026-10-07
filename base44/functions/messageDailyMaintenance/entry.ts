import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

/**
 * Daily message maintenance (owner spec, Oct 7 2026) - invoked 8 AM Edmonton
 * by the "Daily Message Cleanup" app workflow.
 *
 * 1) CLEAN SLATE: mark ALL unread messages as read so every day starts with a
 *    zero-unread inbox (owner: "all unread messages marked as read so each
 *    day starts off clean").
 *      - 1:1 messages: read=false -> read=true
 *      - group messages: append every group_member_ids member to read_by
 *        (a member is "unread" when their id is missing from read_by)
 *
 * 2) PRUNE: delete messages older than PRUNE_DAYS (default 30) so the
 *    Message table stays bounded and the messaging UI loads fast.
 *
 * Workflow-safe: scheduled invocations have no user session - proceed under
 * the service role (same pattern as clearRemoteLogs).
 *
 * Optional payload:
 *   { dry_run: true }              - report what would happen, change nothing
 *   { prune_days: 14 }              - override retention (default 30)
 *   { mark_read: false }           - skip step 1
 *   { prune: false }               - skip step 2
 */

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);

    let payload: any = {};
    try { payload = await req.json(); } catch (_) {}

    const dryRun = payload?.dry_run === true;
    const pruneDays = Number(payload?.prune_days) > 0 ? Number(payload.prune_days) : 30;
    const doMarkRead = payload?.mark_read !== false;
    const doPrune = payload?.prune !== false;

    const now = Date.now();
    const pruneCutoff = new Date(now - pruneDays * 86400000).toISOString();

    // ---- STEP 1: mark all unread as read ----
    let oneToOneMarked = 0;
    let groupMessagesMarked = 0;
    let errors = 0;

    if (doMarkRead) {
      // 1:1 unread - paginated scan (read flag is 1:1 only; group rows are
      // handled separately via read_by).
      let skip = 0;
      while (true) {
        const rows = await base44.asServiceRole.entities.Message.filter(
          { read: false },
          'created_date',
          200,
          skip
        );
        const page = rows || [];
        if (page.length === 0) break;

        const targets = page.filter((m) => !m.is_group);
        if (!dryRun && targets.length) {
          const results = await Promise.all(
            targets.map((m) =>
              base44.asServiceRole.entities.Message.update(m.id, { read: true })
                .then(() => 'ok')
                .catch((e) => {
                  errors += 1;
                  console.warn(`[messageDailyMaintenance] 1:1 read update failed ${m.id}:`, e?.message || e);
                  return 'err';
                })
            )
          );
          oneToOneMarked += results.filter((r) => r === 'ok').length;
        } else if (dryRun) {
          oneToOneMarked += targets.length;
        }
        skip += page.length;
        if (page.length < 200) break;
      }

      // Group messages - append any group member missing from read_by.
      // Messages older than the prune cutoff are about to be deleted anyway,
      // so receipt work only needs the surviving window.
      skip = 0;
      while (true) {
        const rows = await base44.asServiceRole.entities.Message.filter(
          { is_group: true, created_date: { $gte: pruneCutoff } },
          'created_date',
          200,
          skip
        );
        const page = rows || [];
        if (page.length === 0) break;

        for (const m of page) {
          const members = Array.isArray(m.group_member_ids) ? m.group_member_ids : [];
          if (members.length === 0) continue;
          const readBy = Array.isArray(m.read_by) ? m.read_by : [];
          const missing = members.filter((id) => !readBy.includes(id));
          if (missing.length === 0) continue;
          if (dryRun) { groupMessagesMarked += 1; continue; }
          try {
            await base44.asServiceRole.entities.Message.update(m.id, {
              read_by: [...readBy, ...missing],
            });
            groupMessagesMarked += 1;
          } catch (e) {
            errors += 1;
            console.warn(`[messageDailyMaintenance] group read_by update failed ${m.id}:`, e?.message || e);
          }
        }
        skip += page.length;
        if (page.length < 200) break;
      }
    }

    // ---- STEP 2: prune old messages ----
    let pruned = 0;
    let pruneMode = 'skipped';

    if (doPrune) {
      if (dryRun) {
        let skip = 0; let total = 0;
        while (true) {
          const pageRows = await base44.asServiceRole.entities.Message.filter(
            { created_date: { $lt: pruneCutoff } },
            'created_date',
            500,
            skip,
            ['id']
          );
          const page = pageRows || [];
          total += page.length;
          skip += page.length;
          if (page.length < 500) break;
        }
        pruned = total;
        pruneMode = 'dry_run';
      } else {
        // Fast path: operator-based bulk delete on the indexed created_date
        // (same pattern as clearRemoteLogs trim mode).
        try {
          const result = await base44.asServiceRole.entities.Message.deleteMany({
            created_date: { $lt: pruneCutoff },
          });
          pruned = result?.deleted || 0;
          pruneMode = 'deleteMany-cutoff';
        } catch (e) {
          // Fallback: collect old ids and batch-delete via id-match query.
          console.warn('[messageDailyMaintenance] deleteMany cutoff failed, falling back to ids:', e?.message || e);
          const BATCH = 500;
          let skip = 0;
          while (true) {
            const pageRows = await base44.asServiceRole.entities.Message.filter(
              { created_date: { $lt: pruneCutoff } },
              'created_date',
              BATCH,
              skip,
              ['id']
            );
            const ids = (pageRows || []).map((r) => r?.id).filter(Boolean);
            if (ids.length === 0) { pruneMode = 'ids'; break; }
            try {
              const result = await base44.asServiceRole.entities.Message.deleteMany({ id: ids });
              pruned += result?.deleted || ids.length;
            } catch (_) {
              for (const id of ids) {
                try {
                  await base44.asServiceRole.entities.Message.delete(id);
                  pruned += 1;
                } catch (_) { errors += 1; }
              }
            }
            skip += ids.length;
            if (ids.length < BATCH) { pruneMode = 'ids'; break; }
          }
        }
      }
    }

    console.log(
      `[messageDailyMaintenance] dryRun=${dryRun} oneToOneMarked=${oneToOneMarked} groupMessagesMarked=${groupMessagesMarked} pruned=${pruned} mode=${pruneMode} errors=${errors}`
    );

    return Response.json({
      success: true,
      dry_run: dryRun,
      one_to_one_marked: oneToOneMarked,
      group_messages_marked: groupMessagesMarked,
      pruned,
      prune_mode: pruneMode,
      prune_days: pruneDays,
      prune_cutoff: pruneCutoff,
      errors
    });
  } catch (error) {
    console.error('[messageDailyMaintenance] fatal:', error?.message || error);
    return Response.json({ error: error?.message || String(error) }, { status: 500 });
  }
});
