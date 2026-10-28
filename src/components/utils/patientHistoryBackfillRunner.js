// ─────────────────────────────────────────────────────────────────────────────
// patientHistoryBackfillRunner
//
// Owner spec (Oct 27 2026): the bulk "Backfill Patient History" re-implementation,
// client-side and rate-limit friendly:
//   1. Pull ONE store at a time, in paged batches (terminal deliveries + Return
//      runs for that store only).
//   2. Process each store's patients against the IDB patient records (IDB-first:
//      patients are kept fresh by the boot priority sync + WS pushes), compute the
//      clean per-patient history, and update the running progress UI.
//   3. Record the patient IDs whose delivery_history / last_delivery_date actually
//      changed (diff against the stored history — unchanged patients cost nothing).
//   4. Background-upload ONLY the changed patients in small throttled batches
//      WHILE the next store's patients are being worked on. IDB + local UI are
//      updated together with each successful upload batch, so a failed upload
//      never leaves IDB ahead of the server (next run re-detects and retries).
//
// History computation mirrors base44/functions/backfillPatientHistory exactly:
// terminal entries + return-run entries (status 'returned'), dedupe by delivery
// id preferring 'returned', sort date desc / time desc, collapse one entry per
// calendar day (keep the latest event), last_delivery_date = first row's date.
// Patients with no history are cleared only if they carry stale data.
//
// Deviation from the old server bulk mode (intentional): Return runs match
// patients by name WITHIN their own store only (the old global name map could
// drop a return onto a same-name patient at a different store), and no
// first_delivery delivery corrections are written (that stays available via the
// server function; this tool is patient-history-only per owner spec).
//
// Progress is published through subscribePatientHistoryBackfillRun() — the
// Admin Utilities Patients tab renders the live banner from it.
// ─────────────────────────────────────────────────────────────────────────────

import { offlineDB } from './offlineDatabase';
import { base44 } from '@/api/base44Client';

const PAGE = 500;            // deliveries per fetch page
const PATIENT_PAGE = 200;    // patients per fallback fetch page
const FETCH_DELAY_MS = 400;  // pause between fetch pages
const STORE_DELAY_MS = 800;  // pause between stores
const UPLOAD_BATCH = 5;      // patient updates per upload batch
const UPLOAD_DELAY_MS = 700; // pause between upload batches
const UPLOAD_MAX_ATTEMPTS = 3;
const RATE_LIMIT_RETRIES = 2;
const RATE_LIMIT_WAIT_MS = 15_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const isRateLimitErr = (e) => {
  const m = String(e?.message || e?.response?.data?.error || '').toLowerCase();
  return m.includes('rate limit') || m.includes('429') || e?.response?.status === 429;
};

