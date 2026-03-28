import { createClientFromRequest } from 'npm:@base44/sdk@0.8.21';

const isNotFoundError = (error) => error?.status === 404 || error?.response?.status === 404 || String(error?.message || '').toLowerCase().includes('not found');

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
      ...(appUsers || []).map((record) => base44.asServiceRole.entities.AppUser.delete(record.id).catch((error) => {
        if (isNotFoundError(error)) return null;
        throw error;
      })),
      ...(userDevices || []).map((record) => base44.asServiceRole.entities.UserDevice.delete(record.id).catch((error) => {
        if (isNotFoundError(error)) return null;
        throw error;
      })),
      ...(userSettings || []).map((record) => base44.asServiceRole.entities.UserSettings.delete(record.id).catch((error) => {
        if (isNotFoundError(error)) return null;
        throw error;
      })),
      ...(sentMessages || []).map((record) => base44.asServiceRole.entities.Message.delete(record.id).catch((error) => {
        if (isNotFoundError(error)) return null;
        throw error;
      })),
      ...(receivedMessages || []).map((record) => base44.asServiceRole.entities.Message.delete(record.id).catch((error) => {
        if (isNotFoundError(error)) return null;
        throw error;
      })),
    ]);

    await base44.asServiceRole.entities.User.delete(user.id).catch((error) => {
      if (isNotFoundError(error)) return null;
      throw error;
    });

    return Response.json({ success: true });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});