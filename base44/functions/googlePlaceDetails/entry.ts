import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';
import { resolveFeatureSecretName } from '../../shared/apiKeyResolver.ts';

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
  let appUser = null;
  let provider = 'google';
  const startedAt = Date.now();
  try {
    base44 = createClientFromRequest(req);

    // Verify user is authenticated
    const user = await base44.auth.me();
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { place_id } = await req.json();
    const appUsers = await base44.asServiceRole.entities.AppUser.filter({ user_id: user.id }, '-updated_date', 1);
    appUser = appUsers?.[0] || null;

    if (!place_id) {
      return Response.json({ error: 'place_id is required' }, { status: 400 });
    }

    const secretName = await resolveFeatureSecretName(base44, 'place_details');
    const isGoogle = secretName === 'GOOGLE_MAPS_API_KEY';
    provider = isGoogle ? 'google' : 'here';
    const apiKey = Deno.env.get(secretName);
    if (!apiKey) {
      return Response.json({ error: 'API key not configured' }, { status: 500 });
    }

    // ── HERE Places Lookup path ─────────────────────────────────────────
    if (!isGoogle) {
      const url = `https://lookup.search.hereapi.com/v1/lookup?id=${encodeURIComponent(place_id)}&apiKey=${apiKey}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { accept: 'application/json' } });
      if (!response.ok) {
        const errorText = await response.text();
        console.error('HERE Lookup API error:', errorText);
        await logApiUsage({
          base44, appUserId: appUser?.id, appUserName: appUser?.user_name || user.full_name,
          provider, apiType: 'Place Details', purpose: 'Fetch place details',
          functionName: 'googlePlaceDetails', success: false, durationMs: Date.now() - startedAt,
          errorMessage: errorText, metadata: { place_id },
        });
        return Response.json({ error: 'HERE Lookup API error: ' + errorText }, { status: response.status || 500 });
      }
      const result = await response.json();
      const addr = result?.address || {};
      const street = `${addr.houseNumber ? addr.houseNumber + ' ' : ''}${addr.street || ''}`.trim();
      const formatted = result?.title || addr.label || '';
      const position = result?.position || {};

      await logApiUsage({
        base44, appUserId: appUser?.id, appUserName: appUser?.user_name || user.full_name,
        provider, apiType: 'Place Details', purpose: 'Fetch place details',
        functionName: 'googlePlaceDetails', success: true, durationMs: Date.now() - startedAt,
        metadata: { place_id },
      });

      return Response.json({
        address: street,
        unit: '',
        formatted_address: formatted,
        latitude: position.lat ?? null,
        longitude: position.lng ?? null,
      });
    }

    // ── Google Places Details path (unchanged) ─────────────────────────
    const url = `https://places.googleapis.com/v1/places/${place_id}?fields=addressComponents,formattedAddress,location&key=${apiKey}`;

    const response = await fetch(url, {
      headers: {
        'X-Goog-FieldMask': 'addressComponents,formattedAddress,location'
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Google Places API error:', errorText);
      await logApiUsage({
        base44, appUserId: appUser?.id, appUserName: appUser?.user_name || user.full_name,
        provider, apiType: 'Place Details', purpose: 'Fetch place details',
        functionName: 'googlePlaceDetails', success: false, durationMs: Date.now() - startedAt,
        errorMessage: errorText, metadata: { place_id },
      });
      return Response.json({ error: 'Places API error: ' + errorText }, { status: response.status || 500 });
    }

    const result = await response.json();
    const addressComponents = result.addressComponents || [];

    // Extract relevant components (New API uses longText instead of long_name)
    let streetNumber = '';
    let route = '';
    let subpremise = '';

    addressComponents.forEach(component => {
      if (component.types?.includes('street_number')) {
        streetNumber = component.longText || component.shortText || '';
      } else if (component.types?.includes('route')) {
        route = component.longText || component.shortText || '';
      } else if (component.types?.includes('subpremise')) {
        subpremise = component.longText || component.shortText || '';
      }
    });

    const address = `${streetNumber} ${route}`.trim();
    const unit = subpremise;

    // ── ADDRESS VERIFICATION (owner report Nov 19 2026) ────────────────
    // Google autocomplete happily offers street names that do not exist in the
    // city: typing "5537 138A Avenue NW" produced a suggestion for
    // "5537 136A Avenue NW", the form accepted its coordinates, and the driver
    // was routed to a wrong point. Every selected place is now geocoded and
    // must resolve to a REAL street address — ROOFTOP or RANGE_INTERPOLATED
    // with no partial_match — before a caller may take its coordinates.
    // Anything else returns verified:false plus a reason, and the address form
    // refuses the selection instead of dropping a marker.
    let verified: boolean | null = null;
    let verificationReason: string | null = null;
    let locationType: string | null = null;
    let partialMatch = false;
    try {
      const geocodeTarget = result.formattedAddress || address;
      const geoRes = await fetch(
        `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(geocodeTarget)}&components=country:CA&key=${apiKey}`
      );
      const geo = await geoRes.json();
      const first = (geo?.results || [])[0] || null;
      locationType = first?.geometry?.location_type || null;
      partialMatch = first?.partial_match === true;
      if (geo?.status !== 'OK' || !first) {
        verified = false;
        verificationReason = 'not_found';
      } else if (partialMatch) {
        verified = false;
        verificationReason = 'partial_match';
      } else if (!['ROOFTOP', 'RANGE_INTERPOLATED'].includes(String(locationType))) {
        verified = false;
        verificationReason = 'imprecise';
      } else {
        verified = true;
      }
    } catch (verifyErr) {
      // A verification hiccup must never block a real lookup — report unknown.
      verified = null;
      verificationReason = 'check_failed';
    }

    await logApiUsage({
      base44, appUserId: appUser?.id, appUserName: appUser?.user_name || user.full_name,
      provider, apiType: 'Place Details', purpose: 'Fetch place details',
      functionName: 'googlePlaceDetails', success: true, durationMs: Date.now() - startedAt,
      metadata: { place_id, verified, verification_reason: verificationReason, location_type: locationType },
    });

    return Response.json({
      address,
      unit,
      formatted_address: result.formattedAddress,
      latitude: result.location?.latitude,
      longitude: result.location?.longitude,
      verified,
      verification_reason: verificationReason,
      location_type: locationType,
      partial_match: partialMatch
    });

  } catch (error) {
    console.error('Error in googlePlaceDetails:', error);
    await logApiUsage({
      base44, appUserId: appUser?.id, appUserName: appUser?.user_name || null,
      provider, apiType: 'Place Details', purpose: 'Fetch place details',
      functionName: 'googlePlaceDetails', success: false, durationMs: Date.now() - startedAt,
      errorMessage: error.message,
    });
    return Response.json({ error: error.message }, { status: 500 });
  }
});