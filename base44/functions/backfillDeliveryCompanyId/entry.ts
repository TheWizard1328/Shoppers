import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user || user.role !== 'admin') {
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }

    const companyId = '69c753c2d8261cec3a2a2b81';
    const BATCH_SIZE = 500;

    // Fetch records missing company_id — covers null, empty string, and missing field
    const [missingExists, missingNull, missingEmpty] = await Promise.all([
      base44.asServiceRole.entities.Delivery.filter(
        { company_id: { $exists: false } }, 'created_date', BATCH_SIZE
      ),
      base44.asServiceRole.entities.Delivery.filter(
        { company_id: null }, 'created_date', BATCH_SIZE
      ),
      base44.asServiceRole.entities.Delivery.filter(
        { company_id: '' }, 'created_date', BATCH_SIZE
      ),
    ]);

    // Deduplicate by id
    const seen = new Set();
    const records = [...missingExists, ...missingNull, ...missingEmpty].filter(r => {
      if (!r?.id || seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    }).slice(0, BATCH_SIZE);

    if (records.length === 0) {
      return Response.json({ done: true, updated_this_run: 0, remaining: 0, message: 'All deliveries already have company_id' });
    }

    const updates = records.map(r => ({ id: r.id, company_id: companyId }));
    await base44.asServiceRole.entities.Delivery.bulkUpdate(updates);

    // Check remaining
    const [r1, r2, r3] = await Promise.all([
      base44.asServiceRole.entities.Delivery.filter({ company_id: { $exists: false } }, 'created_date', 1),
      base44.asServiceRole.entities.Delivery.filter({ company_id: null }, 'created_date', 1),
      base44.asServiceRole.entities.Delivery.filter({ company_id: '' }, 'created_date', 1),
    ]);

    const anyRemaining = r1.length > 0 || r2.length > 0 || r3.length > 0;

    return Response.json({
      done: !anyRemaining,
      updated_this_run: updates.length,
      remaining: anyRemaining ? 'more remaining — call again' : 0
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});