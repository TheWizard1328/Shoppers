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
const normalizeAddress = (value = '') => value.toLowerCase().replace(/\s+/g, ' ').replace(/[.,]/g, '').trim();
const getDistanceKm = (lat1, lon1, lat2, lon2) => {
  const earthRadiusKm = 6371;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Number((earthRadiusKm * c).toFixed(2));
};
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
const pharmacyPrefixes = ['Summit', 'Riverbend', 'Maple Leaf', 'Northgate', 'Cedar', 'Evergreen', 'Prairie', 'Vista', 'Harbour', 'Sunrise'];
const pharmacySuffixes = ['Pharmacy', 'Care Pharmacy', 'Drugs', 'Rx Centre', 'Health Pharmacy'];
const storeColors = ['#2563eb', '#16a34a', '#dc2626', '#7c3aed', '#ea580c'];
const routeStatuses = ['completed', 'failed', 'cancelled'];
const todayStatuses = ['completed', 'failed', 'en_route', 'in_transit', 'pending'];
const followUpStatuses = ['retry', 'return'];
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
const createFakePharmacyName = (usedNames) => {
  let name = '';
  while (!name || usedNames.has(name)) {
    name = `${pick(pharmacyPrefixes)} ${pick(pharmacySuffixes)}`;
  }
  usedNames.add(name);
  return name;
};

const generatePatientId = (existingIds = []) => {
  const characters = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const length = 5;
  const maxAttempts = 100;
  const existingSet = new Set(existingIds.map((id) => String(id).trim()));

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let newId = '';
    for (let index = 0; index < length; index += 1) {
      newId += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    if (!existingSet.has(newId)) {
      return newId;
    }
  }

  const timestamp = Date.now().toString(36).slice(-5);
  return timestamp.padStart(length, characters.charAt(0));
};

