import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const appUsers = await base44.asServiceRole.entities.AppUser.filter({ user_id: user.id }, '', 1);
    const appUser = appUsers?.[0];
    const roles = appUser?.app_roles || [];

    if (user.role !== 'admin' && !roles.includes('admin')) {
      return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
    }

    // deleteMany — instant server-side bulk purge. The old per-id loop
    // (20/call) could never keep up with the 500k+ row backlog.
    const result = await base44.asServiceRole.entities.RemoteLogEntry.deleteMany({});
    const deleted = result?.deleted || 0;

    return Response.json({ success: true, deleted, has_more: false });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});