import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  if (user.role !== 'admin') return Response.json({ error: 'Admin only' }, { status: 403 });

  const { store_ids } = await req.json().catch(() => ({}));
  if (!Array.isArray(store_ids) || store_ids.length === 0) {
    return Response.json({ error: 'store_ids array required' }, { status: 400 });
  }

  const db = base44.asServiceRole;
  const BATCH = 500;
  const UPDATE_BATCH = 20;
  const WRITE_DELAY = 400;
  const CUTOFF_DATE = '2026-01-01';

  let totalDeliveries = 0, totalPatients = 0, totalReturns = 0;
  const errors = [];

  const storeReport = {};

  // Step 1: Fetch all patients for these stores (preserve existing delivery_history)
  const patients = [];
  for (const sid of store_ids) {
    let skip = 0;
    while (true) {
      const batch = await db.entities.Patient.filter({ store_id: sid }, '-created_date', BATCH, skip).catch(e => { errors.push(`Patient fetch ${sid}: ${e.message}`); return []; });
      if (!batch.length) break;
      patients.push(...batch);
      skip += BATCH;
      if (batch.length < BATCH) break;
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

  // Map: patientId -> { pre2026: [...], new2026: [...], firstDeliveryById: Map<deliveryId, currentFirstDelivery> }
  const historyMerge = new Map();
  for (const p of patients) {
    const existing = Array.isArray(p.delivery_history) ? p.delivery_history : [];
    const pre2026 = existing.filter(e => (e.delivery_date || '') < CUTOFF_DATE);
    historyMerge.set(p.id, { pre2026, new2026: [], firstDeliveryById: new Map() });
  }

  // Step 2: Fetch terminal deliveries (2026 only) — capture first_delivery field
  for (const sid of store_ids) {
    let skip = 0;
    while (true) {
      const batch = await db.entities.Delivery.filter(
        { store_id: sid, status: { $in: ['completed', 'failed'] } },
        'created_date', BATCH, skip
      ).catch(e => { errors.push(`Delivery fetch store ${sid}: ${e.message}`); return []; });
      if (!batch.length) break;
      totalDeliveries += batch.length;
      for (const d of batch) {
        const dDate = d.delivery_date || d.created_date || '';
        if (dDate < CUTOFF_DATE) continue;
        if (!d.patient_id || !patientById.has(d.patient_id)) continue;
        const entry = historyMerge.get(d.patient_id);
        if (entry) {
          entry.new2026.push({
            id: d.id, delivery_date: d.delivery_date || null,
            actual_delivery_time: d.actual_delivery_time || null,
            status: d.status, _created: d.created_date,
            _currentFirstDelivery: d.first_delivery
          });
          // Track current first_delivery value for no-op skip
          entry.firstDeliveryById.set(d.id, d.first_delivery);
        }
      }
      skip += BATCH;
      if (batch.length < BATCH) break;
    }
  }

  // Step 3: Fetch return deliveries (2026 only) and parse patient names
  for (const sid of store_ids) {
    let skip = 0;
    while (true) {
      const batch = await db.entities.Delivery.filter(
        { store_id: sid, patient_name: { $regex: 'Return', $options: 'i' } },
        'created_date', BATCH, skip
      ).catch(e => { errors.push(`Return fetch store ${sid}: ${e.message}`); return []; });
      if (!batch.length) break;
      for (const d of batch) {
        const dDate = d.delivery_date || d.created_date || '';
        if (dDate < CUTOFF_DATE) continue;
        totalReturns++;

        // Report: Return deliveries with "For: Unknown"
        if (d.delivery_notes && /For:\s*Unknown/i.test(d.delivery_notes)) {
          if (!storeReport[sid]) storeReport[sid] = { unknownReturns: [], missingReturns: [] };
          storeReport[sid].unknownReturns.push({
            delivery_id: d.id, delivery_date: d.delivery_date || d.created_date,
            patient_name: d.patient_name, delivery_notes: d.delivery_notes
          });
          continue;
        }

        // Report: Return deliveries with no "For:" at all
        if (!d.delivery_notes || !/For:/i.test(d.delivery_notes)) {
          if (!storeReport[sid]) storeReport[sid] = { unknownReturns: [], missingReturns: [] };
          storeReport[sid].missingReturns.push({
            delivery_id: d.id, delivery_date: d.delivery_date || d.created_date,
            patient_name: d.patient_name, delivery_notes: d.delivery_notes || ''
          });
          continue;
        }

        // Parse names from delivery_notes
        let namesText = d.delivery_notes.substring(d.delivery_notes.indexOf('For:') + 4);
        const rtnIdx = namesText.indexOf('(RTN)');
        if (rtnIdx !== -1) namesText = namesText.substring(0, rtnIdx);
        const names = namesText.split(/\s+And\s+/i).flatMap(s => s.split(',')).map(s => s.trim()).filter(s => s.length > 0 && !s.match(/^(RTN|From:)/i));
        for (const name of names) {
          const key = name.toLowerCase().trim();
          if (key === 'unknown') {
            if (!storeReport[sid]) storeReport[sid] = { unknownReturns: [], missingReturns: [] };
            storeReport[sid].unknownReturns.push({
              delivery_id: d.id, delivery_date: d.delivery_date || d.created_date,
              patient_name: d.patient_name, delivery_notes: d.delivery_notes
            });
            continue;
          }
          const matchedPatients = patientsByName.get(key);
          if (matchedPatients && matchedPatients.length > 0) {
            for (const p of matchedPatients) {
              const entry = historyMerge.get(p.id);
              if (entry) {
                entry.new2026.push({ id: d.id, delivery_date: d.delivery_date || null, actual_delivery_time: d.actual_delivery_time || null, status: 'returned', _created: d.created_date, _currentFirstDelivery: d.first_delivery });
                entry.firstDeliveryById.set(d.id, d.first_delivery);
              }
            }
          }
        }
      }
      skip += BATCH;
      if (batch.length < BATCH) break;
    }
  }

  // Step 4: Merge pre-2026 + new 2026, dedupe by delivery ID, sort, build update payloads
  const patientUpdates = [];
  const deliveryCorrections = [];
  let skippedNoOp = 0;

  for (const [patientId, merge] of historyMerge) {
    const allEntries = [...merge.pre2026, ...merge.new2026];
    const seenIds = new Set();
    const deduped = [];
    for (const e of allEntries) {
      if (seenIds.has(e.id)) continue;
      seenIds.add(e.id);
      deduped.push(e);
    }
    deduped.sort((a, b) => {
      const aDate = a.delivery_date || '';
      const bDate = b.delivery_date || '';
      if (aDate !== bDate) return bDate.localeCompare(aDate);
      return (a.actual_delivery_time || '').localeCompare(b.actual_delivery_time || '');
    });

    const cleanHistory = deduped.map(e => ({ id: e.id, delivery_date: e.delivery_date, actual_delivery_time: e.actual_delivery_time, status: e.status }));
    patientUpdates.push({ id: patientId, delivery_history: cleanHistory, last_delivery_date: cleanHistory.length > 0 ? cleanHistory[0].delivery_date : null });

    // first_delivery corrections only for 2026 entries — SKIP NO-OPS
    const new2026Sorted = merge.new2026.slice().sort((a, b) => {
      const aDate = a.delivery_date || '';
      const bDate = b.delivery_date || '';
      if (aDate !== bDate) return bDate.localeCompare(aDate);
      return (a.actual_delivery_time || '').localeCompare(b.actual_delivery_time || '');
    });
    if (new2026Sorted.length > 0) {
      // Oldest 2026 delivery = first_delivery: true, rest = false
      const corrections = [
        { id: new2026Sorted[new2026Sorted.length - 1].id, first_delivery: true },
        ...new2026Sorted.slice(0, -1).map(e => ({ id: e.id, first_delivery: false }))
      ];
      for (const c of corrections) {
        const current = merge.firstDeliveryById.get(c.id);
        if (current === c.first_delivery) {
          skippedNoOp++;
          continue; // Skip no-op (True→True or False→False)
        }
        deliveryCorrections.push(c);
      }
    }
  }

  // Step 5: Throttled patient updates
  let patientSuccess = 0, patientErrors = 0;
  for (let i = 0; i < patientUpdates.length; i += UPDATE_BATCH) {
    const chunk = patientUpdates.slice(i, i + UPDATE_BATCH);
    const results = await Promise.allSettled(chunk.map(u => db.entities.Patient.update(u.id, { delivery_history: u.delivery_history, last_delivery_date: u.last_delivery_date })));
    for (let j = 0; j < results.length; j++) {
      if (results[j].status === 'fulfilled') patientSuccess++;
      else { patientErrors++; if (errors.length < 20) errors.push(`Patient update ${chunk[j].id}: ${results[j].reason?.message}`); }
    }
    await sleep(WRITE_DELAY);
  }

  // Step 6: Throttled delivery first_delivery corrections (2026 only, no-ops skipped)
  let deliverySuccess = 0, deliveryErrors = 0;
  for (let i = 0; i < deliveryCorrections.length; i += UPDATE_BATCH) {
    const chunk = deliveryCorrections.slice(i, i + UPDATE_BATCH);
    const results = await Promise.allSettled(chunk.map(c => db.entities.Delivery.update(c.id, { first_delivery: c.first_delivery })));
    for (let j = 0; j < results.length; j++) {
      if (results[j].status === 'fulfilled') deliverySuccess++;
      else { deliveryErrors++; if (errors.length < 40) errors.push(`Delivery correction ${chunk[j].id}: ${results[j].reason?.message}`); }
    }
    await sleep(WRITE_DELAY);
  }

  // Build store-by-store report
  const storeSummary = [];
  for (const sid of store_ids) {
    const store = storeReport[sid] || { unknownReturns: [], missingReturns: [] };
    storeSummary.push({
      store_id: sid,
      unknown_count: store.unknownReturns.length,
      missing_count: store.missingReturns.length,
      needs_fixing: store.unknownReturns.length + store.missingReturns.length,
      unknown_details: store.unknownReturns,
      missing_details: store.missingReturns
    });
  }

  return Response.json({
    store_ids, total_patients: totalPatients, patients_updated: patientSuccess,
    patients_with_2026_history: [...historyMerge.values()].filter(m => m.new2026.length > 0).length,
    total_deliveries_processed: totalDeliveries, total_returns_parsed: totalReturns,
    first_delivery_corrections: deliveryCorrections.length, first_delivery_noops_skipped: skippedNoOp,
    patient_updates: { success: patientSuccess, errors: patientErrors },
    delivery_corrections: { success: deliverySuccess, errors: deliveryErrors },
    store_summary: storeSummary, errors: errors.slice(0, 20), error_count: errors.length
  });
});
