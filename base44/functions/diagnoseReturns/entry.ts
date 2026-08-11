import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  if (user.role !== 'admin') return Response.json({ error: 'Admin only' }, { status: 403 });

  const db = base44.asServiceRole;
  const BATCH = 500;
  const CUTOFF = '2026-01-01';

  // ALL 12 active store IDs
  const storeIds = [
    '695b6333e8a9b6f5b0c467d7', '69354c3f7d5201849e84af97',
    '685cd33055969a07cb634fe9', '685cd33055969a07cb634fe8',
    '685cd33055969a07cb634fe7', '685cd33055969a07cb634fe6',
    '685cd33055969a07cb634fe5', '685cd33055969a07cb634fe4',
    '685cd33055969a07cb634fe3', '685cd33055969a07cb634fe2',
    '685cd33055969a07cb634fe1', '685cd33055969a07cb634fe0',
  ];

  const storeNames = {
    '695b6333e8a9b6f5b0c467d7': 'Lakeland Ridge',
    '69354c3f7d5201849e84af97': 'Sherwood Park Mall',
    '685cd33055969a07cb634fe9': 'Beverly',
    '685cd33055969a07cb634fe8': 'WestPark',
    '685cd33055969a07cb634fe7': 'SouthPoint',
    '685cd33055969a07cb634fe6': 'Callingwood',
    '685cd33055969a07cb634fe5': 'Hamptons',
    '685cd33055969a07cb634fe4': 'Londonderry',
    '685cd33055969a07cb634fe3': 'Meadows',
    '685cd33055969a07cb634fe2': 'Bonnie Doon',
    '685cd33055969a07cb634fe1': 'Scona',
    '685cd33055969a07cb634fe0': 'Kingsway',
  };

  const allReturns = [];
  const storeSummary = {};

  for (const sid of storeIds) {
    storeSummary[storeNames[sid]] = { total: 0, unknown: 0, missing: 0, clean: 0, returns: [] };
    let skip = 0;

    while (true) {
      const batch = await db.entities.Delivery.filter(
        { store_id: sid },
        'created_date', BATCH, skip
      ).catch(e => { console.error(`Fetch error ${sid}: ${e.message}`); return []; });

      if (!batch.length) break;

      for (const d of batch) {
        const dDate = d.delivery_date || d.created_date || '';
        if (dDate < CUTOFF) continue;

        const pn = (d.patient_name || '').toLowerCase();
        if (!pn.includes('return')) continue;

        const entry = {
          id: d.id,
          patient_name: d.patient_name,
          status: d.status,
          delivery_date: d.delivery_date || d.created_date,
          delivery_notes: d.delivery_notes ? d.delivery_notes.substring(0, 300) : '(null)',
          has_for: d.delivery_notes ? /For:/i.test(d.delivery_notes) : false,
          has_for_unknown: d.delivery_notes ? /For:\s*Unknown/i.test(d.delivery_notes) : false,
        };

        storeSummary[storeNames[sid]].total++;
        storeSummary[storeNames[sid]].returns.push(entry);
        allReturns.push({ store: storeNames[sid], ...entry });

        if (entry.has_for_unknown) storeSummary[storeNames[sid]].unknown++;
        else if (!entry.has_for) storeSummary[storeNames[sid]].missing++;
        else storeSummary[storeNames[sid]].clean++;
      }

      skip += BATCH;
      if (batch.length < BATCH) break;
    }
  }

  return Response.json({
    total_returns_across_all_stores: allReturns.length,
    store_summary: storeSummary,
    all_returns: allReturns,
  });
});
