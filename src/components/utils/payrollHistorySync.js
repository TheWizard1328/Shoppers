// ── Payroll History Sync (owner spec, Oct 15 2026) ───────────────────────────
// Historical payroll accuracy is owned by ONE idle device: THE-DESKTOP(Editor),
// with THE-DESKTOP(PWA) as fallback when the Editor goes quiet. Other devices
// never re-gather payroll history on page load or manual refresh — they only
// sync the CURRENT pay cycle. The host verifies the year hourly (deep
// accuracy pass once a day), and when a historical cycle actually changes it
// publishes an AppSettings marker record; the WS broadcast tells every device
// to fingerprint-compare its offline payroll store and pull just the changed
// cycles. This keeps the account's API budget off the store PCs and phones.
import { useEffect, useRef } from 'react';
import { offlineDB } from '@/components/utils/offlineDatabase';
import { base44 } from '@/api/base44Client';
import { EDITOR_HOST_DEVICE_NAME, getCurrentDevice } from '@/components/utils/deviceManager';
import { isAppOwner } from '@/components/utils/userRoles';

export const PAYROLL_HISTORY_MARKER_PREFIX = 'payroll_history_marker';
const PWA_FALLBACK_HOST_DEVICE_NAME = 'THE-DESKTOP(PWA)';
const HOST_LOOP_MS = 60 * 60 * 1000; // hourly host pass
const HOST_FIRST_PASS_DELAY_MS = 10 * 60 * 1000; // stay out of the boot burst
const HOST_FALLBACK_STALE_MS = 90 * 60 * 1000; // Editor silent > 90 min → PWA hosts (> one loop + jitter)
const APPLY_DEDUPE_MS = 5 * 60 * 1000; // per-marker cooldown for consumer fetches

export const payrollHistoryMarkerKey = (year, cityId) =>
  `${PAYROLL_HISTORY_MARKER_PREFIX}_${year}_${cityId}`;

// Small deterministic hash (djb2) — markers stay well under the WS slim threshold.
const hashString = (str) => {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
  return h.toString(36);
};

const cycleKeyOf = (r) => `${r.pay_period_start}_${r.pay_period_end}`;

// Per-cycle fingerprints over the fields that identify a record's content
// revision. Any add/edit/delete in a cycle changes its fingerprint.
export const computePayrollCycleFingerprints = (payrollRecords, { year = null } = {}) => {
  const now = new Date();
  const cycles = new Map();
  (payrollRecords || []).forEach((r) => {
    if (!r?.pay_period_start || !r?.pay_period_end) return;
    if (year && parseInt(String(r.pay_period_start).slice(0, 4), 10) !== parseInt(year, 10)) return;
    // Skip the CURRENT cycle: every device syncs the current cycle itself on
    // payroll page load / refresh — the marker is for HISTORICAL cycles only.
    const s = new Date(r.pay_period_start);
    const e = new Date(r.pay_period_end);
    e.setHours(23, 59, 59, 999);
    if (now >= s && now <= e) return;
    const key = cycleKeyOf(r);
    if (!cycles.has(key)) cycles.set(key, []);
    cycles.get(key).push(r);
  });
  const out = {};
  for (const [key, recs] of cycles) {
    const fp = recs.map((r) => `${r.id}:${r.updated_date || ''}`).sort().join('|');
    out[key] = `${recs.length}-${hashString(fp)}`;
  }
  return out;
};

// Fingerprint the device's own offline payroll store for a given year.
const computeLocalCycleFingerprints = async (year) => {
  const records = await offlineDB.getAll(offlineDB.STORES.PAYROLL).catch(() => []);
  return computePayrollCycleFingerprints(records, { year });
};

// ── Marker storage (AppSettings row mirrored into the IDB app_settings store) ──
const mirrorMarkerToIdb = async (record) => {
  if (!record?.id) return;
  try { await offlineDB.save(offlineDB.STORES.APP_SETTINGS, record); } catch (_) {}
};

export const readPayrollHistoryMarkerFromIdb = async (year, cityId) => {
  try {
    const rows = await offlineDB.getByIndex(offlineDB.STORES.APP_SETTINGS, 'setting_key', payrollHistoryMarkerKey(year, cityId));
    const list = Array.isArray(rows) ? rows : (rows ? [rows] : []);
    const sorted = list.sort((a, b) => String(b.updated_date || '').localeCompare(String(a.updated_date || '')));
    return sorted[0]?.setting_value || null;
  } catch (_) { return null; }
};

