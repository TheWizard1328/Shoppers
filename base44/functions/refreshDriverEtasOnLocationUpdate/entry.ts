// Redeployed on 2026-03-28
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.21';

const isNotFoundError = (error) => error?.status === 404 || error?.response?.status === 404 || String(error?.message || '').toLowerCase().includes('not found');

const ACTIVE_STATUSES = ['pending', 'in_transit', 'en_route'];
const INACTIVE_STATUSES = ['completed', 'failed', 'cancelled'];
const APP_TIMEZONE = 'America/Edmonton';
const ETA_DRIFT_THRESHOLD_MINUTES = 5;

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function getEdmontonDate(value = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(value);
}

function formatEta(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function etaToMinutes(value) {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
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

async function processDriver(base44, appUser, deliveryDate) {
  const isDriver = Array.isArray(appUser?.app_roles) && appUser.app_roles.includes('driver');
  if (!isDriver) return { skipped: true, reason: 'not_driver', driver_id: appUser?.user_id || null };
  if (appUser.driver_status !== 'on_duty') return { skipped: true, reason: 'driver_not_on_duty', driver_id: appUser.user_id };
  if (appUser.location_tracking_enabled === false) return { skipped: true, reason: 'tracking_disabled', driver_id: appUser.user_id };

  const currentLat = toNumber(appUser.current_latitude);
  const currentLon = toNumber(appUser.current_longitude);
  if (currentLat == null || currentLon == null) {
    return { skipped: true, reason: 'missing_coordinates', driver_id: appUser.user_id };
  }

  const allDeliveries = await base44.asServiceRole.entities.Delivery.filter({
    driver_id: appUser.user_id,
    delivery_date: deliveryDate,
  }, 'stop_order', 500);

  const activeDeliveries = (allDeliveries || [])
    .filter((delivery) => !INACTIVE_STATUSES.includes(delivery.status))
    .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));

  const hasLiveStop = activeDeliveries.some((delivery) => ['in_transit', 'en_route'].includes(delivery.status) || delivery.isNextDelivery === true);
  if (!activeDeliveries.length || !hasLiveStop) {
    return { skipped: true, reason: 'no_active_live_stops', driver_id: appUser.user_id };
  }

  const patientIds = [...new Set(activeDeliveries.map((delivery) => delivery.patient_id).filter(Boolean))];
  const storeIds = [...new Set(activeDeliveries.map((delivery) => delivery.store_id).filter(Boolean))];

  const [patients, stores] = await Promise.all([
    patientIds.length ? base44.asServiceRole.entities.Patient.filter({ id: { $in: patientIds } }, '-updated_date', patientIds.length) : [],
    storeIds.length ? base44.asServiceRole.entities.Store.filter({ id: { $in: storeIds } }, '-updated_date', storeIds.length) : [],
  ]);

  const patientMap = new Map((patients || []).filter(Boolean).map((patient) => [patient.id, patient]));
  const storeMap = new Map((stores || []).filter(Boolean).map((store) => [store.id, store]));

  const routeStops = [];
  const deliveriesToProject = [];

  for (const delivery of activeDeliveries) {
    if (!ACTIVE_STATUSES.includes(delivery.status)) continue;
    const waypoint = getWaypointForDelivery(delivery, patientMap, storeMap);
    if (!waypoint) continue;
    routeStops.push(waypoint);
    deliveriesToProject.push(delivery);
  }

  if (!deliveriesToProject.length) {
    return { skipped: true, reason: 'no_mappable_active_stops', driver_id: appUser.user_id };
  }

  const nextDelivery = deliveriesToProject.find((delivery) => delivery.isNextDelivery === true) || deliveriesToProject[0];
  if (!nextDelivery) {
    return { skipped: true, reason: 'no_next_delivery', driver_id: appUser.user_id };
  }

  const sections = await getHereRoute({ latitude: currentLat, longitude: currentLon }, routeStops);
  if (!sections?.length) {
    return { skipped: true, reason: 'no_route_sections', driver_id: appUser.user_id };
  }

  const etaUpdates = [];
  let cumulativeSeconds = 0;
  const baseNow = new Date();

  for (let i = 0; i < deliveriesToProject.length; i += 1) {
    const delivery = deliveriesToProject[i];
    const travelSeconds = Number(sections[i]?.summary?.duration || 0);
    const extraSeconds = Math.max(0, Number(delivery.extra_time || 0) * 60);
    cumulativeSeconds += travelSeconds + extraSeconds;
    const etaValue = formatEta(new Date(baseNow.getTime() + cumulativeSeconds * 1000));
    etaUpdates.push({ delivery, etaValue });
  }

  const nextEtaProjection = etaUpdates.find((entry) => entry.delivery.id === nextDelivery.id)?.etaValue || null;
  const currentEtaMinutes = etaToMinutes(nextDelivery.delivery_time_eta);
  const projectedEtaMinutes = etaToMinutes(nextEtaProjection);
  const driftMinutes = currentEtaMinutes == null || projectedEtaMinutes == null
    ? null
    : Math.abs(projectedEtaMinutes - currentEtaMinutes);

  if (driftMinutes != null && driftMinutes <= ETA_DRIFT_THRESHOLD_MINUTES) {
    return {
      skipped: true,
      reason: 'eta_within_threshold',
      driver_id: appUser.user_id,
      next_delivery_id: nextDelivery.id,
      drift_minutes: driftMinutes,
    };
  }

  let updatedCount = 0;
  for (const entry of etaUpdates) {
    if (entry.delivery.delivery_time_eta === entry.etaValue) continue;
    await base44.asServiceRole.entities.Delivery.update(entry.delivery.id, {
      delivery_time_eta: entry.etaValue,
    }).catch((error) => {
      if (isNotFoundError(error)) return null;
      throw error;
    });
    updatedCount += 1;
  }

  return {
    success: true,
    driver_id: appUser.user_id,
    delivery_date: deliveryDate,
    next_delivery_id: nextDelivery.id,
    drift_minutes: driftMinutes,
    updated_count: updatedCount,
  };
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const payload = await req.json().catch(() => ({}));
    const deliveryDate = payload?.deliveryDate || getEdmontonDate();
    const explicitDriverId = payload?.driverId || payload?.data?.user_id || null;

    let drivers = [];
    if (explicitDriverId) {
      drivers = await base44.asServiceRole.entities.AppUser.filter({ user_id: explicitDriverId }, '-updated_date', 1);
    } else {
      drivers = await base44.asServiceRole.entities.AppUser.filter({ driver_status: 'on_duty' }, '-updated_date', 500);
      drivers = (drivers || []).filter((appUser) => Array.isArray(appUser?.app_roles) && appUser.app_roles.includes('driver'));
    }

    if (!drivers.length) {
      return Response.json({ success: true, skipped: true, reason: 'no_drivers_to_process', delivery_date: deliveryDate });
    }

    const results = [];
    for (const driver of drivers) {
      results.push(await processDriver(base44, driver, deliveryDate));
    }

    return Response.json({
      success: true,
      delivery_date: deliveryDate,
      processed_drivers: results.length,
      updated_drivers: results.filter((result) => result?.updated_count > 0).length,
      total_updated_deliveries: results.reduce((sum, result) => sum + Number(result?.updated_count || 0), 0),
      results,
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});