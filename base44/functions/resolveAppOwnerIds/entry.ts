import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const caller = await base44.auth.me().catch(() => null);
    if (!caller) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const result = await base44.asServiceRole.entities.User.list({ limit: 500 });
    const users = Array.isArray(result) ? result : (Array.isArray(result?.data) ? result.data : []);
    const owners = users
      .filter((user) => user?.role === 'admin' && user?.id)
      .map((user) => ({ id: user.id, full_name: user.full_name || null }));

    return Response.json({ owner_ids: owners.map((owner) => owner.id), owners });
  } catch (error) {
    return Response.json({ error: error?.message || 'Failed to resolve app owner' }, { status: 500 });
  }
});
