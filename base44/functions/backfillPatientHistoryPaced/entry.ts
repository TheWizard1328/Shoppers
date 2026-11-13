import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// ─────────────────────────────────────────────────────────────────────────────
// backfillPatientHistoryPaced
//
// Owner report (Nov 13 2026): repeat patients kept showing as "New". The history
// data was stale/missing, and the plain backfillPatientHistory writes in bursts
// of 10 that blow the platform's entity_update budget (210 per 60s per caller),
// so a large store never finished — 60-150 writes failed with 429 on every run.
//
// This is the same history computation, paced at ~150 writes/min so nothing is
// rate limited, and it takes a write budget so a call always returns before the
// function times out. Progress is resumable: already-correct records are skipped
// by diff, so calling it again simply continues where it stopped.
//
// Body: { store_ids?: string[], max_writes?: number }
//   store_ids  — stores to process (omit to do every store)
//   max_writes — write budget for this call (default 200)
//
// History rules (same as backfillPatientHistory):
//   terminal entries (completed/failed) + return-run entries (status 'returned'),
//   dedupe by delivery id preferring 'returned', sort date desc / time desc,
//   collapse to one entry per calendar day (latest event wins),
//   last_delivery_date = first row's date.
// first_delivery: TRUE on the patient's oldest real delivery, FALSE on the rest —
// only written where the stored value is wrong.
// ─────────────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WRITE_GAP_MS = 400; // ≈150 writes/min, under the 210/60s entity_update budget
const PAGE = 500;

const isRateLimit = (e) => {
  const m = String(e?.message || e?.response?.data?.error || '').toLowerCase();
  return m.includes('rate limit') || m.includes('429') || e?.response?.status === 429;
};

// A single write with one rate-limit retry. Returns true when the record ended up
// written (or was already correct), false when it still needs another pass.
const writeWithRetry = async (fn) => {
  try {
    await fn();
    return true;
  } catch (e) {
    if (isRateLimit(e)) {
      await sleep(1500);
      try { await fn(); return true; } catch (_) { return false; }
    }
    return false;
  }
};

