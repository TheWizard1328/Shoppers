import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  if (user.role !== 'admin') return Response.json({ error: 'Admin only' }, { status: 403 });

  const { store_id } = await req.json().catch(() => ({}));
  if (!store_id) return Response.json({ error: 'store_id required' }, { status: 400 });

  const db = base44.asServiceRole;
  const BATCH = 500;
  const CUTOFF = '2026-01-01';

  const allReturns = [];
  let skip = 0;
  let totalFetched = 0;
  let total2026 = 0;
  let statusBreakdown = {};

  while (true) {
    const batch = await db.entities.Delivery.filter(
      { store_id },
      'created_date', BATCH, skip
    ).catch(e => { return Response.json({ error: e.message }, { status: 500 }); });

    if (!batch.length) break;
    totalFetched += batch.length;

    for (const d of batch) {
      const dDate = d.delivery_date || d.created_date || '';
      if (dDate < CUTOFF) continue;
      total2026++;

      const pn = (d.patient_name || '').toLowerCase();
      if (pn.includes('return')) {
        const st = d.status || 'null';
        statusBreakdown[st] = (statusBreakdown[st] || 0) + 1;
        allReturns.push({
          id: d.id,
          patient_name: d.patient_name,
          status: d.status,
          delivery_date: d.delivery_date,
          delivery_notes: d.delivery_notes ? d.delivery_notes.substring(0, 300) : '(null)',
          has_for: d.delivery_notes ? /For:/i.test(d.delivery_notes) : false,
          has_for_unknown: d.delivery_notes ? /For:\s*Unknown/i.test(d.delivery_notes) : false,
        });
      }
    }

    skip += BATCH;
    if (batch.length < BATCH) break;
  }

  return Response.json({
    store_id,
    total_fetched: totalFetched,
    total_2026: total2026,
    total_returns_found: allReturns.length,
    return_status_breakdown: statusBreakdown,
    returns: allReturns,
  });
});