// Retry helper for read/fetch calls: 429s wait and retry; other errors rethrow.
const withRateLimitRetry = async (fn) => {
  let lastErr = null;
  for (let attempt = 0; attempt <= RATE_LIMIT_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt < RATE_LIMIT_RETRIES && isRateLimitErr(e)) {
        await sleep(RATE_LIMIT_WAIT_MS * (attempt + 1));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
};

// ── Module state ────────────────────────────────────────────────────────────
let state = {
  status: 'idle', // idle | running | done | cancelled | error
  storeIndex: 0, storeCount: 0, currentStoreName: null,
  storesDone: 0, storesFailed: 0,
  processedPatients: 0, changedPatients: 0,
  uploaded: 0, uploadFailed: 0, uploadPending: 0,
  unmatchedNames: 0,
  message: '',
  startedAt: null, finishedAt: null,
  storeResults: [],
};
const listeners = new Set();
let cancelled = false;
let running = false;

const emit = () => {
  const snap = { ...state };
  for (const cb of listeners) { try { cb(snap); } catch { } }
};

export const getPatientHistoryBackfillState = () => ({ ...state });

export const subscribePatientHistoryBackfillRun = (cb) => {
  listeners.add(cb);
  try { cb({ ...state }); } catch { }
  return () => listeners.delete(cb);
};

export const cancelPatientHistoryBackfill = () => {
  if (state.status !== 'running') return;
  cancelled = true;
  state.message = 'Cancelling… current store/batch will finish first.';
  emit();
};

const setState = (patch) => { state = { ...state, ...patch }; emit(); };

// ── History computation (mirrors the backend function) ─────────────────────

const buildCleanHistory = (entries) => {
  // Dedupe by delivery id, preferring 'returned' when a return run is ALSO a
  // terminal delivery for the same patient.
  const byId = new Map();
  for (const e of entries) {
    const existing = byId.get(e.id);
    if (!existing || (e.status === 'returned' && existing.status !== 'returned')) byId.set(e.id, e);
  }
  const deduped = Array.from(byId.values());
  deduped.sort((a, b) => {
    const aDate = a.delivery_date || '';
    const bDate = b.delivery_date || '';
    if (aDate !== bDate) return bDate.localeCompare(aDate);
    return (b.actual_delivery_time || '').localeCompare(a.actual_delivery_time || '');
  });
  // Collapse to one entry per delivery_date: a return dated the same day as
  // the original delivery must not add a second row for that day. Sorted desc,
  // the first entry per date is the latest event that day.
  const seenDates = new Set();
  const clean = [];
  for (const e of deduped) {
    const d = e.delivery_date || null;
    if (d) { if (seenDates.has(d)) continue; seenDates.add(d); }
    clean.push({ id: e.id, delivery_date: e.delivery_date, actual_delivery_time: e.actual_delivery_time, status: e.status });
  }
  return { history: clean, lastDeliveryDate: clean.length ? clean[0].delivery_date : null, deduped };
};

const parseReturnNames = (d) => {
  if (!d.delivery_notes) return [];
  if (!d.delivery_notes.match(/For:\s*(.+)/i)) return [];
  let namesText = d.delivery_notes.substring(d.delivery_notes.indexOf('For:') + 4);
  const rtnIdx = namesText.indexOf('(RTN)');
  if (rtnIdx !== -1) namesText = namesText.substring(0, rtnIdx);
  return namesText.split(/\s+And\s+/i).flatMap((s) => s.split(','))
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.match(/^(RTN|From:)/i));
};

// ── Upload pipeline (drains while the next store is processed) ───────────────

const uploadQueue = []; // { patientId, patient, delivery_history, last_delivery_date, attempts }
let uploaderActive = false;

const runUploader = async () => {
  if (uploaderActive) return;
  uploaderActive = true;
  try {
    while (uploadQueue.length > 0 && !cancelled) {
      const batch = uploadQueue.splice(0, UPLOAD_BATCH);
      const succeeded = [];
      for (const item of batch) {
        item.attempts++;
        try {
          await base44.entities.Patient.update(item.patientId, {
            delivery_history: item.delivery_history,
            last_delivery_date: item.last_delivery_date,
          });
          succeeded.push(item);
        } catch (e) {
          if (item.attempts < UPLOAD_MAX_ATTEMPTS && isRateLimitErr(e)) {
            uploadQueue.push(item); // re-queue: rate-limit retry with the batch pacing
          } else {
            setState({ uploadFailed: state.uploadFailed + 1 });
          }
        }
      }
      if (succeeded.length > 0) {
        // IDB + local UI updated ONLY after the server write succeeds — a failed
        // upload never leaves the local copy ahead of the server.
        const rows = succeeded.map((item) => ({
          ...item.patient,
          delivery_history: item.delivery_history,
          last_delivery_date: item.last_delivery_date,
        }));
        try {
          await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, rows);
        } catch (e) {
          console.warn('[PatientHistoryBackfill] IDB save after upload failed:', e?.message || e);
        }
        window.dispatchEvent(new CustomEvent('patientHistoryBackfillApply', { detail: { patients: rows } }));
        setState({ uploaded: state.uploaded + succeeded.length });
      }
      setState({ uploadPending: uploadQueue.length });
      if (uploadQueue.length > 0) await sleep(UPLOAD_DELAY_MS);
    }
  } finally {
    uploaderActive = false;
  }
};

