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
const pickupNotes = ['Completed pickup', 'After-hours pickup completed', 'Store pickup finished'];
const failureNotes = ['Patient not home', 'Address issue', 'Delivery delayed'];
const returnNotes = ['Returned to store', 'Retry required', 'Customer requested return'];
const routeStatuses = ['completed', 'failed', 'returned'];
const todayStatuses = ['completed', 'failed', 'en_route', 'in_transit', 'pending'];
const randomTime = (hour, minute = 0) => `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
const buildDateTime = (date, time) => `${formatDate(date)}T${time}:00`;
const hoursToMinutes = (time) => {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
};
const minutesToTime = (minutes) => {
  const safeMinutes = Math.max(0, minutes);
  const hours = Math.floor(safeMinutes / 60);
  const mins = safeMinutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
};
const addMinutes = (time, amount) => minutesToTime(hoursToMinutes(time) + amount);

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
    const demoAppUsers = await base44.asServiceRole.entities.DemoAppUser.filter({ created_by: user.email });
    const settings = await base44.asServiceRole.entities.DemoSettings.filter({ user_id: user.id });

    await Promise.all([
      ...demoRoutes.map((item) => base44.asServiceRole.entities.DemoRoute.delete(item.id)),
      ...demoPatients.map((item) => base44.asServiceRole.entities.DemoPatient.delete(item.id)),
      ...demoStores.map((item) => base44.asServiceRole.entities.DemoStore.delete(item.id)),
      ...demoAppUsers.map((item) => base44.asServiceRole.entities.DemoAppUser.delete(item.id))
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
    const driverCount = randomInt(3, 5);
    const demoDrivers = [];

    for (let index = 0; index < driverCount; index += 1) {
      const driverCoords = offsetCoordinates(latitude, longitude, randomBetween(1, 8), randomBetween(0, 360));
      const driverName = `${pick(firstNames)} ${pick(lastNames)}`;
      const demoDriver = await base44.asServiceRole.entities.DemoAppUser.create({
        user_id: `demo-driver-${index + 1}`,
        user_name: driverName,
        app_roles: ['driver'],
        phone: `(780) 555-${String(randomInt(1000, 9999)).padStart(4, '0')}`,
        city_id: cityId,
        city_ids: cityId ? [cityId] : [],
        store_ids: [store.id],
        status: 'active',
        driver_status: 'on_duty',
        location_tracking_enabled: true,
        current_latitude: driverCoords.latitude,
        current_longitude: driverCoords.longitude,
        home_latitude: driverCoords.latitude,
        home_longitude: driverCoords.longitude,
        location_updated_at: new Date().toISOString(),
        sort_order: index + 1,
        is_demo: true
      });
      demoDrivers.push(demoDriver);
    }

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

    const routeCount = randomInt(10, 18);
    const selectedPatients = [...patients].sort(() => Math.random() - 0.5).slice(0, routeCount);
    const daysBack = 7;

    for (let dayOffset = daysBack - 1; dayOffset >= 0; dayOffset -= 1) {
      const routeDate = addDays(today, -dayOffset);
      const date = formatDate(routeDate);
      const patientsForDay = [...selectedPatients].sort(() => Math.random() - 0.5).slice(0, randomInt(4, Math.min(8, selectedPatients.length)));
      const driverBuckets = new Map();

      demoDrivers.forEach((driver) => {
        driverBuckets.set(driver.id, []);
      });

      patientsForDay.forEach((patient, index) => {
        const driver = demoDrivers[index % demoDrivers.length];
        driverBuckets.get(driver.id).push(patient);
      });

      for (const driver of demoDrivers) {
        const assignedPatients = driverBuckets.get(driver.id) || [];
        if (assignedPatients.length === 0) continue;

        const amStart = randomTime(9, 0);
        const pickupStatus = dayOffset === 0 ? (Math.random() > 0.5 ? 'completed' : 'en_route') : 'completed';
        const pickupActualTime = pickupStatus === 'completed' ? buildDateTime(routeDate, addMinutes(amStart, randomInt(5, 20))) : '';
        const pickupStopId = `SID-DEMO-${driver.user_id}-${date}-PICKUP`;
        const pickupTrackingNumber = '20';

        await base44.asServiceRole.entities.DemoRoute.create({
          delivery_id: `DEMO-PICKUP-${driver.user_id}-${date}`,
          patient_id: '',
          driver_id: driver.user_id,
          driver_name: driver.user_name,
          created_by_app_user_id: user.id,
          delivery_date: date,
          delivery_time_start: amStart,
          delivery_time_end: addMinutes(amStart, 30),
          delivery_time_eta: amStart,
          actual_delivery_time: pickupActualTime,
          status: pickupStatus,
          store_id: store.id,
          tracking_number: pickupTrackingNumber,
          stop_order: 1,
          stop_id: pickupStopId,
          delivery_notes: pick(pickupNotes),
          delivery_instructions: 'Store pickup',
          ampm_deliveries: 'AM',
          extra_time: 5,
          is_demo: true
        });

        let lastCompletedMinutes = hoursToMinutes(addMinutes(amStart, 20));

        for (let index = 0; index < assignedPatients.length; index += 1) {
          const patient = assignedPatients[index];
          const stopOrder = index + 2;
          const windowStart = patient.time_window_start || addMinutes(amStart, 30 + index * 25);
          const windowEnd = patient.time_window_end || addMinutes(windowStart, 120);
          const trackingNumber = String(20 + stopOrder).padStart(2, '0');
          const isToday = dayOffset === 0;
          const status = isToday ? pick(todayStatuses) : pick(routeStatuses);
          const actualTime = status === 'completed' || status === 'failed' || status === 'returned'
            ? buildDateTime(routeDate, minutesToTime(lastCompletedMinutes + randomInt(12, 28)))
            : '';

          if (actualTime) {
            lastCompletedMinutes = hoursToMinutes(actualTime.split('T')[1].slice(0, 5));
          }

          await base44.asServiceRole.entities.DemoRoute.create({
            delivery_id: `DEMO-ROUTE-${driver.user_id}-${date}-${index + 1}`,
            patient_id: patient.id,
            driver_id: driver.user_id,
            driver_name: driver.user_name,
            created_by_app_user_id: user.id,
            delivery_date: date,
            delivery_time_start: windowStart,
            delivery_time_end: windowEnd,
            delivery_time_eta: status === 'pending' ? windowStart : addMinutes(windowStart, randomInt(0, 20)),
            actual_delivery_time: actualTime,
            status,
            store_id: store.id,
            tracking_number: trackingNumber,
            stop_order: stopOrder,
            stop_id: `SID-DEMO-${driver.user_id}-${date}-${index + 1}`,
            delivery_notes: status === 'failed' ? pick(failureNotes) : status === 'returned' ? pick(returnNotes) : patient.notes || '',
            delivery_instructions: patient.notes || '',
            ampm_deliveries: windowStart < '12:00' ? 'AM' : 'PM',
            extra_time: 5,
            is_demo: true
          });
        }
      }
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

    const createdRoutes = await base44.asServiceRole.entities.DemoRoute.filter({ created_by: user.email });

    return Response.json({
      success: true,
      store_id: store.id,
      patient_count: patients.length,
      driver_count: demoDrivers.length,
      route_count: createdRoutes.length
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});