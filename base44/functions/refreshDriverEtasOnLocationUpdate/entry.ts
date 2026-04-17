// Redeployed on 2026-03-28
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

const isNotFoundError = (error) => error?.status === 404 || error?.response?.status === 404 || String(error?.message || '').toLowerCase().includes('not found');

const ACTIVE_STATUSES = ['in_transit', 'en_route'];
const INACTIVE_STATUSES = ['pending', 'completed', 'failed', 'cancelled'];
const APP_TIMEZONE = 'America/Edmonton';
const ETA_DRIFT_THRESHOLD_MINUTES = 5;
const MIN_DISTANCE_TRAVELED_METERS = 100;

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function calculateDistanceInMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function getEdmontonDate(value = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(value);
}

function getEdmontonNowParts() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(new Date());

  return {
    date: `${parts.find((part) => part.type === 'year')?.value || '0000'}-${parts.find((part) => part.type === 'month')?.value || '00'}-${parts.find((part) => part.type === 'day')?.value || '00'}`,
    time: `${parts.find((part) => part.type === 'hour')?.value || '00'}:${parts.find((part) => part.type === 'minute')?.value || '00'}`
  };
}

function extractTimeFromDateTime(value) {
  const match = String(value || '').match(/T(\d{2}:\d{2})/);
  return match ? match[1] : null;
}

function buildEtaBaseDate(deliveryDate, finishedDeliveries) {
  const now = getEdmontonNowParts();
  const routeIsPastDate = deliveryDate < now.date;
  const routeIsLateToday = deliveryDate === now.date && (etaToMinutes(now.time) ?? 0) >= (21 * 60);
  const shouldUseFinishedStopTime = routeIsPastDate || routeIsLateToday;

  if (!shouldUseFinishedStopTime) {
    return new Date();
  }

  const latestFinished = [...(finishedDeliveries || [])]
    .filter((delivery) => delivery?.actual_delivery_time)
    .sort((a, b) => new Date(b.actual_delivery_time).getTime() - new Date(a.actual_delivery_time).getTime())[0];

  const baseTime = extractTimeFromDateTime(latestFinished?.actual_delivery_time) || '00:00';
  const [hours, minutes] = baseTime.split(':').map(Number);
  return new Date(`${deliveryDate}T${String(hours || 0).padStart(2, '0')}:${String(minutes || 0).padStart(2, '0')}:00-07:00`);
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

  const previousLat = toNumber(appUser.previous_latitude ?? appUser.old_current_latitude);
  const previousLon = toNumber(appUser.previous_longitude ?? appUser.old_current_longitude);
  if (previousLat != null && previousLon != null) {
    const movedMeters = calculateDistanceInMeters(previousLat, previousLon, currentLat, currentLon);
    if (movedMeters < MIN_DISTANCE_TRAVELED_METERS) {
      return {
        skipped: true,
        reason: 'movement_below_threshold',
        driver_id: appUser.user_id,
        moved_meters: Math.round(movedMeters)
      };
    }
  }

  const allDeliveries = await base44.asServiceRole.entities.Delivery.filter({
    driver_id: appUser.user_id,
    delivery_date: deliveryDate,
  }, 'stop_order', 500);

  const activeDeliveries = (allDeliveries || [])
    .filter((delivery) => ACTIVE_STATUSES.includes(delivery.status))
    .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));

  const finishedDeliveries = (allDeliveries || [])
    .filter((delivery) => INACTIVE_STATUSES.includes(delivery.status));

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
  const baseNow = buildEtaBaseDate(deliveryDate, finishedDeliveries);

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

    if (!explicitDriverId) {
      return Response.json({ success: true, skipped: true, reason: 'driver_id_required', delivery_date: deliveryDate });
    }

    const drivers = await base44.asServiceRole.entities.AppUser.filter({ user_id: explicitDriverId }, '-updated_date', 1);

    if (!drivers.length) {
      return Response.json({ success: true, skipped: true, reason: 'no_drivers_to_process', delivery_date: deliveryDate });
    }

    const driver = drivers[0];
    const locationUpdatedAtMs = new Date(driver?.location_updated_at || 0).getTime();
    if (locationUpdatedAtMs && (Date.now() - locationUpdatedAtMs) < 30000) {
      return Response.json({ success: true, skipped: true, reason: 'recent_location_update_cooldown', delivery_date: deliveryDate, driver_id: explicitDriverId });
    }

    const results = [];
    for (const driver of drivers) {
      try {
        results.push(await processDriver(base44, driver, deliveryDate));
      } catch (error) {
        const isRateLimited = error?.status === 429 || error?.response?.status === 429 || String(error?.message || '').toLowerCase().includes('rate limit');
        if (isRateLimited) {
          results.push({ skipped: true, reason: 'rate_limited', driver_id: driver?.user_id || null });
          continue;
        }
        throw error;
      }
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