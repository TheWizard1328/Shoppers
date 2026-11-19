// Redeployed on 2026-03-28
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';
import { resolveFeatureSecretName } from '../../shared/apiKeyResolver.ts';

// Address verification cache (owner report Nov 19 2026). Suggestions for
// street names that do not exist in the city ("5537 136A Avenue NW" offered
// while typing 138A) must never reach the dropdown. Geocode verdicts are
// cached per address for 10 minutes so repeated keystrokes cost nothing.
const addressVerificationCache = new Map<string, { ok: boolean; at: number }>();
const VERIFY_CACHE_MS = 10 * 60 * 1000;
const normalizeAddressKeyForVerify = (value: unknown) =>
  String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const logApiUsage = async ({
  base44,
  appUserId,
  appUserName,
  provider,
  apiType,
  purpose,
  functionName,
  metadata = {},
  success,
  durationMs,
  errorMessage,
  callCount = 1,
}) => {
  if (!base44) return;

  try {
    await base44.asServiceRole.entities.GoogleAPILog.create({
      timestamp: new Date().toISOString(),
      api_type: apiType,
      purpose,
      function_name: functionName,
      user_id: appUserId || null,
      user_name: appUserName || null,
      metadata: {
        api_provider: provider,
        call_count: Number(callCount) || 1,
        success: success === true,
        duration_ms: durationMs,
        error_message: errorMessage || undefined,
        ...metadata,
      },
    });
  } catch (error) {
    console.warn('[IntegrationUsageLogger] Failed to persist API usage log:', error?.message || error);
  }
};

