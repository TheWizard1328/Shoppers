import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

// Read the active HERE API key directly from environment variables.
// The selected key name is resolved via a module-level in-process cache so that
// repeated calls within the same Deno isolate do NOT hit AppSettings again.
// The cache is intentionally short-lived (5 minutes) in case the admin changes
// the selected key in AppSettings — it will auto-refresh on the next miss.

const SECRET_NAME_MAP = {
  HERE_API_KEY: 'HERE_API_KEY',
  Here_API_Key_2: 'Here_API_Key_2',
  Here_API_Key_3: 'Here_API_Key_3'
};

let _cachedSecretName = null;
let _cacheExpiresAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getResolvedSecretName(base44) {
  const now = Date.now();
  if (_cachedSecretName && now < _cacheExpiresAt) {
    return _cachedSecretName;
  }
  // Only fetch AppSettings on cache miss (cold start or after TTL)
  const settings = await base44.asServiceRole.entities.AppSettings.filter({ setting_key: 'refresh_intervals' }, '-updated_date', 1);
  const settingValue = settings?.[0]?.setting_value || {};
  const selected = settingValue.selected_api_key || settingValue.selected_here_api_key || 'HERE_API_KEY';
  _cachedSecretName = SECRET_NAME_MAP[selected] || 'HERE_API_KEY';
  _cacheExpiresAt = now + CACHE_TTL_MS;
  return _cachedSecretName;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const resolvedSecretName = await getResolvedSecretName(base44);
    const apiKey = Deno.env.get(resolvedSecretName);

    if (!apiKey) {
      return Response.json({ error: `Missing HERE API key secret: ${resolvedSecretName}` }, { status: 500 });
    }

    return Response.json({ secretName: resolvedSecretName, apiKey });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});