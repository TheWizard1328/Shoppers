import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

const MATCH_RADIUS_KM = 0.15;

const STREET_TYPE_MAP = {
  avenue: 'ave',
  ave: 'ave',
  street: 'st',
  st: 'st',
  road: 'rd',
  rd: 'rd',
  drive: 'dr',
  dr: 'dr',
  boulevard: 'blvd',
  blvd: 'blvd',
  trail: 'trl',
  trl: 'trl',
  crescent: 'cres',
  cres: 'cres',
  court: 'ct',
  ct: 'ct',
  lane: 'ln',
  ln: 'ln',
  place: 'pl',
  pl: 'pl',
  parkway: 'pkwy',
  pkwy: 'pkwy',
  highway: 'hwy',
  hwy: 'hwy',
  terrace: 'ter',
  ter: 'ter',
  way: 'way'
};

const STREET_TYPES = new Set(Object.values(STREET_TYPE_MAP));

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (value) => (value * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeStreetToken(token) {
  return STREET_TYPE_MAP[token] || token;
}

function extractStreetKey(address) {
  let value = String(address || '').toLowerCase();
  value = value.split(',')[0] || value;
  value = value
    .replace(/\(.*?\)/g, ' ')
    .replace(/\b(?:buzz|buzzer|buz)\s*[:.-]?\s*[a-z0-9-]+\b/g, ' ')
    .replace(/\b(?:apt|apartment|suite|ste|unit|room|rm|floor|fl)\s*[:.-]?\s*[a-z0-9-]+\b/g, ' ')
    .replace(/#\s*[a-z0-9-]+\b/g, ' ')
    .replace(/[.,]/g, ' ')
    .replace(/\b(?:north|south|east|west|n|s|e|w|ne|nw|se|sw)\b/g, ' ');

  const tokens = normalizeWhitespace(value)
    .split(' ')
    .filter(Boolean)
    .map(normalizeStreetToken);

  if (tokens.length === 0) return '';

  if (/^\d/.test(tokens[0])) {
    const collected = [];
    for (const token of tokens) {
      collected.push(token);
      if (STREET_TYPES.has(token)) break;
    }
    return normalizeWhitespace(collected.join(' '));
  }

  const streetTypeIndexes = tokens
    .map((token, index) => (STREET_TYPES.has(token) ? index : -1))
    .filter((index) => index >= 0);

  if (streetTypeIndexes.length >= 2) {
    return normalizeWhitespace(tokens.slice(0, streetTypeIndexes[1] + 1).join(' '));
  }

  if (streetTypeIndexes.length === 1) {
    return normalizeWhitespace(tokens.slice(0, streetTypeIndexes[0] + 1).join(' '));
  }

  return normalizeWhitespace(tokens.slice(0, 4).join(' '));
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { patientId, storeId, latitude, longitude } = await req.json();

    const newLatitude = toNumber(latitude);
    const newLongitude = toNumber(longitude);

    if (!patientId || !storeId || newLatitude == null || newLongitude == null) {
      return Response.json({ error: 'Missing required fields: patientId, storeId, latitude, longitude' }, { status: 400 });
    }

    const sourcePatient = await base44.asServiceRole.entities.Patient.get(patientId);
    if (!sourcePatient) {
      return Response.json({ error: 'Patient not found' }, { status: 404 });
    }

    const sourceStore = await base44.asServiceRole.entities.Store.get(sourcePatient.store_id || storeId);
    if (!sourceStore) {
      return Response.json({ error: 'Store not found' }, { status: 404 });
    }

    const sourceStreetKey = extractStreetKey(sourcePatient.address);
    if (!sourceStreetKey) {
      return Response.json({ error: 'Patient address could not be normalized' }, { status: 400 });
    }

    const cityStores = sourceStore.city_id
      ? await base44.asServiceRole.entities.Store.filter({ city_id: sourceStore.city_id }, 'name', 500)
      : [sourceStore];

    const storeMap = new Map((cityStores || []).filter(Boolean).map((item) => [item.id, item]));
    if (!storeMap.has(sourceStore.id)) {
      storeMap.set(sourceStore.id, sourceStore);
    }

    const patientGroups = await Promise.all(
      Array.from(storeMap.keys()).map((cityStoreId) =>
        base44.asServiceRole.entities.Patient.filter({ store_id: cityStoreId }, '-updated_date', 1000)
      )
    );

    const allCityPatients = patientGroups.flat().filter(Boolean);

    const matchedPatients = [];
    const seenIds = new Set();

    for (const patient of allCityPatients) {
      if (!patient?.id || seenIds.has(patient.id)) continue;

      const isSourcePatient = patient.id === sourcePatient.id;
      const patientStreetKey = extractStreetKey(patient.address);
      const addressMatches = patientStreetKey && patientStreetKey === sourceStreetKey;

      if (!isSourcePatient && !addressMatches) continue;

      const patientLatitude = toNumber(patient.latitude);
      const patientLongitude = toNumber(patient.longitude);
      const hasExistingCoords = patientLatitude != null && patientLongitude != null;
      const withinRadius = !hasExistingCoords || haversineKm(patientLatitude, patientLongitude, newLatitude, newLongitude) <= MATCH_RADIUS_KM;

      if (!isSourcePatient && !withinRadius) continue;

      matchedPatients.push(patient);
      seenIds.add(patient.id);
    }

    if (!seenIds.has(sourcePatient.id)) {
      matchedPatients.push(sourcePatient);
      seenIds.add(sourcePatient.id);
    }

    const relatedPatientsUpdatedCount = Math.max(0, matchedPatients.length - 1);

    const updateResults = await Promise.all(
      matchedPatients.map(async (patient) => {
        const patientStore = storeMap.get(patient.store_id) || sourceStore;
        const storeLatitude = toNumber(patientStore?.latitude);
        const storeLongitude = toNumber(patientStore?.longitude);
        const distanceFromStore = storeLatitude != null && storeLongitude != null
          ? Number(haversineKm(storeLatitude, storeLongitude, newLatitude, newLongitude).toFixed(2))
          : null;

        const payload = {
          latitude: newLatitude,
          longitude: newLongitude
        };

        if (distanceFromStore != null) {
          payload.distance_from_store = distanceFromStore;
        }

        const updatedPatient = await base44.asServiceRole.entities.Patient.update(patient.id, payload);
        return {
          id: updatedPatient.id,
          full_name: updatedPatient.full_name,
          address: updatedPatient.address,
          distance_from_store: updatedPatient.distance_from_store,
          store_id: updatedPatient.store_id,
          old_latitude: toNumber(patient.latitude),
          old_longitude: toNumber(patient.longitude)
        };
      })
    );

    await base44.asServiceRole.entities.PatientGPSLog.bulkCreate(
      updateResults.map((patient) => ({
        source_patient_id: sourcePatient.id,
        patient_id: patient.id,
        patient_name: patient.full_name || '',
        patient_address: patient.address || '',
        store_id: patient.store_id || null,
        city_id: sourceStore.city_id || null,
        is_source_patient: patient.id === sourcePatient.id,
        old_latitude: patient.old_latitude,
        old_longitude: patient.old_longitude,
        new_latitude: newLatitude,
        new_longitude: newLongitude,
        updated_by_user_id: user.id,
        updated_by_user_name: user.full_name || user.email || 'Unknown User',
        normalized_address: sourceStreetKey,
        related_patients_updated_count: relatedPatientsUpdatedCount,
        matched_patient_ids: updateResults.map((item) => item.id)
      }))
    );

    return Response.json({
      success: true,
      normalizedAddress: sourceStreetKey,
      cityId: sourceStore.city_id || null,
      updatedCount: updateResults.length,
      relatedPatientsUpdatedCount,
      updatedPatients: updateResults.map(({ old_latitude, old_longitude, ...patient }) => patient),
      sourcePatientId: sourcePatient.id
    });
  } catch (error) {
    console.error('[updateMatchingPatientGPS] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});