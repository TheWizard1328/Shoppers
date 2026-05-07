// Redeployed on 2026-03-28
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

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

    const deviceIdentifier = payload.deviceIdentifier;

    const [devices, cities, stores, appUsers, appSettings] = await Promise.all([
      deviceIdentifier ? base44.asServiceRole.entities.UserDevice.filter({ user_id: user.id, device_identifier: deviceIdentifier }) : Promise.resolve([]),
      base44.asServiceRole.entities.City.list(),
      base44.asServiceRole.entities.Store.list(),
      base44.asServiceRole.entities.AppUser.list(),
      base44.asServiceRole.entities.AppSettings.filter({ setting_key: 'refresh_intervals' }),
    ]);

    const refreshConfig = appSettings?.[0]?.setting_value || {};

    // Resolve HERE API key once during bootstrap to avoid repeated AppSettings queries
    const SECRET_NAME_MAP = {
      HERE_API_KEY: 'HERE_API_KEY',
      Here_API_Key_2: 'Here_API_Key_2',
      Here_API_Key_3: 'Here_API_Key_3'
    };
    const selectedSecretName = refreshConfig.selected_api_key || 'HERE_API_KEY';
    const resolvedSecretName = SECRET_NAME_MAP[selectedSecretName] || 'HERE_API_KEY';
    const hereApiKey = Deno.env.get(resolvedSecretName) || null;

    return Response.json({
      success: true,
      deviceRegistered: (devices || []).length > 0,
      cities: cities || [],
      stores: stores || [],
      appUsers: appUsers || [],
      appSettings: {
        smartRefreshEnabled: refreshConfig.smartRefreshEnabled !== false,
        adminImportEnabled: refreshConfig.adminImportEnabled === true,
        appVersion: refreshConfig.appVersion || null,
        hereApiKey,
      },
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});