import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

/**
 * driverNameNormalize — one canonical display name per driver on Delivery rows.
 *
 * OWNER REPORT (Nov 22 2026): "I am seeing Sharuk and Sharu Harshan" on the
 * Square balance cards. Delivery.driver_name is a denormalised copy written by
 * whichever path assigned the stop, so one driver accumulated several spellings
 * (Sharuk / sharu harshan / Saruharshan S, Robert / Robert T / Robert Tauber,
 * Erin / Erin Burvill-Shaw, Sandy / W Sandy / Sandy W, Shawn / H Shawn, plus
 * empty and "None" strings).
 *
 * The AppUser record is the single source of truth: user_name is what
 * getDriverNameForStorage() writes and what every list renders. This pass
 * rewrites Delivery.driver_name to AppUser.user_name for the row's driver_id,
 * matching AppUser by BOTH id and user_id (deliveries store the auth user id).
 *
 * Body: { dry_run?: boolean, limit?: number }
 * Safe to call repeatedly: only mismatched rows are written.
 */
const BATCH = 500;

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const dryRun = body?.dry_run === true;
    const maxRows = Math.min(Math.max(Number(body?.limit) || 20000, 500), 40000);

    const users = await base44.asServiceRole.entities.AppUser.list('-updated_date', 2000).catch(() => []);
    const canonical = new Map();
    for (const u of users || []) {
      const name = String(u?.user_name || '').trim();
      if (!name) continue;
      if (u?.id) canonical.set(String(u.id), name);
      if (u?.user_id) canonical.set(String(u.user_id), name);
    }
    if (canonical.size === 0) {
      return Response.json({ success: false, error: 'No AppUser user_name values found' }, { status: 500 });
    }

    const mismatches = [];
    const variants = new Map();
    let scanned = 0;
    for (let skip = 0; skip < maxRows; skip += BATCH) {
      const page = await base44.asServiceRole.entities.Delivery
        .list('-delivery_date', BATCH, skip)
        .catch(() => []);
      if (!page || page.length === 0) break;
      for (const d of page) {
        scanned++;
        const did = d?.driver_id ? String(d.driver_id) : '';
        if (!did) continue;
        const want = canonical.get(did);
        if (!want) continue;
        const have = String(d?.driver_name ?? '');
        if (have === want) continue;
        const key = `${have} -> ${want}`;
        variants.set(key, (variants.get(key) || 0) + 1);
        mismatches.push({ id: d.id, driver_name: want });
      }
      if (page.length < BATCH) break;
    }

    const variantList = Array.from(variants.entries())
      .map(([k, n]) => ({ change: k, rows: n }))
      .sort((a, b) => b.rows - a.rows);

    if (dryRun) {
      return Response.json({
        success: true,
        dry_run: true,
        scanned,
        mismatched: mismatches.length,
        variants: variantList
      });
    }

    let updated = 0;
    for (let i = 0; i < mismatches.length; i += BATCH) {
      const chunk = mismatches.slice(i, i + BATCH);
      await base44.asServiceRole.entities.Delivery.bulkUpdate(chunk).catch((e) => {
        console.warn('[driverNameNormalize] bulkUpdate chunk failed:', e?.message || e);
      });
      updated += chunk.length;
    }

    return Response.json({
      success: true,
      dry_run: false,
      scanned,
      updated,
      variants: variantList
    });
  } catch (e) {
    console.error('[driverNameNormalize] failed:', e?.message || e);
    return Response.json({ success: false, error: e?.message || String(e) }, { status: 500 });
  }
});
