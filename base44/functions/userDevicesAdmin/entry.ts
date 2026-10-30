// userDevicesAdmin — admin-only device management for OTHER users' devices.
//
// WHY THIS EXISTS (owner report Oct 29 2026): "I am not getting any device data
// for all other users." The UserDevice entity carries row-level security keyed
// on created_by === {{user.email}}, so a client-side read as an admin returns
// only the rows that admin personally created — every other user's devices are
// invisible. Rather than opening the entity up to every authenticated user
// (which would let a driver read/edit/delete another driver's devices), the
// admin path runs here under the service role after an explicit admin check.
//
// Actions: list | update | delete | create
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

// Fields an admin may write through this function. Anything else is dropped so
// this can never become a general-purpose entity writer.
const WRITABLE_FIELDS = [
  'device_name',
  'status',
  'is_primary_tracker',
  'device_info',
  'last_active_at',
  'user_id',
  'user_name',
  'device_identifier',
];

const pickWritable = (input) => {
  const out: Record<string, unknown> = {};
  for (const key of WRITABLE_FIELDS) {
    if (input && Object.prototype.hasOwnProperty.call(input, key)) out[key] = input[key];
  }
  return out;
};

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user) return Response.json({ error: 'Not authenticated' }, { status: 401 });

    const appUsers = await base44.asServiceRole.entities.AppUser.filter({ user_id: user.id }).catch(() => []);
    const me = appUsers?.[0];
    const isAdmin = Array.isArray(me?.app_roles) && me.app_roles.includes('admin');
    if (!isAdmin) return Response.json({ error: 'Admin only' }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const action = String(body?.action || '').trim();

    if (action === 'list') {
      const userId = String(body?.userId || '').trim();
      if (!userId) return Response.json({ error: 'Missing userId' }, { status: 400 });
      const devices = await base44.asServiceRole.entities.UserDevice.filter({ user_id: userId });
      const sorted = (devices || []).sort(
        (a, b) => new Date(b?.last_active_at || 0).getTime() - new Date(a?.last_active_at || 0).getTime()
      );
      return Response.json({ devices: sorted });
    }

    if (action === 'update') {
      const id = String(body?.id || '').trim();
      if (!id) return Response.json({ error: 'Missing id' }, { status: 400 });
      const updates = pickWritable(body?.updates);
      if (!Object.keys(updates).length) return Response.json({ error: 'Nothing to update' }, { status: 400 });
      const updated = await base44.asServiceRole.entities.UserDevice.update(id, updates);
      return Response.json({ device: updated });
    }

    if (action === 'delete') {
      const id = String(body?.id || '').trim();
      if (!id) return Response.json({ error: 'Missing id' }, { status: 400 });
      await base44.asServiceRole.entities.UserDevice.delete(id);
      return Response.json({ deleted: id });
    }

    if (action === 'create') {
      const record = pickWritable(body?.record);
      if (!record.user_id || !record.device_name || !record.device_identifier) {
        return Response.json({ error: 'Missing user_id / device_name / device_identifier' }, { status: 400 });
      }
      if (record.status === undefined) record.status = 'active';
      const created = await base44.asServiceRole.entities.UserDevice.create(record);
      return Response.json({ device: created });
    }

    return Response.json({ error: `Unknown action: ${action}` }, { status: 400 });
  } catch (error) {
    return Response.json({ error: String((error as Error)?.message || error) }, { status: 500 });
  }
});
