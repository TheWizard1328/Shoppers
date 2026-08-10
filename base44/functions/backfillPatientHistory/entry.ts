import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  if (user.role !== 'admin') return Response.json({ error: 'Admin only' }, { status: 403 });

  const { store_ids } = await req.json();
  if (!Array.isArray(store_ids) || store_ids.length === 0) {
    return Response.json({ error: 'store_ids array required' }, { status: 400 });
  }

  const db = base44.asServiceRole;
  const BATCH = 500;
  let totalDeliveries = 0, totalPatients = 0, totalCorrections = 0, totalReturns = 0;
  const unmatchedNames = [];
  const errors = [];

  // ── Step 1: Fetch all patients for these stores (build name → id lookup) ──
  const patients = [];
  for (const sid of store_ids) {
    let skip = 0;
    while (true) {
      const batch = await db.entities.Patient.filter({ store_id: sid }, '-created_date', BATCH, skip).catch(e => { errors.push(`Patient fetch: ${e.message}`); return []; });
      if (!batch.length) break;
      patients.push(...batch);
      skip += BATCH;
      if (batch.length < BATCH) break;
    }
  }
  totalPatients = patients.length;

  // Build: patientId (entity .id) → patient record, and fullName → patient records (for return matching)
  const patientById = new Map();
  const patientsByName = new Map(); // lowercase trimmed name → array of patient records
  for (const p of patients) {
    patientById.set(p.id, p);
    const key = (p.full_name || '').toLowerCase().trim();
    if (key) {
      if (!patientsByName.has(key)) patientsByName.set(key, []);
      patientsByName.get(key).push(p);
    }
  }

  // ── Step 2: Fetch all terminal deliveries (completed, failed) for these stores, oldest-first ──
  const deliveryHistoryMap = new Map(); // patient_id → array of history entries

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
        if (!d.patient_id) continue;
        if (!patientById.has(d.patient_id)) continue; // skip orphans
        if (!deliveryHistoryMap.has(d.patient_id)) deliveryHistoryMap.set(d.patient_id, []);
        deliveryHistoryMap.get(d.patient_id).push({
          id: d.id,
          delivery_date: d.delivery_date || null,
          actual_delivery_time: d.actual_delivery_time || null,
          status: d.status,
          _created: d.created_date // temp sort key
        });
      }
      skip += BATCH;
      if (batch.length < BATCH) break;
    }
  }

  // ── Step 3: Fetch return deliveries and parse patient names from delivery_notes ──
  for (const sid of store_ids) {
    let skip = 0;
    while (true) {
      const batch = await db.entities.Delivery.filter(
        { store_id: sid, patient_name: { $regex: 'Return', $options: 'i' } },
        'created_date', BATCH, skip
      ).catch(e => { errors.push(`Return fetch store ${sid}: ${e.message}`); return []; });
      if (!batch.length) break;

      for (const d of batch) {
        if (!d.delivery_notes) continue;
        totalReturns++;

        // Parse patient names from delivery_notes
        // Format: "From: DATE\nFor: Name1\nAnd Name2\nAnd Name3\n(RTN)"
        // Or: "From: DATE\nFor: Name1, Name2, Name3\n(RTN)"
        const notes = d.delivery_notes;
        const forMatch = notes.match(/For:\s*(.+)/i);
        if (!forMatch) continue;

        // Extract everything after "For:" until "(RTN)" or end of text
        let namesText = notes.substring(notes.indexOf('For:') + 4);
        const rtnIdx = namesText.indexOf('(RTN)');
        if (rtnIdx !== -1) namesText = namesText.substring(0, rtnIdx);

        // Split on "And " (case-insensitive) and commas
        const names = namesText
          .split(/\s+And\s+/i)
          .flatMap(s => s.split(','))
          .map(s => s.trim())
          .filter(s => s.length > 0 && !s.match(/^(RTN|From:)/i));

        for (const name of names) {
          const key = name.toLowerCase().trim();
          const matchedPatients = patientsByName.get(key);
          if (matchedPatients && matchedPatients.length > 0) {
            for (const p of matchedPatients) {
              if (!deliveryHistoryMap.has(p.id)) deliveryHistoryMap.set(p.id, []);
              deliveryHistoryMap.get(p.id).push({
                id: d.id,
                delivery_date: d.delivery_date || null,
                actual_delivery_time: d.actual_delivery_time || null,
                status: 'returned',
                _created: d.created_date
              });
            }
          } else {
            unmatchedNames.push({ name, store_id: sid, delivery_id: d.id, delivery_date: d.delivery_date });
          }
        }
      }
      skip += BATCH;
      if (batch.length < BATCH) break;
    }
  }

  // ── Step 4: Sort each patient's history descending (newest first) and bulk update ──
  const patientUpdates = [];
  const deliveryCorrections = []; // { delivery_id, first_delivery }

  for (const [patientId, entries] of deliveryHistoryMap) {
    // Sort by delivery_date descending, then actual_delivery_time descending
    entries.sort((a, b) => {
      const aDate = a.delivery_date || '';
      const bDate = b.delivery_date || '';
      if (aDate !== bDate) return bDate.localeCompare(aDate);
      const aTime = a.actual_delivery_time || '';
      const bTime = b.actual_delivery_time || '';
      return bTime.localeCompare(aTime);
    });

    // Strip temp sort key
    const cleanHistory = entries.map(e => ({ id: e.id, delivery_date: e.delivery_date, actual_delivery_time: e.actual_delivery_time, status: e.status }));

    patientUpdates.push({
      id: patientId,
      delivery_history: cleanHistory,
      last_delivery_date: cleanHistory.length > 0 ? cleanHistory[0].delivery_date : null
    });

    // Correct first_delivery: oldest entry = true, all others = false
    if (entries.length > 0) {
      // Find the oldest delivery (last in descending-sorted array)
      const oldest = entries[entries.length - 1];
      deliveryCorrections.push({ id: oldest.id, first_delivery: true });
      for (let i = 0; i < entries.length - 1; i++) {
        deliveryCorrections.push({ id: entries[i].id, first_delivery: false });
      }
    }
  }

  // Also clear delivery_history for patients with no history
  for (const p of patients) {
    if (!deliveryHistoryMap.has(p.id)) {
      patientUpdates.push({ id: p.id, delivery_history: [], last_delivery_date: null });
    }
  }

  // Bulk update patients in batches of 100
  for (let i = 0; i < patientUpdates.length; i += 100) {
    const chunk = patientUpdates.slice(i, i + 100);
    await Promise.all(chunk.map(u =>
      db.entities.Patient.update(u.id, {
        delivery_history: u.delivery_history,
        last_delivery_date: u.last_delivery_date
      }).catch(e => { errors.push(`Patient update ${u.id}: ${e.message}`); })
    ));
  }

  totalCorrections = deliveryCorrections.length;

  // Bulk update first_delivery on delivery records in batches of 100
  for (let i = 0; i < deliveryCorrections.length; i += 100) {
    const chunk = deliveryCorrections.slice(i, i + 100);
    await Promise.all(chunk.map(c =>
      db.entities.Delivery.update(c.id, { first_delivery: c.first_delivery }).catch(e => { errors.push(`Delivery correction ${c.id}: ${e.message}`); })
    ));
  }

  return Response.json({
    store_ids,
    total_patients: totalPatients,
    patients_with_history: deliveryHistoryMap.size,
    total_deliveries_processed: totalDeliveries,
    total_returns_parsed: totalReturns,
    first_delivery_corrections: totalCorrections,
    unmatched_names: unmatchedNames,
    unmatched_count: unmatchedNames.length,
    errors: errors.slice(0, 20),
    error_count: errors.length
  });
});