const buildRealAddress = async (base44, store, index) => {
  const response = await base44.integrations.Core.InvokeLLM({
    prompt: `Return one real residential mailing address within 25km of store at ${store.latitude}, ${store.longitude}. Include full street address, latitude, longitude, and ensure it is plausible in the local area.`,
    add_context_from_internet: true,
    response_json_schema: {
      type: 'object',
      properties: {
        address: { type: 'string' },
        latitude: { type: 'number' },
        longitude: { type: 'number' }
      },
      required: ['address', 'latitude', 'longitude']
    }
  });

  const llmAddress = response?.address || '';
  const llmLat = Number(response?.latitude);
  const llmLon = Number(response?.longitude);
  const validDistance = !Number.isNaN(llmLat) && !Number.isNaN(llmLon)
    ? getDistanceKm(store.latitude, store.longitude, llmLat, llmLon)
    : 999;

  if (llmAddress && validDistance <= 25) {
    return {
      address: llmAddress,
      latitude: llmLat,
      longitude: llmLon,
      distance_from_store: validDistance
    };
  }

  const fallbackDistance = randomBetween(0.25, 24.5);
  const fallbackCoords = offsetCoordinates(store.latitude, store.longitude, fallbackDistance, randomBetween(0, 360));
  return {
    address: `${randomInt(100, 9999)} ${pick(streetNames)} ${pick(streetTypes)}`,
    latitude: fallbackCoords.latitude,
    longitude: fallbackCoords.longitude,
    distance_from_store: Number(fallbackDistance.toFixed(2))
  };
};

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
    const shouldClearExisting = body.shouldClearExisting === true;

    if (!address || Number.isNaN(latitude) || Number.isNaN(longitude)) {
      return Response.json({ error: 'Address and coordinates are required' }, { status: 400 });
    }

    const demoStores = await base44.asServiceRole.entities.DemoStore.filter({ created_by: user.email });
    const demoPatients = await base44.asServiceRole.entities.DemoPatient.filter({ created_by: user.email });
    const demoRoutes = await base44.asServiceRole.entities.DemoRoute.filter({ created_by: user.email });
    const demoAppUsers = await base44.asServiceRole.entities.DemoAppUser.filter({ created_by: user.email });
    const settings = await base44.asServiceRole.entities.DemoSettings.filter({ user_id: user.id });
    const existingPatientIds = demoPatients.map((item) => item.patient_id).filter(Boolean);

    if (shouldClearExisting) {
      await Promise.all([
        ...demoRoutes.map((item) => base44.asServiceRole.entities.DemoRoute.delete(item.id)),
        ...demoPatients.map((item) => base44.asServiceRole.entities.DemoPatient.delete(item.id)),
        ...demoStores.map((item) => base44.asServiceRole.entities.DemoStore.delete(item.id)),
        ...demoAppUsers.map((item) => base44.asServiceRole.entities.DemoAppUser.delete(item.id))
      ]);
    }

    const existingStores = shouldClearExisting ? [] : await base44.asServiceRole.entities.DemoStore.filter({ created_by: user.email });
    const matchingStore = existingStores.find((item) => normalizeAddress(item.address) === normalizeAddress(address));

    const today = new Date();
    const storeCount = matchingStore ? 0 : randomInt(3, 5);
    const usedPharmacyNames = new Set(existingStores.map((item) => item.name));
    const stores = matchingStore ? [matchingStore] : [];
    const patients = [];
    const demoDrivers = [];
    const demoDispatchers = [];

    for (let index = 0; index < storeCount; index += 1) {
      const storeCoords = index === 0
        ? { latitude, longitude }
        : offsetCoordinates(latitude, longitude, randomBetween(1, 10), randomBetween(0, 360));
      const storeName = createFakePharmacyName(usedPharmacyNames);
      const abbreviation = storeName
        .split(' ')
        .map((part) => part[0])
        .join('')
        .slice(0, 2)
        .toUpperCase();
      const storeAddress = index === 0
        ? address
        : `${randomInt(100, 9999)} ${pick(streetNames)} ${pick(streetTypes)}`;

      const store = await base44.asServiceRole.entities.DemoStore.create({
        name: storeName,
        abbreviation,
        address: storeAddress,
        phone: `(780) 555-${String(1000 + index).padStart(4, '0')}`,
        latitude: storeCoords.latitude,
        longitude: storeCoords.longitude,
        city_id: cityId,
        status: 'active',
        color: storeColors[index % storeColors.length],
        is_demo: true
      });

      stores.push(store);
    }

    const currentUserCoords = offsetCoordinates(latitude, longitude, randomBetween(0.2, 2), randomBetween(0, 360));
    await base44.asServiceRole.entities.DemoAppUser.create({
      user_id: user.id,
      user_name: user.full_name || 'Demo Admin',
      app_roles: ['admin', 'driver'],
      phone: '(780) 555-0000',
      city_id: cityId,
      city_ids: cityId ? [cityId] : [],
      store_ids: stores.map((store) => store.id),
      status: 'active',
      driver_status: 'on_duty',
      location_tracking_enabled: true,
      current_latitude: currentUserCoords.latitude,
      current_longitude: currentUserCoords.longitude,
      home_latitude: currentUserCoords.latitude,
      home_longitude: currentUserCoords.longitude,
      location_updated_at: new Date().toISOString(),
      sort_order: 0,
      is_demo: true
    });

    for (let index = 0; index < stores.length; index += 1) {
      const store = stores[index];
      const dispatcherCoords = offsetCoordinates(store.latitude, store.longitude, randomBetween(0.2, 2), randomBetween(0, 360));
      const dispatcherName = `${pick(firstNames)} ${pick(lastNames)}`;
      const dispatcher = await base44.asServiceRole.entities.DemoAppUser.create({
        user_id: `demo-dispatcher-${index + 1}`,
        user_name: dispatcherName,
        app_roles: ['dispatcher'],
        phone: `(780) 555-${String(randomInt(1000, 9999)).padStart(4, '0')}`,
        city_id: cityId,
        city_ids: cityId ? [cityId] : [],
        store_ids: [store.id],
        status: 'active',
        driver_status: 'online',
        location_tracking_enabled: false,
        current_latitude: dispatcherCoords.latitude,
        current_longitude: dispatcherCoords.longitude,
        home_latitude: dispatcherCoords.latitude,
        home_longitude: dispatcherCoords.longitude,
        location_updated_at: new Date().toISOString(),
        sort_order: index + 1,
        is_demo: true
      });
      demoDispatchers.push(dispatcher);
    }

    const driverCount = Math.max(1, Math.ceil(stores.length / 2));
    for (let index = 0; index < driverCount; index += 1) {
      const assignedStores = stores.filter((_, storeIndex) => Math.floor(storeIndex / 2) === index);
      const baseStore = assignedStores[0] || stores[0];
      const driverCoords = offsetCoordinates(baseStore.latitude, baseStore.longitude, randomBetween(1, 8), randomBetween(0, 360));
      const driverName = `${pick(firstNames)} ${pick(lastNames)}`;
      const demoDriver = await base44.asServiceRole.entities.DemoAppUser.create({
        user_id: `demo-driver-${index + 1}`,
        user_name: driverName,
        app_roles: ['driver'],
        phone: `(780) 555-${String(randomInt(1000, 9999)).padStart(4, '0')}`,
        city_id: cityId,
        city_ids: cityId ? [cityId] : [],
        store_ids: assignedStores.map((store) => store.id),
        status: 'active',
        driver_status: 'on_duty',
        location_tracking_enabled: true,
        current_latitude: driverCoords.latitude,
        current_longitude: driverCoords.longitude,
        home_latitude: driverCoords.latitude,
        home_longitude: driverCoords.longitude,
        location_updated_at: new Date().toISOString(),
        sort_order: demoDispatchers.length + index + 1,
        is_demo: true
      });
      demoDrivers.push(demoDriver);
    }

    for (let storeIndex = 0; storeIndex < stores.length; storeIndex += 1) {
      const store = stores[storeIndex];
      const patientCount = matchingStore && store.id === matchingStore.id ? randomInt(12, 20) : 50;

      for (let index = 0; index < patientCount; index += 1) {
        const fullName = `${pick(firstNames)} ${pick(lastNames)}`;
        const realAddress = await buildRealAddress(base44, store, index);

        const patientId = generatePatientId(existingPatientIds);
        existingPatientIds.push(patientId);

        const patient = await base44.asServiceRole.entities.DemoPatient.create({
          store_id: store.id,
          dispatcher_id: demoDispatchers[storeIndex]?.user_id || '',
          full_name: fullName,
          patient_id: patientId,
          address: realAddress.address,
          phone: `(780) 555-${String(randomInt(1000, 9999)).padStart(4, '0')}`,
          notes: pick(notes),
          latitude: realAddress.latitude,
          longitude: realAddress.longitude,
          distance_from_store: realAddress.distance_from_store,
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
    }

    const daysBack = randomInt(3, 5);

    for (let dayOffset = daysBack - 1; dayOffset >= 0; dayOffset -= 1) {
      const routeDate = addDays(today, -dayOffset);
      const date = formatDate(routeDate);

      for (let storeIndex = 0; storeIndex < stores.length; storeIndex += 1) {
        const store = stores[storeIndex];
        const storePatients = patients.filter((patient) => patient.store_id === store.id);
        const patientsForDay = [...storePatients].sort(() => Math.random() - 0.5).slice(0, randomInt(5, Math.min(10, storePatients.length)));
        const availableDrivers = demoDrivers.filter((driver) => (driver.store_ids || []).includes(store.id));
        const assignedDrivers = availableDrivers.length > 0 ? availableDrivers : demoDrivers;
        const driverBuckets = new Map();

        assignedDrivers.forEach((driver) => {
          driverBuckets.set(driver.user_id, []);
        });

        patientsForDay.forEach((patient, index) => {
          const driver = assignedDrivers[index % assignedDrivers.length];
          driverBuckets.get(driver.user_id).push(patient);
        });

        for (const driver of assignedDrivers) {
          const assignedPatients = driverBuckets.get(driver.user_id) || [];
          if (assignedPatients.length === 0) continue;

          const timeSlots = [
            { label: 'AM', start: randomTime(10, 0), trackingBase: 20 },
            { label: 'PM', start: randomTime(16, 0), trackingBase: 60 }
          ];

          for (const timeSlot of timeSlots) {
            const pickupStatus = dayOffset === 0 ? (timeSlot.label === 'AM' ? 'completed' : 'en_route') : pick(['completed', 'completed', 'cancelled']);
            const pickupActualTime = pickupStatus === 'completed' ? buildDateTime(routeDate, addMinutes(timeSlot.start, randomInt(5, 20))) : '';
            const pickupStopId = `SID-DEMO-${store.id}-${driver.user_id}-${date}-${timeSlot.label}-PICKUP`;
            const pickupTrackingNumber = String(timeSlot.trackingBase);

            await base44.asServiceRole.entities.DemoRoute.create({
              delivery_id: `DEMO-PICKUP-${store.id}-${driver.user_id}-${date}-${timeSlot.label}`,
              patient_id: '',
              driver_id: driver.user_id,
              driver_name: driver.user_name,
              created_by_app_user_id: user.id,
              delivery_date: date,
              delivery_time_start: timeSlot.start,
              delivery_time_end: addMinutes(timeSlot.start, 30),
              delivery_time_eta: timeSlot.start,
              actual_delivery_time: pickupActualTime,
              status: pickupStatus,
              store_id: store.id,
              tracking_number: pickupTrackingNumber,
              stop_order: timeSlot.label === 'AM' ? 1 : assignedPatients.length + 3,
              stop_id: pickupStopId,
              delivery_notes: pick(pickupNotes),
              delivery_instructions: 'Store pickup',
              ampm_deliveries: timeSlot.label,
              extra_time: 5,
              is_demo: true
            });

            if (pickupStatus === 'cancelled') {
              continue;
            }

            let lastCompletedMinutes = hoursToMinutes(addMinutes(timeSlot.start, 20));
            const slotPatients = assignedPatients.filter((_, patientIndex) => patientIndex % 2 === (timeSlot.label === 'AM' ? 0 : 1));

            for (let index = 0; index < slotPatients.length; index += 1) {
              const patient = slotPatients[index];
              const stopOrder = index + 2 + (timeSlot.label === 'PM' ? slotPatients.length + 1 : 0);
              const windowStart = patient.time_window_start || addMinutes(timeSlot.start, 30 + index * 25);
              const windowEnd = patient.time_window_end || addMinutes(windowStart, 120);
              const trackingNumber = String(timeSlot.trackingBase + stopOrder).padStart(2, '0');
              const isToday = dayOffset === 0;
              const status = isToday ? pick(todayStatuses) : pick(routeStatuses);
              const actualTime = status === 'completed' || status === 'failed' || status === 'cancelled'
                ? buildDateTime(routeDate, minutesToTime(lastCompletedMinutes + randomInt(12, 28)))
                : '';

              if (actualTime) {
                lastCompletedMinutes = hoursToMinutes(actualTime.split('T')[1].slice(0, 5));
              }

              const createdRoute = await base44.asServiceRole.entities.DemoRoute.create({
                delivery_id: `DEMO-ROUTE-${store.id}-${driver.user_id}-${date}-${timeSlot.label}-${index + 1}`,
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
                stop_id: `SID-DEMO-${store.id}-${driver.user_id}-${date}-${timeSlot.label}-${index + 1}`,
                puid: pickupStopId,
                delivery_notes: status === 'failed' ? pick(failureNotes) : patient.notes || '',
                delivery_instructions: patient.notes || '',
                ampm_deliveries: timeSlot.label,
                extra_time: 5,
                is_demo: true
              });

              if (status === 'failed') {
                const followUp = pick(followUpStatuses);
                await base44.asServiceRole.entities.DemoRoute.create({
                  delivery_id: `${createdRoute.delivery_id}-${followUp.toUpperCase()}`,
                  patient_id: patient.id,
                  driver_id: driver.user_id,
                  driver_name: driver.user_name,
                  created_by_app_user_id: user.id,
                  delivery_date: followUp === 'retry' ? formatDate(addDays(routeDate, 1)) : date,
                  delivery_time_start: followUp === 'retry' ? addMinutes(windowStart, 60) : windowStart,
                  delivery_time_end: followUp === 'retry' ? addMinutes(windowEnd, 60) : windowEnd,
                  delivery_time_eta: followUp === 'retry' ? addMinutes(windowStart, 60) : windowStart,
                  actual_delivery_time: followUp === 'return' ? buildDateTime(routeDate, addMinutes(windowStart, 45)) : '',
                  status: followUp === 'retry' ? 'pending' : 'cancelled',
                  store_id: store.id,
                  tracking_number: `${trackingNumber}${followUp === 'retry' ? 'R' : 'T'}`,
                  stop_order: stopOrder + 100,
                  stop_id: `SID-DEMO-${store.id}-${driver.user_id}-${date}-${followUp}-${index + 1}`,
                  puid: pickupStopId,
                  delivery_notes: followUp === 'retry' ? 'Retry scheduled after failed delivery' : 'Returned to store after failed delivery',
                  delivery_instructions: patient.notes || '',
                  ampm_deliveries: timeSlot.label,
                  extra_time: 5,
                  is_demo: true
                });
              }
            }
          }
        }
      }
    }

    if (settings.length > 0) {
      await base44.asServiceRole.entities.DemoSettings.update(settings[0].id, {
        is_demo_mode_active: true,
        demo_store_id: stores[0]?.id || null
      });
    } else {
      await base44.asServiceRole.entities.DemoSettings.create({
        user_id: user.id,
        is_demo_mode_active: true,
        demo_store_id: stores[0]?.id || null
      });
    }

    const createdRoutes = await base44.asServiceRole.entities.DemoRoute.filter({ created_by: user.email });

    return Response.json({
      success: true,
      store_id: stores[0]?.id || null,
      store_count: stores.length,
      patient_count: patients.length,
      driver_count: demoDrivers.length,
      dispatcher_count: demoDispatchers.length + 1,
      route_count: createdRoutes.length
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});