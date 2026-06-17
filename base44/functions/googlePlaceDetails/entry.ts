import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

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

    const apiKey = Deno.env.get('GOOGLE_MAPS_API_KEY');
    if (!apiKey) {
      return Response.json({ error: 'API key not configured' }, { status: 500 });
    }

    // Call Google Places API (New) v1 to get full address details
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
        base44,
        appUserId: appUser?.id,
        appUserName: appUser?.user_name || user.full_name,
        provider: 'google',
        apiType: 'Place Details',
        purpose: 'Fetch place details',
        functionName: 'googlePlaceDetails',
        success: false,
        durationMs: Date.now() - startedAt,
        errorMessage: errorText,
        metadata: { place_id },
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

    await logApiUsage({
      base44,
      appUserId: appUser?.id,
      appUserName: appUser?.user_name || user.full_name,
      provider: 'google',
      apiType: 'Place Details',
      purpose: 'Fetch place details',
      functionName: 'googlePlaceDetails',
      success: true,
      durationMs: Date.now() - startedAt,
      metadata: { place_id },
    });

    return Response.json({
      address,
      unit,
      formatted_address: result.formattedAddress,
      latitude: result.location?.latitude,
      longitude: result.location?.longitude
    });

  } catch (error) {
    console.error('Error in googlePlaceDetails:', error);
    await logApiUsage({
      base44,
      appUserId: appUser?.id,
      appUserName: appUser?.user_name || null,
      provider: 'google',
      apiType: 'Place Details',
      purpose: 'Fetch place details',
      functionName: 'googlePlaceDetails',
      success: false,
      durationMs: Date.now() - startedAt,
      errorMessage: error.message,
    });
    return Response.json({ error: error.message }, { status: 500 });
  }
});