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

    let deleted = 0;
    const rows = await base44.asServiceRole.entities.RemoteLogEntry.list('-created_date', 20);

    for (const row of rows || []) {
      await base44.asServiceRole.entities.RemoteLogEntry.delete(row.id);
      deleted += 1;
    }

    return Response.json({ success: true, deleted, has_more: (rows || []).length === 20 });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});