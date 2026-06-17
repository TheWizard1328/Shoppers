import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

/**
 * One-time patch: strips oversized raw arrays from AdminMetricsSummary payroll_metrics fields.
 */

const BIG_ARRAY_KEYS = ['deliveries', 'patients', 'appUsers', 'drivers', 'stores', 'cities', 'payrollRecords'];

const buildSlimPayrollMetrics = (pm: Record<string, unknown>) => {
  const slim: Record<string, unknown> = {};
  const keysToKeep = ['driverStats', 'storeStats', 'totals'];
  for (const key of keysToKeep) {
    if (pm[key] !== undefined) slim[key] = pm[key];
  }
  return slim;
};

const isBloated = (pm: unknown): pm is Record<string, unknown> => {
  if (!pm || typeof pm !== 'object') return false;
  return BIG_ARRAY_KEYS.some((k) => Array.isArray((pm as Record<string, unknown>)[k]));
};

const roughSizeKB = (obj: unknown): number => {
  try { return Math.round(JSON.stringify(obj).length / 1024); } catch { return 0; }
};

Deno.serve(async (req: Request) => {
  try {
    const base44 = createClientFromRequest(req);

    const allRecords = await base44.asServiceRole.entities.AdminMetricsSummary.filter({}, '', 500);

    const results: { id: string; month: number; year: number; action: string; savedKB: number }[] = [];

    for (const record of allRecords || []) {
      if (!record?.id) continue;

      const pm = record.payroll_metrics;

      if (!isBloated(pm)) {
        results.push({ id: record.id, month: record.month, year: record.year, action: 'skip_already_slim', savedKB: 0 });
        continue;
      }

      const beforeKB = roughSizeKB(pm);
      const slim = buildSlimPayrollMetrics(pm as Record<string, unknown>);
      const afterKB = roughSizeKB(slim);

      await base44.asServiceRole.entities.AdminMetricsSummary.update(record.id, {
        payroll_metrics: slim
      });

      results.push({
        id: record.id,
        month: record.month,
        year: record.year,
        action: 'patched',
        savedKB: beforeKB - afterKB
      });
    }

    const patched = results.filter(r => r.action === 'patched');
    const skipped = results.filter(r => r.action === 'skip_already_slim');
    const totalSavedKB = patched.reduce((acc, r) => acc + r.savedKB, 0);

    return Response.json({
      success: true,
      total: results.length,
      patched: patched.length,
      skipped: skipped.length,
      totalSavedKB,
      details: results
    });
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
});
