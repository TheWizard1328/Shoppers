import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Compare two delivery_history arrays for equality (same IDs, same order, same status/date)
function historyChanged(existing, incoming) {
  if (!Array.isArray(existing)) return incoming.length > 0;
  if (existing.length !== incoming.length) return true;
  for (let i = 0; i < incoming.length; i++) {
    const e = existing[i], n = incoming[i];
    if (e.id !== n.id) return true;
    if ((e.delivery_date || null) !== (n.delivery_date || null)) return true;
    if ((e.status || null) !== (n.status || null)) return true;
  }
  return false;
}

// Check if a delivery is a Return delivery (patient_name contains "Return" case-insensitive)
function isReturnDelivery(d) {
  return d.patient_name && /Return/i.test(d.patient_name);
}

// Parse patient names from "For:" section of delivery_notes
function parseReturnNames(deliveryNotes) {
  if (!deliveryNotes || !/For:/i.test(deliveryNotes)) return { hasFor: false, names: [] };
  let namesText = deliveryNotes.substring(deliveryNotes.indexOf('For:') + 4);
  const rtnIdx = namesText.indexOf('(RTN)');
  if (rtnIdx !== -1) namesText = namesText.substring(0, rtnIdx);
  const names = namesText.split(/\s+And\s+/i).flatMap(s => s.split(',')).map(s => s.trim()).filter(s => s.length > 0 && !s.match(/^(RTN|From:)/i));
  return { hasFor: true, names };
}

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
  const PATIENT_BATCH = 10;
  const DELIVERY_BATCH = 10;
  const WRITE_DELAY = 500;
  const CUTOFF_DATE = '2026-01-01';

  let totalReturns = 0;
  const errors = [];

  // Per-store tracking
  const storeData = {};
  for (const sid of store_ids) {
    storeData[sid] = {
      patient_count: 0,
      patient_updates_needed: 0,
      patient_updates_done: 0,
      patient_noops: 0,
      deliveries_processed: 0,
      returns_parsed: 0,
      unknownReturns: [],
      missingReturns: [],
    };
  }

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
  for (const sid of store_ids) {
    storeData[sid].patient_count = patients.filter(p => p.store_id === sid).length;
  }

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

  // Map: patientId -> { pre2026, new2026, existingHistory, firstDeliveryById }
  const historyMerge = new Map();
  for (const p of patients) {
    const existing = Array.isArray(p.delivery_history) ? p.delivery_history : [];
    const pre2026 = existing.filter(e => (e.delivery_date || '') < CUTOFF_DATE);
    historyMerge.set(p.id, { pre2026, new2026: [], existingHistory: existing, firstDeliveryById: new Map(), store_id: p.store_id });
  }

  // Step 2: Fetch ALL terminal deliveries (completed + failed) per store
  // Detect Return deliveries CLIENT-SIDE (no $regex filter) in the same pass
  for (const sid of store_ids) {
    let skip = 0;
    while (true) {
      const batch = await db.entities.Delivery.filter(
        { store_id: sid, status: { $in: ['completed', 'failed'] } },
        'created_date', BATCH, skip
      ).catch(e => { errors.push(`Delivery fetch store ${sid}: ${e.message}`); return []; });
      if (!batch.length) break;

      for (const d of batch) {
        const dDate = d.delivery_date || d.created_date || '';
        if (dDate < CUTOFF_DATE) continue; // 2026 only
        storeData[sid].deliveries_processed++;

        // ── RETURN DELIVERY DETECTION (client-side, no $regex) ──
        if (isReturnDelivery(d)) {
          storeData[sid].returns_parsed++;
          totalReturns++;

          // Check for "For: Unknown" in delivery_notes
          if (d.delivery_notes && /For:\s*Unknown/i.test(d.delivery_notes)) {
            storeData[sid].unknownReturns.push({
              delivery_id: d.id,
              delivery_date: d.delivery_date || d.created_date,
              patient_name: d.patient_name,
              delivery_notes: d.delivery_notes
            });
            continue; // Skip parsing, it's unknown
          }

          // Check for no "For:" at all, or null/empty delivery_notes
          if (!d.delivery_notes || !/For:/i.test(d.delivery_notes)) {
            storeData[sid].missingReturns.push({
              delivery_id: d.id,
              delivery_date: d.delivery_date || d.created_date,
              patient_name: d.patient_name,
              delivery_notes: d.delivery_notes || '(empty)'
            });
            continue; // Skip parsing, no patient names
          }

          // Parse patient names from "For:" section and match to patients
          const { names } = parseReturnNames(d.delivery_notes);
          for (const name of names) {
            const key = name.toLowerCase().trim();
            if (key === 'unknown') {
              storeData[sid].unknownReturns.push({
                delivery_id: d.id,
                delivery_date: d.delivery_date || d.created_date,
                patient_name: d.patient_name,
                delivery_notes: d.delivery_notes
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
          continue; // Return delivery fully processed, skip regular processing
        }

        // ── REGULAR DELIVERY (not a Return) ──
        if (!d.patient_id || !patientById.has(d.patient_id)) continue;
        const entry = historyMerge.get(d.patient_id);
        if (entry) {
          entry.new2026.push({
            id: d.id, delivery_date: d.delivery_date || null,
            actual_delivery_time: d.actual_delivery_time || null,
            status: d.status, _created: d.created_date,
            _currentFirstDelivery: d.first_delivery
          });
          entry.firstDeliveryById.set(d.id, d.first_delivery);
        }
      }

      skip += BATCH;
      if (batch.length < BATCH) break;
    }
  }

  // Step 3: Merge pre-2026 + new 2026, dedupe by delivery ID, sort, build update payloads
  const patientUpdates = [];
  const deliveryCorrections = [];
  let skippedNoOpDelivery = 0;
  let skippedNoOpPatient = 0;

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

    // Skip patient update if delivery_history hasn't changed
    if (!historyChanged(merge.existingHistory, cleanHistory)) {
      skippedNoOpPatient++;
      if (storeData[merge.store_id]) storeData[merge.store_id].patient_noops++;
    } else {
      patientUpdates.push({ id: patientId, store_id: merge.store_id, delivery_history: cleanHistory, last_delivery_date: cleanHistory.length > 0 ? cleanHistory[0].delivery_date : null });
      if (storeData[merge.store_id]) storeData[merge.store_id].patient_updates_needed++;
    }

    // first_delivery corrections only for 2026 entries — SKIP NO-OPS
    const new2026Sorted = merge.new2026.slice().sort((a, b) => {
      const aDate = a.delivery_date || '';
      const bDate = b.delivery_date || '';
      if (aDate !== bDate) return bDate.localeCompare(aDate);
      return (a.actual_delivery_time || '').localeCompare(b.actual_delivery_time || '');
    });
    if (new2026Sorted.length > 0) {
      const corrections = [
        { id: new2026Sorted[new2026Sorted.length - 1].id, first_delivery: true },
        ...new2026Sorted.slice(0, -1).map(e => ({ id: e.id, first_delivery: false }))
      ];
      for (const c of corrections) {
        const current = merge.firstDeliveryById.get(c.id);
        if (current === c.first_delivery) {
          skippedNoOpDelivery++;
          continue;
        }
        deliveryCorrections.push(c);
      }
    }
  }

  // Step 4: Throttled patient updates
  let patientSuccess = 0, patientErrors = 0;
  for (let i = 0; i < patientUpdates.length; i += PATIENT_BATCH) {
    const chunk = patientUpdates.slice(i, i + PATIENT_BATCH);
    const results = await Promise.allSettled(chunk.map(u => db.entities.Patient.update(u.id, { delivery_history: u.delivery_history, last_delivery_date: u.last_delivery_date })));
    for (let j = 0; j < results.length; j++) {
      if (results[j].status === 'fulfilled') {
        patientSuccess++;
        if (storeData[chunk[j].store_id]) storeData[chunk[j].store_id].patient_updates_done++;
      }
      else { patientErrors++; if (errors.length < 20) errors.push(`Patient update ${chunk[j].id}: ${results[j].reason?.message}`); }
    }
    await sleep(WRITE_DELAY);
  }

  // Step 5: Throttled delivery first_delivery corrections
  let deliverySuccess = 0, deliveryErrors = 0;
  for (let i = 0; i < deliveryCorrections.length; i += DELIVERY_BATCH) {
    const chunk = deliveryCorrections.slice(i, i + DELIVERY_BATCH);
    const results = await Promise.allSettled(chunk.map(c => db.entities.Delivery.update(c.id, { first_delivery: c.first_delivery })));
    for (let j = 0; j < results.length; j++) {
      if (results[j].status === 'fulfilled') deliverySuccess++;
      else { deliveryErrors++; if (errors.length < 40) errors.push(`Delivery correction ${chunk[j].id}: ${results[j].reason?.message}`); }
    }
    await sleep(WRITE_DELAY);
  }

  // Build store-by-store report with full per-store breakdown
  const storeSummary = [];
  for (const sid of store_ids) {
    const sd = storeData[sid];
    storeSummary.push({
      store_id: sid,
      patient_count: sd.patient_count,
      patients_updated: sd.patient_updates_done,
      patient_updates_needed: sd.patient_updates_needed,
      patient_noops: sd.patient_noops,
      deliveries_processed: sd.deliveries_processed,
      returns_parsed: sd.returns_parsed,
      unknown_count: sd.unknownReturns.length,
      missing_count: sd.missingReturns.length,
      needs_fixing: sd.unknownReturns.length + sd.missingReturns.length,
      unknown_details: sd.unknownReturns,
      missing_details: sd.missingReturns,
    });
  }

  return Response.json({
    store_ids,
    total_patients: patients.length,
    patients_updated: patientSuccess,
    patient_noops_skipped: skippedNoOpPatient,
    total_deliveries_processed: Object.values(storeData).reduce((a, s) => a + s.deliveries_processed, 0),
    total_returns_parsed: totalReturns,
    first_delivery_corrections: deliveryCorrections.length,
    first_delivery_noops_skipped: skippedNoOpDelivery,
    patient_updates: { success: patientSuccess, errors: patientErrors },
    delivery_corrections: { success: deliverySuccess, errors: deliveryErrors },
    store_summary: storeSummary,
    errors: errors.slice(0, 20),
    error_count: errors.length,
  });
});
