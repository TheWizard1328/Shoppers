/* global Deno */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

const randomBetween = (min, max) => Math.random() * (max - min) + min;
const randomInt = (min, max) => Math.floor(randomBetween(min, max + 1));
const pick = (items) => items[Math.floor(Math.random() * items.length)];
const addDays = (date, days) => {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
};
const formatDate = (date) => date.toISOString().split('T')[0];
const toRadians = (degrees) => degrees * (Math.PI / 180);
const offsetCoordinates = (latitude, longitude, distanceKm, angleDegrees) => {
  const earthRadiusKm = 6371;
  const bearing = toRadians(angleDegrees);
  const latRad = toRadians(latitude);
  const lonRad = toRadians(longitude);
  const angularDistance = distanceKm / earthRadiusKm;

  const newLat = Math.asin(
    Math.sin(latRad) * Math.cos(angularDistance) +
    Math.cos(latRad) * Math.sin(angularDistance) * Math.cos(bearing)
  );

  const newLon = lonRad + Math.atan2(
    Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latRad),
    Math.cos(angularDistance) - Math.sin(latRad) * Math.sin(newLat)
  );

  return {
    latitude: Number((newLat * 180 / Math.PI).toFixed(6)),
    longitude: Number((newLon * 180 / Math.PI).toFixed(6))
  };
};

const firstNames = ['Emma', 'Noah', 'Olivia', 'Liam', 'Sophia', 'Mason', 'Ava', 'Ethan', 'Mia', 'Lucas', 'Amelia', 'Logan'];
const lastNames = ['Johnson', 'Smith', 'Brown', 'Taylor', 'Wilson', 'Martin', 'Lee', 'Clark', 'Young', 'Hall', 'Allen', 'King'];
const streetNames = ['Maple', 'Oak', 'Cedar', 'Pine', 'Spruce', 'River', 'Lake', 'Hill', 'Park', 'Elm', 'Sunset', 'Meadow'];
const streetTypes = ['Street', 'Avenue', 'Road', 'Drive', 'Boulevard', 'Lane', 'Court'];
const notes = ['Leave at front desk', 'Ring bell twice', 'Call on arrival', 'Side entrance', 'Fragile package', 'Mailbox OK'];

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const address = body.address;
    const latitude = Number(body.latitude);
    const longitude = Number(body.longitude);
    const cityId = body.city_id || null;

    if (!address || Number.isNaN(latitude) || Number.isNaN(longitude)) {
      return Response.json({ error: 'Address and coordinates are required' }, { status: 400 });
    }

    const demoStores = await base44.asServiceRole.entities.DemoStore.filter({ created_by: user.email });
    const demoPatients = await base44.asServiceRole.entities.DemoPatient.filter({ created_by: user.email });
    const demoRoutes = await base44.asServiceRole.entities.DemoRoute.filter({ created_by: user.email });
    const settings = await base44.asServiceRole.entities.DemoSettings.filter({ user_id: user.id });

    await Promise.all([
      ...demoRoutes.map((item) => base44.asServiceRole.entities.DemoRoute.delete(item.id)),
      ...demoPatients.map((item) => base44.asServiceRole.entities.DemoPatient.delete(item.id)),
      ...demoStores.map((item) => base44.asServiceRole.entities.DemoStore.delete(item.id))
    ]);

    const today = new Date();
    const store = await base44.asServiceRole.entities.DemoStore.create({
      name: 'Demo Pharmacy',
      abbreviation: 'DP',
      address,
      phone: '(780) 555-0100',
      latitude,
      longitude,
      city_id: cityId,
      status: 'active',
      color: '#2563eb',
      is_demo: true
    });

    const patientCount = randomInt(10, 20);
    const patients = [];

    for (let index = 0; index < patientCount; index += 1) {
      const distanceKm = randomBetween(0.25, 18);
      const angle = randomBetween(0, 360);
      const coords = offsetCoordinates(latitude, longitude, distanceKm, angle);
      const fullName = `${pick(firstNames)} ${pick(lastNames)}`;
      const streetNumber = randomInt(100, 9999);
      const streetAddress = `${streetNumber} ${pick(streetNames)} ${pick(streetTypes)}`;

      const patient = await base44.asServiceRole.entities.DemoPatient.create({
        store_id: store.id,
        full_name: fullName,
        patient_id: `DEMO-${index + 1}`,
        address: streetAddress,
        phone: `(780) 555-${String(randomInt(1000, 9999)).padStart(4, '0')}`,
        notes: pick(notes),
        latitude: coords.latitude,
        longitude: coords.longitude,
        distance_from_store: Number(distanceKm.toFixed(2)),
        status: 'active',
        mailbox_ok: Math.random() > 0.5,
        call_upon_arrival: Math.random() > 0.6,
        ring_bell: Math.random() > 0.2,
        dont_ring_bell: false,
        back_door: Math.random() > 0.8,
        time_window_start: pick(['09:00', '10:00', '11:00', '13:00']),
        time_window_end: pick(['12:00', '14:00', '16:00', '18:00']),
        is_demo: true
      });
      patients.push(patient);
    }

    const routeCount = randomInt(5, 10);
    const selectedPatients = [...patients].sort(() => Math.random() - 0.5).slice(0, routeCount);

    for (let index = 0; index < selectedPatients.length; index += 1) {
      const patient = selectedPatients[index];
      const date = formatDate(addDays(today, index % 3));
      await base44.asServiceRole.entities.DemoRoute.create({
        delivery_id: `DEMO-ROUTE-${index + 1}`,
        patient_id: patient.id,
        driver_id: user.id,
        driver_name: user.full_name || user.email,
        created_by_app_user_id: user.id,
        delivery_date: date,
        delivery_time_start: patient.time_window_start || '10:00',
        delivery_time_end: patient.time_window_end || '14:00',
        delivery_time_eta: patient.time_window_start || '10:00',
        status: pick(['pending', 'en_route', 'in_transit']),
        store_id: store.id,
        tracking_number: String((index + 1) * 10),
        stop_order: index + 1,
        stop_id: `SID-DEMO-${index + 1}`,
        delivery_notes: patient.notes || '',
        delivery_instructions: patient.notes || '',
        ampm_deliveries: (patient.time_window_start || '10:00') < '12:00' ? 'AM' : 'PM',
        extra_time: 5,
        is_demo: true
      });
    }

    if (settings.length > 0) {
      await base44.asServiceRole.entities.DemoSettings.update(settings[0].id, {
        is_demo_mode_active: true,
        demo_store_id: store.id
      });
    } else {
      await base44.asServiceRole.entities.DemoSettings.create({
        user_id: user.id,
        is_demo_mode_active: true,
        demo_store_id: store.id
      });
    }

    return Response.json({
      success: true,
      store_id: store.id,
      patient_count: patients.length,
      route_count: selectedPatients.length
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});