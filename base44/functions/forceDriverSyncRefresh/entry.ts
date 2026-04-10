import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const appUsers = await base44.asServiceRole.entities.AppUser.filter({ user_id: user.id }, '-updated_date', 1);
    const me = appUsers?.[0];
    const myRoles = me?.app_roles || [];
    if (user.role !== 'admin' && !myRoles.includes('admin')) {
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }

    const payload = await req.json().catch(() => ({}));
    const driverUserId = payload?.driverUserId;
    const driverAppUserId = payload?.driverAppUserId;

    if (!driverUserId && !driverAppUserId) {
      return Response.json({ error: 'driverUserId or driverAppUserId is required' }, { status: 400 });
    }

    const target = driverAppUserId
      ? await base44.asServiceRole.entities.AppUser.get(driverAppUserId).catch(() => null)
      : (await base44.asServiceRole.entities.AppUser.filter({ user_id: driverUserId }, '-updated_date', 1).catch(() => []))?.[0];

    if (!target) {
      return Response.json({ error: 'Driver not found' }, { status: 404 });
    }

    const now = new Date().toISOString();
    const metadata = {
      ...(target.csv_import_mapping || {}),
      admin_sync_refresh_requested_at: now,
      admin_sync_refresh_requested_by: user.email || user.id,
    };

    const updated = await base44.asServiceRole.entities.AppUser.update(target.id, {
      csv_import_mapping: metadata,
      updated_date: now
    });

    return Response.json({ success: true, driverId: updated.id, requestedAt: now });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});