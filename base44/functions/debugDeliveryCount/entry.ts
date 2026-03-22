import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';
// force redeploy v2

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    // Try listing deliveries with various approaches
    const results = {};

    // Approach 1: list with limit
    const listResult = await base44.asServiceRole.entities.Delivery.list('-delivery_date', 10);
    results.listCount = Array.isArray(listResult) ? listResult.length : 'not_array';
    results.listType = typeof listResult;
    if (Array.isArray(listResult) && listResult.length > 0) {
      results.firstDeliveryDate = listResult[0]?.delivery_date;
      results.lastDeliveryDate = listResult[listResult.length - 1]?.delivery_date;
      results.sampleKeys = Object.keys(listResult[0] || {}).slice(0, 10);
    }

    // Approach 2: filter for specific date
    const filterResult = await base44.asServiceRole.entities.Delivery.filter(
      { delivery_date: '2026-02-25' },
      '-delivery_date',
      5
    );
    results.filterCount = Array.isArray(filterResult) ? filterResult.length : 'not_array';
    results.filterType = typeof filterResult;
    if (Array.isArray(filterResult) && filterResult.length > 0) {
      results.filterFirstDate = filterResult[0]?.delivery_date;
    }

    // Approach 3: filter with year prefix
    const filter2026 = await base44.asServiceRole.entities.Delivery.filter(
      { delivery_date: { $gte: '2026-01-01', $lte: '2026-12-31' } },
      '-delivery_date',
      5
    );
    results.filter2026Count = Array.isArray(filter2026) ? filter2026.length : 'not_array';

    // Approach 4: test different limit sizes
    const limits = [100, 500, 1000, 2000, 5000, 10000];
    results.limitTests = {};
    for (const lim of limits) {
      const r = await base44.asServiceRole.entities.Delivery.list('-delivery_date', lim);
      results.limitTests[lim] = {
        isArray: Array.isArray(r),
        type: typeof r,
        length: Array.isArray(r) ? r.length : (typeof r === 'string' ? r.length : 'N/A')
      };
      if (!Array.isArray(r)) break; // stop once it breaks
    }

    // Approach 5: filter 2026 with smaller limits
    const filterLimits = [100, 500, 1000, 2000, 3000, 4000];
    results.filterLimitTests = {};
    for (const lim of filterLimits) {
      const r = await base44.asServiceRole.entities.Delivery.filter(
        { delivery_date: { $gte: '2026-01-01', $lte: '2026-12-31' } },
        '-delivery_date',
        lim
      );
      results.filterLimitTests[lim] = {
        isArray: Array.isArray(r),
        length: Array.isArray(r) ? r.length : (typeof r === 'string' ? `string(${r.length})` : typeof r)
      };
      if (Array.isArray(r) && r.length < lim) {
        // Got all data, record total
        results.totalDeliveries2026 = r.length;
        break;
      }
    }

    return Response.json(results);
  } catch (error) {
    return Response.json({ error: error.message, stack: error.stack }, { status: 500 });
  }
});