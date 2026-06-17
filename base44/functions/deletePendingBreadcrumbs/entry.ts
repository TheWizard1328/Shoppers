import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { pendingBreadcrumbIds } = body || {};

    if (!Array.isArray(pendingBreadcrumbIds)) {
      return Response.json({ error: 'pendingBreadcrumbIds must be an array' }, { status: 400 });
    }

    let deletedCount = 0;
    for (const id of pendingBreadcrumbIds) {
      if (!id) continue;
      await base44.asServiceRole.entities.PendingBreadcrumbLive.delete(id);
      deletedCount += 1;
    }

    return Response.json({ success: true, deletedCount });
  } catch (error) {
    console.error('[deletePendingBreadcrumbs] Error:', error?.message || error);
    return Response.json({ error: error?.message || 'Internal error' }, { status: 500 });
  }
});