import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  if (user.role !== 'admin') return Response.json({ error: 'Admin only' }, { status: 403 });

  const { store_ids, skip_delivery_corrections } = await req.json();
  if (!Array.isArray(store_ids) || store_ids.length === 0) {
    return Response.json({ error: 'store_ids array required' }, { status: 400 });
  }

  const doDeliveryCorrections = skip_delivery_corrections !== true;
  const db = base44.asServiceRole;
  const FETCH_BATCH = 500;
  const WRITE_BATCH = 10;
  const WRITE_DELAY = 500;
  let totalDeliveries = 0, totalPatients = 0, totalReturns = 0;
  let patientsSkipped = 0, deliveryCorrectionsNeeded = 0, deliveryCorrectionsSkipped = 0;
  const unmatchedNames = [];
  const errors = [];

  // Step 1: Fetch all patients
  const patients = [];
  for (const sid of store_ids) {
    let skip = 0;
    while (true) {
      const batch = await db.entities.Patient.filter({ store_id: sid }, '-created_date', FETCH_BATCH, skip)
        .catch(e => { errors.push(`Patient fetch: ${e.message}`); return []; });
      if (!batch.length) break;
      patients.push(...batch);
      skip += FETCH_BATCH;
      if (batch.length < FETCH_BATCH) break;
    }
  }
  totalPatients = patients.length;

  const patientById = new Map();
  const patientsByName = new Map();
  for (const p of patients) {
    patientById.set(p.id, p);
    const key = (p.full_name || '').toLowerCase().trim();
    if (key) {
      if (!patientsByName.has(key)) patientsByName.set(key, []);
      patientsByName.get(key).push(p);
    }
  }

  // Step 2: Fetch terminal deliveries — capture current first_delivery
  const deliveryHistoryMap = new Map();
  for (const sid of store_ids) {
    let skip = 0;
    while (true) {
      const batch = await db.entities.Delivery.filter(
        { store_id: sid, status: { $in: ['completed', 'failed'] } },
        'created_date', FETCH_BATCH, skip
      ).catch(e => { errors.push(`Delivery fetch store ${sid}: ${e.message}`); return []; });
      if (!batch.length) break;
      totalDeliveries += batch.length;
      for (const d of batch) {
        if (!d.patient_id || !patientById.has(d.patient_id)) continue;
        if (!deliveryHistoryMap.has(d.patient_id)) deliveryHistoryMap.set(d.patient_id, []);
        deliveryHistoryMap.get(d.patient_id).push({
          id: d.id, delivery_date: d.delivery_date || null,
          actual_delivery_time: d.actual_delivery_time || null,
          status: d.status, _created: d.created_date,
          _currentFirstDelivery: !!d.first_delivery
        });
      }
      skip += FETCH_BATCH;
      if (batch.length < FETCH_BATCH) break;
    }
  }

  // Step 3: Fetch returns and parse patient names
  for (const sid of store_ids) {
    let skip = 0;
    while (true) {
      const batch = await db.entities.Delivery.filter(
        { store_id: sid, patient_name: { $regex: 'Return', $options: 'i' } },
        'created_date', FETCH_BATCH, skip
      ).catch(e => { errors.push(`Return fetch store ${sid}: ${e.message}`); return []; });
      if (!batch.length) break;
      for (const d of batch) {
        if (!d.delivery_notes) continue;
        totalReturns++;
        const forMatch = d.delivery_notes.match(/For:\s*(.+)/i);
        if (!forMatch) continue;
        let namesText = d.delivery_notes.substring(d.delivery_notes.indexOf('For:') + 4);
        const rtnIdx = namesText.indexOf('(RTN)');
        if (rtnIdx !== -1) namesText = namesText.substring(0, rtnIdx);
        const names = namesText.split(/\s+And\s+/i).flatMap(s => s.split(',')).map(s => s.trim()).filter(s => s.length > 0 && !s.match(/^(RTN|From:)/i));
        for (const name of names) {
          const key = name.toLowerCase().trim();
          const matchedPatients = patientsByName.get(key);
          if (matchedPatients && matchedPatients.length > 0) {
            for (const p of matchedPatients) {
              if (!deliveryHistoryMap.has(p.id)) deliveryHistoryMap.set(p.id, []);
              deliveryHistoryMap.get(p.id).push({
                id: d.id, delivery_date: d.delivery_date || null,
                actual_delivery_time: d.actual_delivery_time || null,
                status: 'returned', _created: d.created_date,
                _currentFirstDelivery: !!d.first_delivery
              });
            }
          } else {
            unmatchedNames.push({ name, store_id: sid, delivery_id: d.id, delivery_date: d.delivery_date });
          }
        }
      }
      skip += FETCH_BATCH;
      if (batch.length < FETCH_BATCH) break;
    }
  }

  // Step 4: Sort, compute diffs
  const patientUpdates = [];
  const deliveryCorrections = [];
  for (const [patientId, entries] of deliveryHistoryMap) {
    entries.sort((a, b) => {
      const aDate = a.delivery_date || '';
      const bDate = b.delivery_date || '';
      if (aDate !== bDate) return bDate.localeCompare(aDate);
      return (b.actual_delivery_time || '').localeCompare(a.actual_delivery_time || '');
    });
    const cleanHistory = entries.map(e => ({ id: e.id, delivery_date: e.delivery_date, actual_delivery_time: e.actual_delivery_time, status: e.status }));
    const lastDeliveryDate = cleanHistory.length > 0 ? cleanHistory[0].delivery_date : null;

    // DIFF: skip patient if delivery_history already matches
    const patient = patientById.get(patientId);
    const existingHistory = Array.isArray(patient?.delivery_history) ? patient.delivery_history : null;
    const existingLastDate = patient?.last_delivery_date ?? null;
    const historyChanged = !existingHistory ||
      existingHistory.length !== cleanHistory.length ||
      JSON.stringify(existingHistory) !== JSON.stringify(cleanHistory);
    const dateChanged = existingLastDate !== lastDeliveryDate;
    if (historyChanged || dateChanged) {
      patientUpdates.push({ id: patientId, delivery_history: cleanHistory, last_delivery_date: lastDeliveryDate });
    } else {
      patientsSkipped++;
    }

    // DIFF: only correct first_delivery where it's WRONG
    const oldest = entries[entries.length - 1];
    if (oldest && !oldest._currentFirstDelivery) {
      deliveryCorrections.push({ id: oldest.id, first_delivery: true });
      deliveryCorrectionsNeeded++;
    } else {
      deliveryCorrectionsSkipped++;
    }
    for (let i = 0; i < entries.length - 1; i++) {
      if (entries[i]._currentFirstDelivery) {
        deliveryCorrections.push({ id: entries[i].id, first_delivery: false });
        deliveryCorrectionsNeeded++;
      } else {
        deliveryCorrectionsSkipped++;
      }
    }
  }
  // Patients with no history: only update if they have stale data
  for (const p of patients) {
    if (!deliveryHistoryMap.has(p.id)) {
      const hasStaleHistory = (Array.isArray(p.delivery_history) && p.delivery_history.length > 0) || p.last_delivery_date;
      if (hasStaleHistory) {
        patientUpdates.push({ id: p.id, delivery_history: [], last_delivery_date: null });
      } else {
        patientsSkipped++;
      }
    }
  }

  // Step 5: Throttled patient updates (diffs only)
  let patientSuccess = 0, patientErrors = 0;
  const failedPatientIds = [];
  for (let i = 0; i < patientUpdates.length; i += WRITE_BATCH) {
    const chunk = patientUpdates.slice(i, i + WRITE_BATCH);
    const results = await Promise.allSettled(chunk.map(u =>
      db.entities.Patient.update(u.id, { delivery_history: u.delivery_history, last_delivery_date: u.last_delivery_date })
    ));
    for (let j = 0; j < results.length; j++) {
      if (results[j].status === 'fulfilled') patientSuccess++;
      else { patientErrors++; failedPatientIds.push(chunk[j].id); if (errors.length < 30) errors.push(`Patient update ${chunk[j].id}: ${results[j].reason?.message}`); }
    }
    await sleep(WRITE_DELAY);
  }

  // Step 6: Throttled delivery corrections (diffs only)
  let deliverySuccess = 0, deliveryErrors = 0;
  if (doDeliveryCorrections && deliveryCorrections.length > 0) {
    for (let i = 0; i < deliveryCorrections.length; i += WRITE_BATCH) {
      const chunk = deliveryCorrections.slice(i, i + WRITE_BATCH);
      const results = await Promise.allSettled(chunk.map(c =>
        db.entities.Delivery.update(c.id, { first_delivery: c.first_delivery })
      ));
      for (let j = 0; j < results.length; j++) {
        if (results[j].status === 'fulfilled') deliverySuccess++;
        else { deliveryErrors++; if (errors.length < 50) errors.push(`Delivery correction ${chunk[j].id}: ${results[j].reason?.message}`); }
      }
      await sleep(WRITE_DELAY);
    }
  }

  return Response.json({
    _version: 'diff-v3-git',
    store_ids, total_patients: totalPatients, patients_with_history: deliveryHistoryMap.size,
    total_deliveries_processed: totalDeliveries, total_returns_parsed: totalReturns,
    patient_updates: { needed: patientUpdates.length, success: patientSuccess, errors: patientErrors, skipped_already_correct: patientsSkipped, failed_ids: failedPatientIds.slice(0, 50) },
    delivery_corrections: { needed: deliveryCorrectionsNeeded, skipped_already_correct: deliveryCorrectionsSkipped, success: deliverySuccess, errors: deliveryErrors, skipped: !doDeliveryCorrections },
    unmatched_names: unmatchedNames, unmatched_count: unmatchedNames.length,
    errors: errors.slice(0, 20), error_count: errors.length
  });
});
