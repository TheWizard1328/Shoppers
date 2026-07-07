import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { updates } = await req.json();
    if (!Array.isArray(updates) || updates.length === 0) {
      return Response.json({ error: 'updates must be a non-empty array' }, { status: 400 });
    }

    // Validate each update has id + data
    const valid = updates.every(u => u && typeof u.id === 'string' && u.data && typeof u.data === 'object');
    if (!valid) {
      return Response.json({ error: 'Each update must have { id: string, data: object }' }, { status: 400 });
    }

    // Use bulkUpdate — single round-trip to the DB, up to 500 records
    const result = await base44.asServiceRole.entities.Delivery.bulkUpdate(
      updates.map(u => ({ id: u.id, ...u.data }))
    );

    return Response.json({ success: true, updatedCount: updates.length, result });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});