const fetchAll = async (query, sort, label, errors) => {
  const out = [];
  let skip = 0;
  while (true) {
    const batch = await query(skip).catch((e) => { errors.push(`${label}: ${e?.message || e}`); return []; });
    if (!batch || !batch.length) break;
    out.push(...batch);
    skip += PAGE;
    if (batch.length < PAGE) break;
    await sleep(120);
  }
  return out;
};

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me().catch(() => null);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  if (user.role !== 'admin') return Response.json({ error: 'Admin only' }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const maxWrites = Math.max(20, Math.min(400, Number(body?.max_writes) || 200));
  const db = base44.asServiceRole;
  const errors = [];

  let storeIds = Array.isArray(body?.store_ids) ? body.store_ids.filter(Boolean) : [];
  if (!storeIds.length) {
    const stores = await fetchAll((skip) => db.entities.Store.list('-created_date', PAGE, skip), '-created_date', 'Store fetch', errors);
    storeIds = stores.map((s) => s.id).filter(Boolean);
  }

  let writes = 0;
  let patientsDone = 0;
  let patientsSkipped = 0;
  let deliveryFixes = 0;
  let moreWork = 0;
  let orphanedPatients = 0;
  const storesComplete = [];
  const storesPending = [];

  for (const storeId of storeIds) {
    let storePending = 0;

    // ── patients of this store ──────────────────────────────────────────────
    const patients = await fetchAll(
      (skip) => db.entities.Patient.filter({ store_id: storeId }, '-created_date', PAGE, skip),
      '-created_date', `Patient fetch ${storeId}`, errors,
    );
    const patientById = new Map(patients.map((p) => [p.id, p]));

    // ── terminal deliveries of this store ───────────────────────────────────
    const deliveries = await fetchAll(
      (skip) => db.entities.Delivery.filter(
        { store_id: storeId, status: { $in: ['completed', 'failed'] } },
        '-delivery_date', PAGE, skip,
      ),
      '-delivery_date', `Delivery fetch ${storeId}`, errors,
    );

    // ── group by patient ────────────────────────────────────────────────────
    const historyMap = new Map();
    for (const d of deliveries) {
      if (!d?.patient_id) continue;
      if (!historyMap.has(d.patient_id)) historyMap.set(d.patient_id, []);
      historyMap.get(d.patient_id).push(d);
    }

    for (const [patientId, entries] of historyMap) {
      // ORPHAN GUARD (Nov 13 2026): seven patients failed every run and kept
      // three stores permanently "pending". Those ids exist only on historical
      // deliveries — the Patient record itself is deleted — so the update hit a
      // missing record and returned "write failed" forever. Historical deliveries
      // of a deleted patient are not backfill work: skip without counting them as
      // pending or as errors.
      if (!patientById.has(patientId)) {
        orphanedPatients += 1;
        continue;
      }
      const byId = new Map();
      for (const d of entries) {
        if (!byId.has(d.id)) {
          byId.set(d.id, {
            id: d.id,
            delivery_date: d.delivery_date || null,
            actual_delivery_time: d.actual_delivery_time || null,
            status: d.status,
            _first: !!d.first_delivery,
          });
        }
      }
      const deduped = Array.from(byId.values()).sort((a, b) => {
        const ad = a.delivery_date || '';
        const bd = b.delivery_date || '';
        if (ad !== bd) return bd.localeCompare(ad);
        return (b.actual_delivery_time || '').localeCompare(a.actual_delivery_time || '');
      });

      // one entry per calendar day (latest event that day)
      const seenDates = new Set();
      const cleanHistory = [];
      for (const e of deduped) {
        const date = e.delivery_date || null;
        if (date && seenDates.has(date)) continue;
        if (date) seenDates.add(date);
        cleanHistory.push({
          id: e.id,
          delivery_date: e.delivery_date,
          actual_delivery_time: e.actual_delivery_time,
          status: e.status,
        });
      }
      const lastDeliveryDate = cleanHistory.length ? cleanHistory[0].delivery_date : null;

      // ── patient history diff ─────────────────────────────────────────────
      const patient = patientById.get(patientId);
      const existingHistory = Array.isArray(patient?.delivery_history) ? patient.delivery_history : null;
      const existingLast = patient?.last_delivery_date ?? null;
      const historyChanged = !existingHistory
        || existingHistory.length !== cleanHistory.length
        || JSON.stringify(existingHistory) !== JSON.stringify(cleanHistory);
      const dateChanged = (existingLast || null) !== (lastDeliveryDate || null);

      if (historyChanged || dateChanged) {
        if (writes >= maxWrites) { storePending += 1; moreWork += 1; continue; }
        const ok = await writeWithRetry(() => db.entities.Patient.update(patientId, {
          delivery_history: cleanHistory,
          last_delivery_date: lastDeliveryDate,
        }));
        writes += 1;
        await sleep(WRITE_GAP_MS);
        if (ok) patientsDone += 1; else { storePending += 1; moreWork += 1; errors.push(`Patient ${patientId}: write failed`); }
      } else {
        patientsSkipped += 1;
      }

      // ── first_delivery corrections ───────────────────────────────────────
      // oldest real delivery = first, everything else = not first
      const oldestId = deduped.length ? deduped[deduped.length - 1].id : null;
      for (const e of deduped) {
        const shouldBeFirst = e.id === oldestId;
        if (e._first === shouldBeFirst) continue;
        if (writes >= maxWrites) { storePending += 1; moreWork += 1; continue; }
        const ok = await writeWithRetry(() => db.entities.Delivery.update(e.id, { first_delivery: shouldBeFirst }));
        writes += 1;
        await sleep(WRITE_GAP_MS);
        if (ok) deliveryFixes += 1; else { storePending += 1; moreWork += 1; errors.push(`Delivery ${e.id}: write failed`); }
      }
    }

    if (storePending === 0) storesComplete.push(storeId); else storesPending.push(storeId);
    if (writes >= maxWrites) break;
  }

  return Response.json({
    _version: 'paced-v1',
    store_ids_requested: storeIds.length,
    stores_complete: storesComplete,
    stores_pending: storesPending,
    writes_used: writes,
    write_budget: maxWrites,
    patient_histories_written: patientsDone,
    patient_histories_already_correct: patientsSkipped,
    first_delivery_corrections_written: deliveryFixes,
    orphaned_patients_skipped: orphanedPatients,
    remaining_items: moreWork,
    error_count: errors.length,
    errors: errors.slice(0, 10),
  });
});
