import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

const toRadians = (value) => (Number(value) * Math.PI) / 180;

const calculateDistanceKm = (origin, destination) => {
  const lat1 = Number(origin?.lat);
  const lon1 = Number(origin?.lng);
  const lat2 = Number(destination?.lat);
  const lon2 = Number(destination?.lng);

  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return null;

  const earthRadiusKm = 6371;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return earthRadiusKm * c;
};

const estimateDurationMinutes = (distanceKm, averageSpeedKmh = 40) => {
  if (!Number.isFinite(distanceKm)) return null;
  return Math.max(1, Math.round(distanceKm / averageSpeedKmh * 60));
};

const APP_TIMEZONE = 'America/Edmonton';

const formatLocalIsoWithoutOffset = (date) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const year = parts.find((part) => part.type === 'year')?.value || '0000';
  const month = parts.find((part) => part.type === 'month')?.value || '00';
  const day = parts.find((part) => part.type === 'day')?.value || '00';
  const hour = parts.find((part) => part.type === 'hour')?.value || '00';
  const minute = parts.find((part) => part.type === 'minute')?.value || '00';
  const second = parts.find((part) => part.type === 'second')?.value || '00';

  return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
};

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const payload = await req.json().catch(() => ({}));
    const driver = payload?.driver || {};
    const deliveries = Array.isArray(payload?.deliveries) ? payload.deliveries : [];
    const currentLocation = payload?.currentLocation || {
      lat: driver?.current_latitude,
      lng: driver?.current_longitude,
    };

    const fallbackLocation = {
      lat: driver?.home_latitude,
      lng: driver?.home_longitude,
    };

    const resolvedLocation = Number.isFinite(Number(currentLocation?.lat)) && Number.isFinite(Number(currentLocation?.lng))
      ? currentLocation
      : Number.isFinite(Number(fallbackLocation?.lat)) && Number.isFinite(Number(fallbackLocation?.lng))
        ? fallbackLocation
        : null;

    if (!resolvedLocation) {
      return Response.json({ etaEstimates: [] });
    }

    const etaEstimates = deliveries
      .map((delivery) => {
        const destination = {
          lat: delivery?.latitude,
          lng: delivery?.longitude,
        };

        const distance_km = calculateDistanceKm(resolvedLocation, destination);
        const estimated_duration_minutes = estimateDurationMinutes(distance_km);

        if (!Number.isFinite(distance_km) || !Number.isFinite(estimated_duration_minutes)) {
          return null;
        }

        const etaDate = new Date(Date.now() + estimated_duration_minutes * 60000);

        return {
          delivery_id: delivery?.id || delivery?.delivery_id || null,
          distance_km: Number(distance_km.toFixed(2)),
          estimated_duration_minutes,
          estimated_arrival_time: formatLocalIsoWithoutOffset(etaDate),
        };
      })
      .filter(Boolean);

    return Response.json({ etaEstimates });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});