Deno.serve(async (req) => {
  let base44 = null;
  let user = null;
  let userAppUser = null;
  let input = '';
  let latitude = null;
  let longitude = null;
  let googleApiCallCount = 0;
  let provider = 'google';
  const startedAt = Date.now();

  try {
    base44 = createClientFromRequest(req);

    user = await base44.auth.me();
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    input = body?.input || '';
    latitude = body?.latitude;
    longitude = body?.longitude;

    if (!input || input.trim().length < 3) {
      return Response.json({ predictions: [] });
    }

    const secretName = await resolveFeatureSecretName(base44, 'places_autocomplete');
    const isGoogle = secretName === 'GOOGLE_MAPS_API_KEY';
    provider = isGoogle ? 'google' : 'here';
    const apiKey = Deno.env.get(secretName);
    if (!apiKey) {
      return Response.json({ error: 'API key not configured' }, { status: 500 });
    }

    try {
      const userAppUsers = await base44.asServiceRole.entities.AppUser.filter({ user_id: user.id });
      userAppUser = userAppUsers?.[0] || null;
    } catch (_) {}

    // ── HERE Autosuggest path ───────────────────────────────────────────
    if (!isGoogle) {
      const params = new URLSearchParams();
      params.set('q', input);
      params.set('apiKey', apiKey);
      params.set('language', 'en');
      if (latitude && longitude) {
        params.set('at', `${latitude},${longitude};r=50000`);
      } else {
        params.set('in', 'countryCode:CAN');
      }
      googleApiCallCount += 1;
      const response = await fetch(`https://autosuggest.search.hereapi.com/v1/autosuggest?${params.toString()}`, {
        signal: AbortSignal.timeout(15000),
        headers: { accept: 'application/json' },
      });
      const data = await response.json().catch(() => null);

      if (!response.ok) {
        const errorMsg = data?.title || 'HERE Autosuggest error';
        await logApiUsage({
          base44, appUserId: userAppUser?.id, appUserName: userAppUser?.user_name || user.full_name,
          provider, apiType: 'Places Autocomplete', purpose: 'Address autocomplete search',
          functionName: 'googlePlacesAutocomplete', success: false, durationMs: Date.now() - startedAt,
          errorMessage: errorMsg, callCount: googleApiCallCount,
          metadata: { input, has_location_bias: !!(latitude && longitude), status_code: response.status },
        });
        return Response.json({ error: errorMsg, details: data }, { status: response.status });
      }

      const items = Array.isArray(data?.items) ? data.items : [];
      const predictions = items
        .filter((item) => item && item.id)
        .map((item) => ({
          description: item.title || '',
          place_id: item.id,
          distance: Number.isFinite(Number(item.distance))
            ? parseFloat((Number(item.distance) / 1000).toFixed(2))
            : null,
        }))
        .filter((p) => p.description);

      predictions.sort((a, b) => {
        if (a.distance === null && b.distance === null) return 0;
        if (a.distance === null) return 1;
        if (b.distance === null) return -1;
        return a.distance - b.distance;
      });

      await logApiUsage({
        base44, appUserId: userAppUser?.id, appUserName: userAppUser?.user_name || user.full_name,
        provider, apiType: 'Places Autocomplete', purpose: 'Address autocomplete search',
        functionName: 'googlePlacesAutocomplete', success: true, durationMs: Date.now() - startedAt,
        callCount: googleApiCallCount,
        metadata: { input, has_location_bias: !!(latitude && longitude), suggestion_count: predictions.length },
      });
      return Response.json({ predictions });
    }

    // ── Google Places Autocomplete path (unchanged) ─────────────────────
    const url = 'https://places.googleapis.com/v1/places:autocomplete';
    const requestBody = {
      input,
      languageCode: 'en',
      includedRegionCodes: ['CA']
    };

    if (latitude && longitude) {
      requestBody.origin = { latitude, longitude };
      // OWNER SPEC (Oct 31 2026): callers can demand a STRICT radius (the
      // patient form asks for 50 km around the assigned store) so lookups from
      // other towns never appear. locationRestriction hard-filters server-side;
      // without it the old soft bias (bias only, 50 km) is kept.
      const restrictMeters = Number(body?.restrictRadiusMeters);
      if (Number.isFinite(restrictMeters) && restrictMeters > 0) {
        requestBody.locationRestriction = {
          circle: { center: { latitude, longitude }, radius: Math.min(Math.round(restrictMeters), 50000) }
        };
      } else {
        requestBody.locationBias = {
          circle: { center: { latitude, longitude }, radius: 50000 }
        };
      }
    }

    googleApiCallCount += 1;
    let response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'suggestions.placePrediction.placeId,suggestions.placePrediction.text.text,suggestions.placePrediction.distanceMeters'
      },
      body: JSON.stringify(requestBody)
    });

    let data = await response.json();

    if (!response.ok && latitude && longitude) {
      const fallbackBody = { input, languageCode: 'en', includedRegionCodes: ['CA'] };
      googleApiCallCount += 1;
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': 'suggestions.placePrediction.placeId,suggestions.placePrediction.text.text,suggestions.placePrediction.distanceMeters'
        },
        body: JSON.stringify(fallbackBody)
      });
      data = await response.json();
    }

    if (!response.ok) {
      const errorMsg = data.error?.message || 'Places API error';
      await logApiUsage({
        base44, appUserId: userAppUser?.id, appUserName: userAppUser?.user_name || user.full_name,
        provider, apiType: 'Places Autocomplete', purpose: 'Address autocomplete search',
        functionName: 'googlePlacesAutocomplete', success: false, durationMs: Date.now() - startedAt,
        errorMessage: errorMsg, callCount: googleApiCallCount,
        metadata: { input, has_location_bias: !!(latitude && longitude), status_code: response.status },
      });
      return Response.json({ error: errorMsg, details: data }, { status: response.status });
    }

    const predictions = (data.suggestions || []).map((suggestion) => {
      const placePrediction = suggestion.placePrediction;
      if (!placePrediction) return null;

      return {
        description: placePrediction.text?.text || '',
        place_id: placePrediction.placeId || '',
        distance: Number.isFinite(placePrediction.distanceMeters)
          ? parseFloat((placePrediction.distanceMeters / 1000).toFixed(2))
          : null
      };
    }).filter((prediction) => prediction !== null);

    predictions.sort((a, b) => {
      if (a.distance === null && b.distance === null) return 0;
      if (a.distance === null) return 1;
      if (b.distance === null) return -1;
      return a.distance - b.distance;
    });

    // ── NONEXISTENT-STREET FILTER (owner report Nov 19 2026) ────────────
    // Typing "5537 138A Avenue NW" offered "5537 136A Avenue NW", a street
    // that does not exist in Edmonton, and picking it put the marker on a
    // wrong point. Address-shaped input (a leading street number) now has its
    // top suggestions geocoded, and any that do not resolve to a REAL street
    // address — ROOFTOP or RANGE_INTERPOLATED with no partial_match — is
    // dropped before the dropdown sees it. Deeper suggestions are left alone
    // to keep the per-search geocode count small; the pick gate in
    // googlePlaceDetails still blocks an unverified selection.
    let droppedUnverified = 0;
    if (addressVerificationCache.size > 400) addressVerificationCache.clear();
    const looksLikeAddress = /^\s*\d+[a-zA-Z]?\s+\S/.test(String(input || ''));
    if (looksLikeAddress && predictions.length > 0) {
      const cap = Math.min(predictions.length, 6);
      const head = predictions.slice(0, cap);
      const tail = predictions.slice(cap);
      const verdicts = await Promise.all(head.map(async (prediction) => {
        const key = normalizeAddressKeyForVerify(prediction.description);
        const hit = addressVerificationCache.get(key);
        if (hit && Date.now() - hit.at < VERIFY_CACHE_MS) return hit.ok;
        let ok = true;
        try {
          const geoRes = await fetch(
            `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(prediction.description)}&components=country:CA&key=${apiKey}`
          );
          googleApiCallCount += 1;
          const geo = await geoRes.json();
          const first = (geo?.results || [])[0] || null;
          const locationType = String(first?.geometry?.location_type || '');
          ok = geo?.status === 'OK' && !!first && first?.partial_match !== true &&
            (locationType === 'ROOFTOP' || locationType === 'RANGE_INTERPOLATED');
        } catch {
          ok = true; // a verification failure must never hide real results
        }
        addressVerificationCache.set(key, { ok, at: Date.now() });
        return ok;
      }));
      const kept = head.filter((_, index) => verdicts[index]);
      droppedUnverified = head.length - kept.length;
      if (droppedUnverified > 0) {
        console.log('[googlePlacesAutocomplete] dropped', droppedUnverified, 'unverified suggestion(s) for:', input);
        predictions.length = 0;
        predictions.push(...kept, ...tail);
      }
    }

    await logApiUsage({
      base44, appUserId: userAppUser?.id, appUserName: userAppUser?.user_name || user.full_name,
      provider, apiType: 'Places Autocomplete', purpose: 'Address autocomplete search',
      functionName: 'googlePlacesAutocomplete', success: true, durationMs: Date.now() - startedAt,
      callCount: googleApiCallCount,
      metadata: { input, has_location_bias: !!(latitude && longitude), suggestion_count: predictions.length, dropped_unverified: droppedUnverified },
    });
    return Response.json({ predictions });
  } catch (error) {
    console.error('[googlePlacesAutocomplete] Error:', error.message);
    await logApiUsage({
      base44, appUserId: userAppUser?.id, appUserName: userAppUser?.user_name || null,
      provider, apiType: 'Places Autocomplete', purpose: 'Address autocomplete search',
      functionName: 'googlePlacesAutocomplete', success: false, durationMs: Date.now() - startedAt,
      errorMessage: error.message, callCount: googleApiCallCount || 1,
      metadata: { input, has_location_bias: !!(latitude && longitude) },
    });
    return Response.json({ error: error.message }, { status: 500 });
  }
});