import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

function round2(value) {
  return Number(Number(value).toFixed(2));
}

function haversineKm(from, to) {
  const toRadians = (value) => (value * Math.PI) / 180;
  const earthRadiusKm = 6371;
  const dLat = toRadians(to.lat - from.lat);
  const dLon = toRadians(to.lon - from.lon);
  const lat1 = toRadians(from.lat);
  const lat2 = toRadians(to.lat);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return round2(earthRadiusKm * c);
}

function getLatLon(delivery, patientMap, storeMap) {
  if (!delivery) return null;

  if (delivery.patient_id) {
    const patient = patientMap.get(delivery.patient_id);
    if (patient?.latitude != null && patient?.longitude != null) {
      return { lat: Number(patient.latitude), lon: Number(patient.longitude) };
    }
  }

  if (delivery.store_id) {
    const store = storeMap.get(delivery.store_id);
    if (store?.latitude != null && store?.longitude != null) {
      return { lat: Number(store.latitude), lon: Number(store.longitude) };
    }
  }

  return null;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const { deliveryId, expectedTravelDist = null, force = false } = body || {};

    if (!deliveryId) {
      return Response.json({ error: 'deliveryId is required' }, { status: 400 });
    }

    const delivery = await base44.asServiceRole.entities.Delivery.get(deliveryId);
    if (!delivery) {
      return Response.json({ error: 'Delivery not found' }, { status: 404 });
    }

    const allDeliveries = await base44.asServiceRole.entities.Delivery.filter({
      driver_id: delivery.driver_id,
      delivery_date: delivery.delivery_date
    }, 'stop_order', 50000);

    const sortedDeliveries = [...(allDeliveries || [])].sort((a, b) => (Number(a?.stop_order) || 0) - (Number(b?.stop_order) || 0));
    const currentIndex = sortedDeliveries.findIndex((item) => item?.id === deliveryId);
    if (currentIndex === -1) {
      return Response.json({ error: 'Delivery not found in route' }, { status: 404 });
    }

    const currentDelivery = sortedDeliveries[currentIndex];
    const previousDelivery = currentIndex > 0 ? sortedDeliveries[currentIndex - 1] : null;

    const patientIds = [...new Set(sortedDeliveries.filter((item) => item?.patient_id).map((item) => item.patient_id))];
    const storeIds = [...new Set(sortedDeliveries.filter((item) => item?.store_id).map((item) => item.store_id))];

    const [patients, stores] = await Promise.all([
      patientIds.length ? base44.asServiceRole.entities.Patient.filter({ id: { $in: patientIds } }, undefined, 50000) : [],
      storeIds.length ? base44.asServiceRole.entities.Store.filter({ id: { $in: storeIds } }, undefined, 50000) : []
    ]);

    const patientMap = new Map((patients || []).map((patient) => [patient.id, patient]));
    const storeMap = new Map((stores || []).map((store) => [store.id, store]));

    const from = previousDelivery ? getLatLon(previousDelivery, patientMap, storeMap) : (() => {
      const store = storeMap.get(currentDelivery?.store_id);
      if (store?.latitude != null && store?.longitude != null) {
        return { lat: Number(store.latitude), lon: Number(store.longitude) };
      }
      return null;
    })();
    const to = getLatLon(currentDelivery, patientMap, storeMap);

    if (!from || !to) {
      return Response.json({ success: false, skipped: true, reason: 'missing_coordinates' });
    }

    const fallbackDistance = haversineKm(from, to);
    const shouldUpdate = force || Number(currentDelivery.travel_dist || 0) <= 0 || (
      Number.isFinite(Number(expectedTravelDist)) && Math.abs(Number(currentDelivery.travel_dist || 0) - Number(expectedTravelDist)) > 0.25
    );

    if (!shouldUpdate) {
      return Response.json({ success: true, skipped: true, travel_dist: currentDelivery.travel_dist });
    }

    const directionsResponse = await base44.functions.invoke('getHereDirections', {
      origin: { lat: from.lat, lng: from.lon },
      destination: { lat: to.lat, lng: to.lon }
    });
    const directions = directionsResponse?.data || directionsResponse || {};
    const resolvedDistance = Number.isFinite(Number(directions?.estimated_distance_km)) && Number(directions.estimated_distance_km) > 0
      ? round2(Number(directions.estimated_distance_km))
      : fallbackDistance;

    await base44.asServiceRole.entities.Delivery.update(deliveryId, { travel_dist: resolvedDistance });

    return Response.json({
      success: true,
      travel_dist: resolvedDistance,
      source: Number(directions?.estimated_distance_km) > 0 ? 'route_metadata' : 'fallback'
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});