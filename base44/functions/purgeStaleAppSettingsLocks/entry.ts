import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';

// One-time purge + reusable admin tool that removes orphaned lock records from
// AppSettings. Three locking mechanisms were removed during the 2026 summer
// refactors but left their lock rows behind in the entity:
//   - optimizeRemainingStops:<driver>:<date>  (old route-optimizer execution locks)
//   - polylock:here_<lat>_<lng>_...            (old HERE polyline generation locks)
//   - square:catalog:lock                      (old Square catalog sync locks)
// None of these keys are written or read by any code path anymore. The live
// config rows (refresh_intervals, route_optimization, route_export_testing_email,
// push_notification_rules) are never touched by this function.

const STALE_PREFIXES = [
  'optimizeRemainingStops:',
  'polylock:',
  'square:catalog:lock',
];

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') {
      return Response.json({ error: 'Forbidden — admin only' }, { status: 403 });
    }

    const allSettings = await base44.asServiceRole.entities.AppSettings.list('-created_date', 1000);

    const staleRecords = (allSettings || []).filter((row) => {
      const key = row?.setting_key || '';
      return STALE_PREFIXES.some((prefix) => key.startsWith(prefix));
    });

    if (staleRecords.length === 0) {
      return Response.json({ purged: 0, scanned: allSettings?.length || 0, message: 'No stale lock records found' });
    }

    let purgedCount = 0;
    const errors: Array<{ id: string; key: string; error: string }> = [];
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    for (const record of staleRecords) {
      try {
        await base44.asServiceRole.entities.AppSettings.delete(record.id);
        purgedCount++;
      } catch (err) {
        errors.push({ id: record.id, key: record.setting_key, error: err?.message || String(err) });
      }
      // Throttle deletes to avoid Base44 API rate limits (429s) on bulk operations
      await sleep(120);
    }

    return Response.json({
      purged: purgedCount,
      scanned: allSettings?.length || 0,
      matched: staleRecords.length,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}