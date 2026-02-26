import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

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

    // Approach 4: large list to count all
    const bigList = await base44.asServiceRole.entities.Delivery.list('-delivery_date', 50000);
    results.bigListCount = Array.isArray(bigList) ? bigList.length : 'not_array';
    if (Array.isArray(bigList) && bigList.length > 0) {
      results.bigListFirstDate = bigList[0]?.delivery_date;
      results.bigListLastDate = bigList[bigList.length - 1]?.delivery_date;
      
      // Count by year
      const yearCounts = {};
      bigList.forEach(d => {
        if (d?.delivery_date) {
          const yr = String(d.delivery_date).substring(0, 4);
          yearCounts[yr] = (yearCounts[yr] || 0) + 1;
        }
      });
      results.yearCounts = yearCounts;
    }

    return Response.json(results);
  } catch (error) {
    return Response.json({ error: error.message, stack: error.stack }, { status: 500 });
  }
});