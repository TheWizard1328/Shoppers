import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    // Workflow-safe auth: a user session must be an admin; no session means a
    // scheduled-workflow invocation ($BASE44_SERVICE_TOKEN resolves
    // unauthenticated) — proceed under the service role.
    if (user) {
      const appUsers = await base44.asServiceRole.entities.AppUser.filter({ user_id: user.id }).catch(() => []);
      const isAdmin = Array.isArray(appUsers?.[0]?.app_roles) && appUsers[0].app_roles.includes('admin');
      if (!isAdmin) return Response.json({ error: 'Admin only' }, { status: 403 });
    }

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