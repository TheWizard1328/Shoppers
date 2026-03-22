import { createClientFromRequest } from 'npm:@base44/sdk@0.8.21';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let payload = {};
    try {
      payload = await req.json();
    } catch (_error) {
      payload = {};
    }

    if (payload.confirmDeletion !== true) {
      return Response.json({ error: 'Confirmation required' }, { status: 400 });
    }

    const [appUsers, userDevices, userSettings, sentMessages, receivedMessages] = await Promise.all([
      base44.asServiceRole.entities.AppUser.filter({ user_id: user.id }),
      base44.asServiceRole.entities.UserDevice.filter({ user_id: user.id }),
      base44.asServiceRole.entities.UserSettings.filter({ user_id: user.id }),
      base44.asServiceRole.entities.Message.filter({ sender_id: user.id }),
      base44.asServiceRole.entities.Message.filter({ receiver_id: user.id }),
    ]);

    await Promise.all([
      ...(appUsers || []).map((record) => base44.asServiceRole.entities.AppUser.delete(record.id)),
      ...(userDevices || []).map((record) => base44.asServiceRole.entities.UserDevice.delete(record.id)),
      ...(userSettings || []).map((record) => base44.asServiceRole.entities.UserSettings.delete(record.id)),
      ...(sentMessages || []).map((record) => base44.asServiceRole.entities.Message.delete(record.id)),
      ...(receivedMessages || []).map((record) => base44.asServiceRole.entities.Message.delete(record.id)),
    ]);

    await base44.asServiceRole.entities.User.delete(user.id);

    return Response.json({ success: true });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});