// ── Store processing ─────────────────────────────────────────────────────────

const fetchAllPages = async (filter, sort) => {
  const out = [];
  let skip = 0;
  for (let page = 0; page < 40; page++) {
    const batch = await withRateLimitRetry(() =>
      base44.entities.Delivery.filter(filter, sort, PAGE, skip)).catch(() => null);
    const list = batch || [];
    out.push(...list);
    if (list.length < PAGE) break;
    skip += PAGE;
    await sleep(FETCH_DELAY_MS);
  }
  return out;
};

const processStore = async (storeId, storeName) => {
  // Patients: IDB-first (boot priority sync + WS keep them fresh). Server
  // fallback only if the IDB has none for this store.
  const idbAll = await offlineDB.getAll(offlineDB.STORES.PATIENTS).catch(() => []);
  let patients = (idbAll || []).filter((p) => p && p.id && !String(p.id).startsWith('temp_') && p.store_id === storeId);
  if (patients.length === 0) {
    const out = [];
    let skip = 0;
    for (let page = 0; page < 30; page++) {
      const batch = await withRateLimitRetry(() =>
        base44.entities.Patient.filter({ store_id: storeId }, '-created_date', PATIENT_PAGE, skip)).catch(() => null);
      const list = batch || [];
      out.push(...list);
      if (list.length < PATIENT_PAGE) break;
      skip += PATIENT_PAGE;
      await sleep(FETCH_DELAY_MS);
    }
    patients = out;
    if (patients.length > 0) {
      try { await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, patients); } catch { }
    }
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

  setState({ message: `${storeName}: pulling delivery history…` });

  // Terminal deliveries for this store.
  const deliveries = await fetchAllPages({ store_id: storeId, status: { $in: ['completed', 'failed'] } }, 'created_date');
  const historyMap = new Map(); // patientId -> entries
  for (const d of deliveries) {
    if (!d.patient_id || !patientById.has(d.patient_id)) continue;
    if (!historyMap.has(d.patient_id)) historyMap.set(d.patient_id, []);
    historyMap.get(d.patient_id).push({
      id: d.id, delivery_date: d.delivery_date || null,
      actual_delivery_time: d.actual_delivery_time || null, status: d.status,
    });
  }
  await sleep(FETCH_DELAY_MS);

  // Return runs for this store, matched by name WITHIN this store.
  const returns = await fetchAllPages({ store_id: storeId, patient_name: { $regex: 'Return', $options: 'i' } }, 'created_date');
  let unmatched = 0;
  for (const d of returns) {
    const names = parseReturnNames(d);
    for (const name of names) {
      const matched = patientsByName.get(name.toLowerCase().trim());
      if (matched && matched.length > 0) {
        for (const p of matched) {
          if (!historyMap.has(p.id)) historyMap.set(p.id, []);
          historyMap.get(p.id).push({
            id: d.id, delivery_date: d.delivery_date || null,
            actual_delivery_time: d.actual_delivery_time || null, status: 'returned',
          });
        }
      } else {
        unmatched++;
      }
    }
  }

  // Compute + diff per patient.
  const changed = [];
  let skipped = 0;
  for (const p of patients) {
    const entries = historyMap.get(p.id) || [];
    const { history, lastDeliveryDate } = buildCleanHistory(entries);
    const existingHistory = Array.isArray(p.delivery_history) ? p.delivery_history : null;
    const existingLast = p.last_delivery_date ?? null;
    const historyChanged = !existingHistory ||
      existingHistory.length !== history.length ||
      JSON.stringify(existingHistory) !== JSON.stringify(history);
    if (historyChanged || existingLast !== lastDeliveryDate) {
      changed.push({ patient: p, delivery_history: history, last_delivery_date: lastDeliveryDate });
    } else {
      skipped++;
    }
  }
  // Patients with no history: clear only stale data.
  for (const p of patients) {
    if (historyMap.has(p.id)) continue;
    const hasStale = (Array.isArray(p.delivery_history) && p.delivery_history.length > 0) || p.last_delivery_date;
    if (hasStale) {
      changed.push({ patient: p, delivery_history: [], last_delivery_date: null });
    } else {
      skipped++;
    }
  }

  // Queue changed patients for the background uploader (drains while the
  // next store is processed).
  for (const c of changed) {
    uploadQueue.push({
      patientId: c.patient.id, patient: c.patient,
      delivery_history: c.delivery_history,
      last_delivery_date: c.last_delivery_date, attempts: 0,
    });
  }
  setState({
    processedPatients: state.processedPatients + patients.length,
    changedPatients: state.changedPatients + changed.length,
    unmatchedNames: state.unmatchedNames + unmatched,
    uploadPending: uploadQueue.length,
    message: `${storeName}: ${patients.length} patients, ${changed.length} changed (${skipped} already correct), queued for upload.`,
  });
  return { patients: patients.length, changed: changed.length, unmatched, skipped };
};

