import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

const isNotFoundError = (error) => error?.status === 404 || error?.response?.status === 404 || String(error?.message || '').toLowerCase().includes('not found');

const MATCH_RADIUS_KM = 0.15;

const STREET_TYPE_MAP = {
  avenue: 'ave', ave: 'ave', street: 'st', st: 'st', road: 'rd', rd: 'rd',
  drive: 'dr', dr: 'dr', boulevard: 'blvd', blvd: 'blvd', trail: 'trl', trl: 'trl',
  crescent: 'cres', cres: 'cres', court: 'ct', ct: 'ct', lane: 'ln', ln: 'ln',
  place: 'pl', pl: 'pl', parkway: 'pkwy', pkwy: 'pkwy', highway: 'hwy', hwy: 'hwy',
  terrace: 'ter', ter: 'ter', way: 'way'
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

  const tokens = normalizeWhitespace(value).split(' ').filter(Boolean).map(normalizeStreetToken);
  if (tokens.length === 0) return '';

  if (/^\d/.test(tokens[0])) {
    const collected = [];
    for (const token of tokens) {
      collected.push(token);
      if (STREET_TYPES.has(token)) break;
    }
    return normalizeWhitespace(collected.join(' '));
  }

  const streetTypeIndexes = tokens.map((token, index) => (STREET_TYPES.has(token) ? index : -1)).filter((index) => index >= 0);
  if (streetTypeIndexes.length >= 2) return normalizeWhitespace(tokens.slice(0, streetTypeIndexes[1] + 1).join(' '));
  if (streetTypeIndexes.length === 1) return normalizeWhitespace(tokens.slice(0, streetTypeIndexes[0] + 1).join(' '));
  return normalizeWhitespace(tokens.slice(0, 4).join(' '));
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const { action, logId, patientId, storeId, latitude, longitude } = body;

    // ── PREVIEW: find matching patients without updating anything ──────────
    if (action === 'preview') {
      const { logId: previewLogId } = body;
      if (!previewLogId) return Response.json({ error: 'Missing logId' }, { status: 400 });

      const logEntry = await base44.asServiceRole.entities.PatientGPSLog.get(previewLogId).catch((e) => {
        if (isNotFoundError(e)) return null;
        throw e;
      });
      if (!logEntry) return Response.json({ error: 'Log entry not found' }, { status: 404 });

      const srcPatientId = logEntry.source_patient_id || logEntry.patient_id;
      const newLat = toNumber(logEntry.new_latitude);
      const newLon = toNumber(logEntry.new_longitude);

      const sourcePatient = await base44.asServiceRole.entities.Patient.get(srcPatientId).catch((e) => {
        if (isNotFoundError(e)) return null;
        throw e;
      });
      if (!sourcePatient) return Response.json({ matchingPatients: [] });

      const sourceStore = await base44.asServiceRole.entities.Store.get(logEntry.store_id || sourcePatient.store_id).catch((e) => {
        if (isNotFoundError(e)) return null;
        throw e;
      });

      const sourceStreetKey = extractStreetKey(sourcePatient.address);
      if (!sourceStreetKey) return Response.json({ matchingPatients: [] });

      const cityStores = sourceStore?.city_id
        ? await base44.asServiceRole.entities.Store.filter({ city_id: sourceStore.city_id }, 'name', 500)
        : (sourceStore ? [sourceStore] : []);

      const storeMap = new Map((cityStores || []).filter(Boolean).map((s) => [s.id, s]));
      if (sourceStore && !storeMap.has(sourceStore.id)) storeMap.set(sourceStore.id, sourceStore);

      const patientGroups = await Promise.all(
        Array.from(storeMap.keys()).map((cid) =>
          base44.asServiceRole.entities.Patient.filter({ store_id: cid }, '-updated_date', 1000)
        )
      );

      const allPatients = patientGroups.flat().filter(Boolean);
      const matching = [];
      const seen = new Set([srcPatientId]);

      for (const p of allPatients) {
        if (!p?.id || seen.has(p.id)) continue;
        const key = extractStreetKey(p.address);
        if (!key || key !== sourceStreetKey) continue;
        const pLat = toNumber(p.latitude);
        const pLon = toNumber(p.longitude);
        const hasCoords = pLat != null && pLon != null;
        const withinRadius = !hasCoords || (newLat != null && newLon != null && haversineKm(pLat, pLon, newLat, newLon) <= MATCH_RADIUS_KM);
        if (!withinRadius) continue;
        matching.push({ id: p.id, full_name: p.full_name, address: p.address, unit_number: p.unit_number || null, status: p.status || 'active', store_id: p.store_id });
        seen.add(p.id);
      }

      return Response.json({ matchingPatients: matching });
    }

    // ── CANCEL: just delete the log entry ──────────────────────────────────
    if (action === 'cancel') {
      if (!logId) return Response.json({ error: 'Missing logId' }, { status: 400 });
      await base44.asServiceRole.entities.PatientGPSLog.delete(logId).catch((e) => {
        if (!isNotFoundError(e)) throw e;
      });
      return Response.json({ success: true, action: 'cancelled' });
    }

    // ── ACCEPT: bulk update matching patients, then delete the log entry ───
    if (action === 'accept') {
      if (!logId) return Response.json({ error: 'Missing logId' }, { status: 400 });

      const logEntry = await base44.asServiceRole.entities.PatientGPSLog.get(logId).catch((e) => {
        if (isNotFoundError(e)) return null;
        throw e;
      });
      if (!logEntry) return Response.json({ error: 'Log entry not found' }, { status: 404 });

      const sourcePatientId = logEntry.source_patient_id || logEntry.patient_id;
      const newLatitude = toNumber(logEntry.new_latitude);
      const newLongitude = toNumber(logEntry.new_longitude);
      const logStoreId = logEntry.store_id;

      if (newLatitude == null || newLongitude == null) {
        return Response.json({ error: 'Log entry missing coordinates' }, { status: 400 });
      }

      const sourcePatient = await base44.asServiceRole.entities.Patient.get(sourcePatientId).catch((e) => {
        if (isNotFoundError(e)) return null;
        throw e;
      });
      if (!sourcePatient) return Response.json({ error: 'Source patient not found' }, { status: 404 });

      const sourceStore = await base44.asServiceRole.entities.Store.get(logStoreId || sourcePatient.store_id).catch((e) => {
        if (isNotFoundError(e)) return null;
        throw e;
      });
      if (!sourceStore) return Response.json({ error: 'Store not found' }, { status: 404 });

      const sourceStreetKey = extractStreetKey(sourcePatient.address);
      if (!sourceStreetKey) return Response.json({ error: 'Patient address could not be normalized' }, { status: 400 });

      const cityStores = sourceStore.city_id
        ? await base44.asServiceRole.entities.Store.filter({ city_id: sourceStore.city_id }, 'name', 500)
        : [sourceStore];

      const storeMap = new Map((cityStores || []).filter(Boolean).map((item) => [item.id, item]));
      if (!storeMap.has(sourceStore.id)) storeMap.set(sourceStore.id, sourceStore);

      const patientGroups = await Promise.all(
        Array.from(storeMap.keys()).map((cStoreId) =>
          base44.asServiceRole.entities.Patient.filter({ store_id: cStoreId }, '-updated_date', 1000)
        )
      );

      const allCityPatients = patientGroups.flat().filter(Boolean);

      // Find OTHER patients (not the source) with matching address and within radius
      const matchedPatients = [];
      const seenIds = new Set([sourcePatientId]); // exclude source patient

      for (const patient of allCityPatients) {
        if (!patient?.id || seenIds.has(patient.id)) continue;
        const patientStreetKey = extractStreetKey(patient.address);
        if (!patientStreetKey || patientStreetKey !== sourceStreetKey) continue;

        const patientLat = toNumber(patient.latitude);
        const patientLon = toNumber(patient.longitude);
        const hasCoords = patientLat != null && patientLon != null;
        const withinRadius = !hasCoords || haversineKm(patientLat, patientLon, newLatitude, newLongitude) <= MATCH_RADIUS_KM;
        if (!withinRadius) continue;

        matchedPatients.push(patient);
        seenIds.add(patient.id);
      }

      // Update all matched patients
      const updateResults = await Promise.all(
        matchedPatients.map(async (patient) => {
          const patientStore = storeMap.get(patient.store_id) || sourceStore;
          const storeLat = toNumber(patientStore?.latitude);
          const storeLon = toNumber(patientStore?.longitude);
          const distanceFromStore = storeLat != null && storeLon != null
            ? Number(haversineKm(storeLat, storeLon, newLatitude, newLongitude).toFixed(2))
            : null;

          const payload = { latitude: newLatitude, longitude: newLongitude };
          if (distanceFromStore != null) payload.distance_from_store = distanceFromStore;

          const updated = await base44.asServiceRole.entities.Patient.update(patient.id, payload).catch((e) => {
            if (isNotFoundError(e)) return null;
            throw e;
          });
          return updated ? { id: updated.id, full_name: updated.full_name, address: updated.address } : null;
        })
      );

      const successfulUpdates = updateResults.filter(Boolean);

      // Delete the log entry now that the admin has acted
      await base44.asServiceRole.entities.PatientGPSLog.delete(logId).catch((e) => {
        if (!isNotFoundError(e)) throw e;
      });

      return Response.json({
        success: true,
        action: 'accepted',
        updatedCount: successfulUpdates.length,
        updatedPatients: successfulUpdates,
      });
    }

    // ── LEGACY direct call (patientId + storeId + lat + lng) ───────────────
    // Kept for backwards compatibility if called from elsewhere
    const newLatitude = toNumber(latitude);
    const newLongitude = toNumber(longitude);

    if (!patientId || !storeId || newLatitude == null || newLongitude == null) {
      return Response.json({ error: 'Missing required fields: patientId, storeId, latitude, longitude' }, { status: 400 });
    }

    const sourcePatient = await base44.asServiceRole.entities.Patient.get(patientId).catch((e) => {
      if (isNotFoundError(e)) return null;
      throw e;
    });
    if (!sourcePatient) return Response.json({ error: 'Patient not found' }, { status: 404 });

    await base44.asServiceRole.entities.Patient.update(patientId, { latitude: newLatitude, longitude: newLongitude });

    return Response.json({ success: true, action: 'direct', updatedCount: 1 });

  } catch (error) {
    console.error('[updateMatchingPatientGPS] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});