const publishMarker = async (year, cityId, cycles, deviceName) => {
  const key = payrollHistoryMarkerKey(year, cityId);
  const value = {
    year: parseInt(year, 10),
    city_id: cityId,
    cycles,
    published_at: new Date().toISOString(),
    by_device: deviceName || 'unknown'
  };
  // House rules (weather-bar lesson): deterministic sort, dedupe same-key
  // rows, and NEVER create a fresh record on a read failure.
  const rows = await base44.entities.AppSettings.filter({ setting_key: key }).catch(() => null);
  if (rows === null) throw new Error('marker read failed — aborting publish');
  const sorted = (Array.isArray(rows) ? rows : [])
    .sort((a, b) => String(b.updated_date || '').localeCompare(String(a.updated_date || '')));
  const existing = sorted[0];
  let record;
  if (existing) {
    record = await base44.entities.AppSettings.update(existing.id, { setting_value: value });
    // opportunistic dupe cleanup (converges without a purge storm)
    for (const dupe of sorted.slice(1, 3)) {
      base44.entities.AppSettings.delete(dupe.id).catch(() => {});
    }
  } else {
    record = await base44.entities.AppSettings.create({
      setting_key: key,
      setting_value: value,
      description: 'Payroll history sync marker — host-published, consumed via WS broadcast'
    });
  }
  const full = record?.data?.record || record?.data || record;
  await mirrorMarkerToIdb(full);
  return value;
};

// ── Consumer: apply a marker by pulling ONLY the changed cycles into IDB ────
let lastApplyAttempt = {}; // markerKey -> ts
export const applyPayrollHistoryMarker = async (marker, { force = false } = {}) => {
  const value = marker?.setting_value || marker;
  const { year, city_id: cityId, cycles } = value || {};
  if (!year || !cityId || !cycles || typeof cycles !== 'object') return { applied: false, reason: 'invalid' };
  const markerKey = payrollHistoryMarkerKey(year, cityId);
  const now = Date.now();
  if (!force && lastApplyAttempt[markerKey] && now - lastApplyAttempt[markerKey] < APPLY_DEDUPE_MS) {
    return { applied: false, reason: 'cooldown' };
  }
  lastApplyAttempt[markerKey] = now;

  const local = await computeLocalCycleFingerprints(year);
  const changed = Object.keys(cycles).filter((k) => local[k] !== cycles[k]);
  if (changed.length === 0) return { applied: false, reason: 'unchanged' };

  // Oct 15 outage fix: full-year responses exceed the platform's function
  // response limit (500 for every caller). Paged fetch with the current month
  // still returns the YEAR-WIDE payrollRecords this path consumes — they are
  // gathered fresh from the entity on every paged call.
  const response = await base44.functions.invoke('getAdminMetricsAndPayrollData', {
    payrollYear: parseInt(year, 10),
    payrollCityId: cityId,
    payrollPaginationMode: 'paged',
    payrollPageMonths: [new Date().getMonth() + 1],
    forceRefreshCurrentYear: false
  });
  const data = response?.data?.payrollData || response?.payrollData;
  const changedSet = new Set(changed);
  const records = (data?.payrollRecords || []).filter((r) => changedSet.has(cycleKeyOf(r)));
  if (records.length > 0) {
    await offlineDB.bulkSave(offlineDB.STORES.PAYROLL, records);
  }
  console.log(`💾 [PayrollHistorySync] applied ${records.length} record(s) across ${changed.length} changed historical cycle(s) for ${year}/${cityId}`);
  return { applied: true, changed: changed.length, records: records.length };
};

// ── WS broadcast listener (armed once app-wide) ───────────────────────────────
// Owner rule Oct 15: only PAYROLL members consume markers — drivers and
// administrators. Dispatchers/store PCs are not part of payroll, so they are
// skipped entirely (no fetch, no IDB writes).
let markerListenerArmed = false;
export const isPayrollParticipant = (user) => {
  if (!user) return false;
  if (user.role === 'admin') return true; // owner (platform admin)
  const roles = Array.isArray(user?.app_roles) ? user.app_roles : [];
  return roles.includes('admin') || roles.includes('driver');
};
export const armPayrollHistoryMarkerListener = (getUser) => {
  if (markerListenerArmed || typeof window === 'undefined') return;
  markerListenerArmed = true;
  window.addEventListener('appSettingsUpdated', (event) => {
    try {
      const data = event?.detail?.data;
      const key = data?.setting_key;
      if (!key || !String(key).startsWith(PAYROLL_HISTORY_MARKER_PREFIX)) return;
      const user = typeof getUser === 'function' ? getUser() : null;
      if (!isPayrollParticipant(user)) return;
      const value = data?.setting_value;
      if (!value?.year) return;
      applyPayrollHistoryMarker(value).catch(() => {});
    } catch (_) {}
  });
};