// ── Entry point ──────────────────────────────────────────────────────────────

export const startPatientHistoryBackfill = async (stores) => {
  if (running) return { started: false, reason: 'already-running' };
  const storeList = (stores || []).filter((s) => s?.id).map((s) => ({ id: s.id, name: s.name || s.id }));
  if (storeList.length === 0) return { started: false, reason: 'no-stores' };

  running = true;
  cancelled = false;
  uploadQueue.length = 0;
  state = {
    status: 'running', storeIndex: 0, storeCount: storeList.length, currentStoreName: null,
    storesDone: 0, storesFailed: 0, processedPatients: 0, changedPatients: 0,
    uploaded: 0, uploadFailed: 0, uploadPending: 0, unmatchedNames: 0,
    message: 'Starting…', startedAt: new Date().toISOString(), finishedAt: null,
    storeResults: [],
  };
  emit();

  const storeResults = [];
  let status = 'done';
  try {
    for (let i = 0; i < storeList.length; i++) {
      if (cancelled) { status = 'cancelled'; break; }
      const store = storeList[i];
      setState({ storeIndex: i + 1, currentStoreName: store.name, message: `${store.name}: starting…` });
      try {
        const res = await processStore(store.id, store.name);
        storeResults.push({ storeId: store.id, storeName: store.name, ...res });
        setState({ storesDone: state.storesDone + 1, storeResults: [...storeResults] });
      } catch (e) {
        console.warn('[PatientHistoryBackfill] store failed:', store.name, e?.message || e);
        storeResults.push({ storeId: store.id, storeName: store.name, error: e?.message || String(e) });
        setState({ storesFailed: state.storesFailed + 1, storeResults: [...storeResults] });
      }
      // Kick the uploader on the first queue fill; it keeps draining across stores.
      runUploader().catch(() => { });
      if (i < storeList.length - 1 && !cancelled) await sleep(STORE_DELAY_MS);
    }

    // All stores processed — drain the remaining upload queue to empty.
    setState({ message: 'Stores done — finishing uploads…' });
    while (uploadQueue.length > 0 && !cancelled) {
      const wasActive = uploaderActive;
      await runUploader(); // kick if idle; returns instantly if already draining
      if (wasActive) await sleep(UPLOAD_DELAY_MS); // someone else is draining — pace
    }

    setState({
      status,
      currentStoreName: null,
      finishedAt: new Date().toISOString(),
      message: status === 'cancelled'
        ? 'Cancelled.'
        : `Done — ${state.processedPatients} patients, ${state.changedPatients} changed, ${state.uploaded} uploaded${state.uploadFailed ? `, ${state.uploadFailed} failed` : ''}.`,
    });
  } catch (e) {
    setState({
      status: 'error', finishedAt: new Date().toISOString(),
      message: `Error: ${e?.message || e}`,
    });
  } finally {
    running = false;
  }
  return { started: true };
};
