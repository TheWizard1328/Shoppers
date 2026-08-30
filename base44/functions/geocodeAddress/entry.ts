import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import { resolveFeatureApiKey, resolveFeatureSecretName } from '../../shared/apiKeyResolver.ts';

const logApiUsage = async ({ base44, appUserId, appUserName, provider, apiType, purpose, functionName, metadata = {}, success, durationMs, errorMessage }) => {
  if (!base44) return;
  try {
    await base44.asServiceRole.entities.GoogleAPILog.create({
      timestamp: new Date().toISOString(),
      api_type: apiType,
      purpose,
      function_name: functionName,
      user_id: appUserId || null,
      user_name: appUserName || null,
      metadata: { api_provider: provider, success: success === true, duration_ms: durationMs, error_message: errorMessage || undefined, ...metadata },
    });
  } catch (e) { /* best-effort */ }
};

Deno.serve(async (req) => {
  const startedAt = Date.now();
  let base44: any = null;
  let appUser: any = null;
  try {
    base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { address } = await req.json();
    if (!address || !address.trim()) {
      return Response.json({ error: 'address is required' }, { status: 400 });
    }

    try {
      const appUsers = await base44.asServiceRole.entities.AppUser.filter({ user_id: user.id }, '-updated_date', 1);
      appUser = appUsers?.[0] || null;
    } catch (_) {}

    const secretName = await resolveFeatureSecretName(base44, 'address_lookup');
    const isGoogle = secretName === 'GOOGLE_MAPS_API_KEY';
    const apiKey = Deno.env.get(secretName);
    if (!apiKey) return Response.json({ error: `API key not configured: ${secretName}` }, { status: 500 });

    // ── HERE Geocoder path ──────────────────────────────────────────────
    if (!isGoogle) {
      const url = `https://geocode.search.hereapi.com/v1/geocode?q=${encodeURIComponent(address)}&apiKey=${apiKey}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { accept: 'application/json' } });
      const data = await res.json().catch(() => null);
      const item = Array.isArray(data?.items) ? data.items[0] : null;
      if (!res.ok || !item?.position) {
        await logApiUsage({ base44, appUserId: appUser?.id, appUserName: appUser?.user_name || user.full_name, provider: 'here', apiType: 'Geocoding', purpose: 'Address geocoding', functionName: 'geocodeAddress', success: false, durationMs: Date.now() - startedAt, errorMessage: data?.title || `HTTP ${res.status}`, metadata: { address, status_code: res.status } });
        return Response.json({ error: `HERE Geocoding failed: ${data?.title || res.status}` }, { status: 400 });
      }
      await logApiUsage({ base44, appUserId: appUser?.id, appUserName: appUser?.user_name || user.full_name, provider: 'here', apiType: 'Geocoding', purpose: 'Address geocoding', functionName: 'geocodeAddress', success: true, durationMs: Date.now() - startedAt, metadata: { address } });
      return Response.json({ latitude: item.position.lat, longitude: item.position.lng });
    }

    // ── Google Geocoding path (unchanged) ───────────────────────────────
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${apiKey}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.status !== 'OK' || !data.results?.length) {
      await logApiUsage({ base44, appUserId: appUser?.id, appUserName: appUser?.user_name || user.full_name, provider: 'google', apiType: 'Geocoding', purpose: 'Address geocoding', functionName: 'geocodeAddress', success: false, durationMs: Date.now() - startedAt, errorMessage: `Geocoding failed: ${data.status}`, metadata: { address } });
      return Response.json({ error: `Geocoding failed: ${data.status}` }, { status: 400 });
    }
    const location = data.results[0].geometry.location;
    await logApiUsage({ base44, appUserId: appUser?.id, appUserName: appUser?.user_name || user.full_name, provider: 'google', apiType: 'Geocoding', purpose: 'Address geocoding', functionName: 'geocodeAddress', success: true, durationMs: Date.now() - startedAt, metadata: { address } });
    return Response.json({ latitude: location.lat, longitude: location.lng });
  } catch (error) {
    await logApiUsage({ base44, appUserId: appUser?.id, appUserName: appUser?.user_name || null, provider: 'unknown', apiType: 'Geocoding', purpose: 'Address geocoding', functionName: 'geocodeAddress', success: false, durationMs: Date.now() - startedAt, errorMessage: error.message });
    return Response.json({ error: error.message }, { status: 500 });
  }
});