// ── Host pass (Editor; PWA fallback) ────────────────────────────────────────
const deepPassStampKey = (year, cityId) => `rx_payroll_history_deep_${year}_${cityId}`;
const shouldRunDeepPass = (year, cityId) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const k = deepPassStampKey(year, cityId);
    if (localStorage.getItem(k) === today) return false;
    localStorage.setItem(k, today);
    return true;
  } catch (_) { return false; }
};

const runHostPass = async ({ year, cityId, deviceName, deepPass }) => {
  // ONE invoke per pass (Oct 15: paged — full-year responses blow the
  // platform's function response limit). Paged responses still carry the
  // YEAR-WIDE payrollRecords, fetched fresh from the entity, so fingerprints
  // are as accurate as the old full re-gather; deliveries for one month are
  // discarded (fingerprints never read them).
  const response = await base44.functions.invoke('getAdminMetricsAndPayrollData', {
    payrollYear: year,
    payrollCityId: cityId,
    payrollPaginationMode: 'paged',
    payrollPageMonths: [new Date().getMonth() + 1],
    forceRefreshCurrentYear: false
  });
  const data = response?.data?.payrollData || response?.payrollData;
  const cycles = computePayrollCycleFingerprints(data?.payrollRecords, { year });
  const last = await readPayrollHistoryMarkerFromIdb(year, cityId);
  const historyChanged = Object.keys(cycles).some((k) => last?.cycles?.[k] !== cycles[k]);
  // The marker doubles as the host heartbeat: republished every pass so the
  // PWA fallback knows the Editor is alive.
  if (historyChanged || !last) {
    console.log(`📡 [PayrollHistorySync] ${deepPass ? 'deep' : 'fast'} pass — historical cycles changed, publishing marker`);
  }
  await publishMarker(year, cityId, cycles, deviceName);
  // The host applies its own marker too (keeps its offline store current).
  await applyPayrollHistoryMarker({ year, city_id: cityId, cycles }, { force: true }).catch(() => {});
  return { historyChanged };
};

let hostPassInFlight = false;
const tickHost = async (currentUser) => {
  if (hostPassInFlight || !navigator.onLine) return;
  const cityId = currentUser?.city_id || (Array.isArray(currentUser?.city_ids) && currentUser.city_ids[0]);
  if (!cityId) return;
  hostPassInFlight = true;
  try {
    const year = new Date().getFullYear();
    const device = await getCurrentDevice(currentUser.id).catch(() => null);
    const name = device?.device_name;
    if (name === EDITOR_HOST_DEVICE_NAME) {
      await runHostPass({ year, cityId, deviceName: name, deepPass: shouldRunDeepPass(year, cityId) });
    } else if (name === PWA_FALLBACK_HOST_DEVICE_NAME) {
      // Fallback host only when the Editor went quiet (marker doubles as heartbeat).
      const last = await readPayrollHistoryMarkerFromIdb(year, cityId);
      const lastAt = last?.published_at ? Date.parse(last.published_at) : 0;
      if (!lastAt || Date.now() - lastAt > HOST_FALLBACK_STALE_MS) {
        console.log('📡 [PayrollHistorySync] Editor host quiet — PWA taking over history sync');
        await runHostPass({ year, cityId, deviceName: name, deepPass: shouldRunDeepPass(year, cityId) });
      }
    }
    // Any other owner device: consumer only (WS listener applies markers).
  } catch (e) {
    console.warn('⚠️ [PayrollHistorySync] host pass failed (will retry next cycle):', e?.message || e);
  } finally {
    hostPassInFlight = false;
  }
};

// ── App-wide hook — mount once in Layout ─────────────────────────────────────
export const usePayrollHistorySync = (currentUser) => {
  const userId = currentUser?.id;
  const cityId = currentUser?.city_id || (Array.isArray(currentUser?.city_ids) && currentUser.city_ids[0]);
  // Ref (top-level hook — calling useRef inside useEffect throws) so the armed
  // WS listener always reads the LATEST user even after role changes.
  const userRef = useRef(currentUser);
  userRef.current = currentUser;
  useEffect(() => {
    // Consumers are drivers/admins (NOT dispatchers — they're not in payroll).
    armPayrollHistoryMarkerListener(() => userRef.current);
    if (!userId || !cityId || !isAppOwner(currentUser)) return;
    let stopped = false;
    const first = setTimeout(() => { if (!stopped) tickHost(currentUser); }, HOST_FIRST_PASS_DELAY_MS);
    const interval = setInterval(() => { if (!stopped) tickHost(currentUser); }, HOST_LOOP_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible' && !stopped) tickHost(currentUser);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      clearTimeout(first);
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, cityId]);
};
