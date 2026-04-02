// Redeployed on 2026-03-28
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

    const deviceIdentifier = payload.deviceIdentifier;

    const todayStr = payload.todayStr || new Date().toISOString().slice(0, 10);

    const [devices, cities, stores, appUsers, appSettings, deliveries, patients] = await Promise.all([
      deviceIdentifier ? base44.asServiceRole.entities.UserDevice.filter({ user_id: user.id, device_identifier: deviceIdentifier }) : Promise.resolve([]),
      base44.asServiceRole.entities.City.list(),
      base44.asServiceRole.entities.Store.list(),
      base44.asServiceRole.entities.AppUser.list(),
      base44.asServiceRole.entities.AppSettings.filter({ setting_key: 'refresh_intervals' }),
      base44.asServiceRole.entities.Delivery.filter({ delivery_date: todayStr }),
      base44.asServiceRole.entities.Patient.list(),
    ]);

    const refreshConfig = appSettings?.[0]?.setting_value || {};

    return Response.json({
      success: true,
      deviceRegistered: (devices || []).length > 0,
      cities: cities || [],
      stores: stores || [],
      appUsers: appUsers || [],
      deliveries: deliveries || [],
      patients: patients || [],
      appSettings: {
        smartRefreshEnabled: refreshConfig.smartRefreshEnabled !== false,
        adminImportEnabled: refreshConfig.adminImportEnabled === true,
        appVersion: refreshConfig.appVersion || null,
      },
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});