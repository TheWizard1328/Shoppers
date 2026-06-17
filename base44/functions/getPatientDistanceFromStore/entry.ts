import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

// HERE API key cache (5 min TTL)
const _HERE_SECRET_MAP = { HERE_API_KEY: 'HERE_API_KEY', Here_API_Key_2: 'Here_API_Key_2', Here_API_Key_3: 'Here_API_Key_3' };
let _hereSecretName = null;
let _hereSecretExpiresAt = 0;

async function getHereApiKey(base44) {
  const now = Date.now();
  if (_hereSecretName && now < _hereSecretExpiresAt) {
    return Deno.env.get(_hereSecretName) || null;
  }
  const settings = await base44.asServiceRole.entities.AppSettings.filter({ setting_key: 'refresh_intervals' }, '-updated_date', 1);
  const val = settings?.[0]?.setting_value || {};
  const selected = val.selected_api_key || val.selected_here_api_key || 'HERE_API_KEY';
  _hereSecretName = _HERE_SECRET_MAP[selected] || 'HERE_API_KEY';
  _hereSecretExpiresAt = now + 5 * 60 * 1000;
  return Deno.env.get(_hereSecretName) || null;
}

const haversineKm = (lat1, lng1, lat2, lng2) => {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { originLat, originLng, destLat, destLng } = await req.json();

    if (![originLat, originLng, destLat, destLng].every((v) => Number.isFinite(Number(v)))) {
      return Response.json({ error: 'originLat, originLng, destLat, destLng are required' }, { status: 400 });
    }

    const oLat = Number(originLat);
    const oLng = Number(originLng);
    const dLat = Number(destLat);
    const dLng = Number(destLng);

    const fallbackKm = parseFloat(haversineKm(oLat, oLng, dLat, dLng).toFixed(2));

    const hereApiKey = await getHereApiKey(base44);
    if (!hereApiKey) {
      console.warn('[getPatientDistanceFromStore] HERE API key not found — using haversine fallback');
      return Response.json({ distance_km: fallbackKm, source: 'haversine' });
    }

    const params = new URLSearchParams({
      apiKey: hereApiKey,
      transportMode: 'car',
      origin: `${oLat},${oLng}`,
      destination: `${dLat},${dLng}`,
      return: 'summary'
    });

    const resp = await fetch(`https://router.hereapi.com/v8/routes?${params.toString()}`, {
      signal: AbortSignal.timeout(8000),
      headers: { accept: 'application/json' }
    });

    if (!resp.ok) {
      console.warn(`[getPatientDistanceFromStore] HERE Router returned ${resp.status} — using haversine fallback`);
      return Response.json({ distance_km: fallbackKm, source: 'haversine' });
    }

    const data = await resp.json();
    const section = data?.routes?.[0]?.sections?.[0];
    const lengthMeters = section?.summary?.length;

    if (!Number.isFinite(Number(lengthMeters))) {
      console.warn('[getPatientDistanceFromStore] HERE returned no length — using haversine fallback');
      return Response.json({ distance_km: fallbackKm, source: 'haversine' });
    }

    const roadDistanceKm = parseFloat((Number(lengthMeters) / 1000).toFixed(2));
    return Response.json({ distance_km: roadDistanceKm, source: 'here_routing' });

  } catch (error) {
    console.error('[getPatientDistanceFromStore] Error:', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
});