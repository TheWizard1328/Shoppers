// Redeployed on 2026-03-28
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

function getComponent(components, type) {
  return (components || []).find((component) => Array.isArray(component?.types) && component.types.includes(type)) || null;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { place_id } = await req.json().catch(() => ({}));

    if (!place_id) {
      return Response.json({ error: 'Missing place_id' }, { status: 400 });
    }

    const apiKey = Deno.env.get('GOOGLE_MAPS_API_KEY');
    if (!apiKey) {
      return Response.json({ error: 'API key not configured' }, { status: 500 });
    }

    const response = await fetch(`https://places.googleapis.com/v1/places/${place_id}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'id,formattedAddress,location,addressComponents'
      }
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      return Response.json({ error: data?.error?.message || 'Place details error', details: data }, { status: response.status });
    }

    const addressComponents = data?.addressComponents || [];
    const streetNumber = getComponent(addressComponents, 'street_number')?.longText || null;
    const route = getComponent(addressComponents, 'route')?.longText || null;
    const subpremise = getComponent(addressComponents, 'subpremise')?.longText || null;
    const premise = getComponent(addressComponents, 'premise')?.longText || null;

    return Response.json({
      place_id: data?.id || place_id,
      formatted_address: data?.formattedAddress || '',
      address: [streetNumber, route].filter(Boolean).join(' ').trim(),
      street_number: streetNumber,
      route,
      unit: subpremise || premise || null,
      latitude: typeof data?.location?.latitude === 'number' ? data.location.latitude : null,
      longitude: typeof data?.location?.longitude === 'number' ? data.location.longitude : null,
      lat: typeof data?.location?.latitude === 'number' ? data.location.latitude : null,
      lng: typeof data?.location?.longitude === 'number' ? data.location.longitude : null
    });
  } catch (error) {
    return Response.json({ error: error?.message || 'Internal Server Error' }, { status: 500 });
  }
});