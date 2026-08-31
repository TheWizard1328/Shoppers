// Redeployed 2026-06-02 — Slim bootstrap: device check + HERE API key only.
// City, Store, AppUser, AppSettings are loaded from IndexedDB on the client
// and synced in the background via bootstrapBackgroundSync.
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let payload = {};
    try { payload = await req.json(); } catch (_) {}

    const deviceIdentifier = payload.deviceIdentifier;

    // Only fetch what cannot come from IndexedDB:
    //   1. Device registration check (needs server truth — small, targeted query)
    //   2. AppSettings refresh_intervals (for HERE API key selection)
    const [devices, appSettings] = await Promise.all([
      deviceIdentifier
        ? base44.asServiceRole.entities.UserDevice.filter({ user_id: user.id, device_identifier: deviceIdentifier })
        : Promise.resolve([]),
      base44.asServiceRole.entities.AppSettings.filter({ setting_key: 'refresh_intervals' }),
    ]);

    const refreshConfig = appSettings?.[0]?.setting_value || {};

    // Resolve the 'map_tiles' feature key (HERE) for tile URL construction.
    const { resolveFeatureSecretName } = await import('../../shared/apiKeyResolver.ts');
    const tilesSecretName = await resolveFeatureSecretName(base44, 'map_tiles', refreshConfig);
    const hereApiKey = Deno.env.get(tilesSecretName) || null;

    // Resolve the polylines feature — provider + key.
    // For HERE polylines the client reuses the map-tiles key (hereApiKey above),
    // so we only ship a separate key when the provider is Google.
    const polylineSecretName = await resolveFeatureSecretName(base44, 'polylines', refreshConfig);
    const polylineProvider = polylineSecretName === 'GOOGLE_MAPS_API_KEY' ? 'google' : 'here';
    const polylineApiKey = polylineProvider === 'google' ? (Deno.env.get(polylineSecretName) || null) : null;

    return Response.json({
      success: true,
      deviceRegistered: (devices || []).length > 0,
      appSettings: {
        smartRefreshEnabled: refreshConfig.smartRefreshEnabled !== false,
        adminImportEnabled: refreshConfig.adminImportEnabled === true,
        appVersion: refreshConfig.appVersion || null,
        hereApiKey,
        polylineProvider,
        polylineApiKey,
      },
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});