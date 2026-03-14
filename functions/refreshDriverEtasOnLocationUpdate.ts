import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

const ACTIVE_STATUSES = ['pending', 'in_transit', 'en_route'];
const INACTIVE_STATUSES = ['completed', 'failed', 'cancelled'];
const DISTANCE_THRESHOLD_KM = 0.5;
const APP_TIMEZONE = 'America/Edmonton';

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatEta(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function getWaypointForDelivery(delivery, patientMap, storeMap) {
  if (delivery.patient_id) {
    const patient = patientMap.get(delivery.patient_id);
    if (patient?.latitude != null && patient?.longitude != null) {
      return {
        latitude: Number(patient.latitude),
        longitude: Number(patient.longitude),
      };
    }
  }

  const store = storeMap.get(delivery.store_id);
  if (store?.latitude != null && store?.longitude != null) {
    return {
      latitude: Number(store.latitude),
      longitude: Number(store.longitude),
    };
  }

  return null;
}

async function getHereRoute(origin, stops) {
  const apiKey = Deno.env.get('HERE_API_KEY');
  if (!apiKey) {
    throw new Error('HERE_API_KEY is not configured');
  }

  const params = new URLSearchParams({
    transportMode: 'car',
    origin: `${origin.latitude},${origin.longitude}`,
    destination: `${stops[stops.length - 1].latitude},${stops[stops.length - 1].longitude}`,
    return: 'summary',
    apiKey,
  });

  for (let i = 0; i < stops.length - 1; i += 1) {
    params.append('via', `${stops[i].latitude},${stops[i].longitude}`);
  }

  const response = await fetch(`https://router.hereapi.com/v8/routes?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`HERE routing failed with ${response.status}`);
  }

  const data = await response.json();
  const route = data?.routes?.[0];
  if (!route?.sections?.length) {
    throw new Error('HERE routing returned no route sections');
  }

  return route.sections;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const payload = await req.json().catch(() => ({}));
    const appUser = payload?.data;
    const oldAppUser = payload?.old_data;

    if (!appUser?.user_id) {
      return Response.json({ skipped: true, reason: 'No AppUser payload' });
    }

    const isDriver = Array.isArray(appUser.app_roles) && appUser.app_roles.includes('driver');
    if (!isDriver) {
      return Response.json({ skipped: true, reason: 'User is not a driver' });
    }

    if (appUser.driver_status !== 'on_duty') {
      return Response.json({ skipped: true, reason: 'Driver is not on duty' });
    }

    if (appUser.location_tracking_enabled === false) {
      return Response.json({ skipped: true, reason: 'Location tracking disabled' });
    }

    const currentLat = toNumber(appUser.current_latitude);
    const currentLon = toNumber(appUser.current_longitude);
    if (currentLat == null || currentLon == null) {
      return Response.json({ skipped: true, reason: 'Missing current coordinates' });
    }

    const previousLat = toNumber(oldAppUser?.current_latitude);
    const previousLon = toNumber(oldAppUser?.current_longitude);
    if (previousLat != null && previousLon != null) {
      const movedKm = haversineKm(previousLat, previousLon, currentLat, currentLon);
      if (movedKm < DISTANCE_THRESHOLD_KM) {
        return Response.json({ skipped: true, reason: 'Movement below threshold', moved_km: movedKm });
      }
    }

    const now = new Date();
    const today = now.toLocaleDateString('en-CA', { timeZone: APP_TIMEZONE });
    const allDeliveries = await base44.asServiceRole.entities.Delivery.filter({
      driver_id: appUser.user_id,
      delivery_date: today,
    }, 'stop_order', 500);

    const activeDeliveries = allDeliveries
      .filter((delivery) => !INACTIVE_STATUSES.includes(delivery.status))
      .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));

    const hasLiveStop = activeDeliveries.some((delivery) => ['in_transit', 'en_route'].includes(delivery.status) || delivery.isNextDelivery === true);
    if (!activeDeliveries.length || !hasLiveStop) {
      return Response.json({ skipped: true, reason: 'No active live stops found' });
    }

    const patientIds = [...new Set(activeDeliveries.map((delivery) => delivery.patient_id).filter(Boolean))];
    const storeIds = [...new Set(activeDeliveries.map((delivery) => delivery.store_id).filter(Boolean))];

    const [patients, stores] = await Promise.all([
      patientIds.length ? base44.asServiceRole.entities.Patient.list(undefined, 1000) : Promise.resolve([]),
      storeIds.length ? base44.asServiceRole.entities.Store.list(undefined, 500) : Promise.resolve([]),
    ]);

    const patientMap = new Map(patients.filter((patient) => patientIds.includes(patient.id)).map((patient) => [patient.id, patient]));
    const storeMap = new Map(stores.filter((store) => storeIds.includes(store.id)).map((store) => [store.id, store]));

    const routeStops = [];
    const deliveriesToUpdate = [];

    for (const delivery of activeDeliveries) {
      if (!ACTIVE_STATUSES.includes(delivery.status)) {
        continue;
      }

      const waypoint = getWaypointForDelivery(delivery, patientMap, storeMap);
      if (!waypoint) {
        continue;
      }

      routeStops.push(waypoint);
      deliveriesToUpdate.push(delivery);
    }

    if (!deliveriesToUpdate.length) {
      return Response.json({ skipped: true, reason: 'No mappable active stops found' });
    }

    const sections = await getHereRoute({ latitude: currentLat, longitude: currentLon }, routeStops);

    let cumulativeSeconds = 0;
    let updatedCount = 0;
    const baseNow = new Date();

    for (let i = 0; i < deliveriesToUpdate.length; i += 1) {
      const delivery = deliveriesToUpdate[i];
      const travelSeconds = Number(sections[i]?.summary?.duration || 0);
      const extraSeconds = Math.max(0, Number(delivery.extra_time || 0) * 60);
      cumulativeSeconds += travelSeconds + extraSeconds;

      const etaDate = new Date(baseNow.getTime() + cumulativeSeconds * 1000);
      await base44.asServiceRole.entities.Delivery.update(delivery.id, {
        delivery_time_eta: formatEta(etaDate),
      });
      updatedCount += 1;
    }

    return Response.json({
      success: true,
      updated_count: updatedCount,
      driver_id: appUser.user_id,
      delivery_date: today,
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});