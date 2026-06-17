import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (user?.role !== 'admin') {
      return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
    }

    const [healthRows, logRows] = await Promise.all([
      base44.asServiceRole.entities.SquareSyncHealth.list('-updated_date', 20),
      base44.asServiceRole.entities.SquareSyncLog.list('-updated_date', 100),
    ]);

    return Response.json({ runs: healthRows || [], logs: logRows || [] });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});