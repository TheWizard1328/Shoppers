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

    // Fetch up to 500 records that are missing company_id
    const records = await base44.asServiceRole.entities.Delivery.filter(
      { company_id: { $exists: false } },
      'created_date',
      BATCH_SIZE
    );

    if (!records || records.length === 0) {
      return Response.json({ done: true, message: 'All deliveries already have company_id' });
    }

    const updates = records.map(r => ({ id: r.id, company_id: companyId }));
    await base44.asServiceRole.entities.Delivery.bulkUpdate(updates);

    // Check how many remain
    const remaining = await base44.asServiceRole.entities.Delivery.filter(
      { company_id: { $exists: false } },
      'created_date',
      1
    );

    return Response.json({
      done: remaining.length === 0,
      updated_this_run: updates.length,
      remaining: remaining.length === 0 ? 0 : 'more remaining — call again'
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});