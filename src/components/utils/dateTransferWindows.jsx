/**
 * dateTransferWindows
 *
 * OWNER RULE (Nov 25 2026): "when a delivery is transferred between different
 * dates, when it's assigned to the new date the patient time windows must be
 * respected and repopulated into the delivery time windows, regardless of
 * whatever times are currently set. If there is no patient time window then the
 * delivery time start is set to 5 minutes after the first stop of that driver's
 * route on that date, or 5 minutes after any assigned pickups for that patient's
 * store on that date."
 *
 * So a date move IGNORES the record's existing delivery_time_start/end:
 *   1. patient.time_window_start (and end, when set) win outright
 *   2. otherwise first stop of the driver's route that date + 5 min
 *   3. otherwise that store's assigned pickup for that date + 5 min
 *   4. when both 2 and 3 exist the LATER of the two wins, so the stop never
 *      lands before the pickup it rides with
 *   5. nothing to go on → leave the window blank (Accept All stamps now + 5)
 *
 * A move to a different DRIVER on the same date is not a date transfer and is
 * left alone (the optimizer re-times those).
 */

import { offlineDB } from './offlineDatabase';
import { addMinutesToTime } from '@/components/dashboard/DashboardHelpers';

const norm = (v) => String(v || '').trim().slice(0, 5);
const dayOf = (v) => String(v || '').slice(0, 10);
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'returned']);

/** True when this update really moves the stop onto a different calendar day. */
export function hasDateChange(existing, updates) {
  const nextDate = dayOf(updates?.delivery_date);
  if (!nextDate) return false;
  const prevDate = dayOf(existing?.delivery_date);
  if (!prevDate) return false;
  return nextDate !== prevDate;
}

const minutesOf = (t) => {
  const v = norm(t);
  if (!v) return null;
  const [h, m] = v.split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
};

/** Pick the LATER of two 'HH:MM' strings (either may be null). */
const laterOf = (a, b) => {
  const am = minutesOf(a);
  const bm = minutesOf(b);
  if (am == null) return b || null;
  if (bm == null) return a || null;
  return am >= bm ? a : b;
};

const stopStartOf = (stop) => norm(stop?.delivery_time_start || stop?.delivery_time_eta || stop?.estimated_arrival) || null;

/**
 * Resolve the window a stop should carry on its NEW date.
 * Returns a partial update object, or null when nothing could be resolved.
 */
export async function applyDateTransferWindows({ existing, updates }) {
  if (!updates) return null;
  if (!hasDateChange(existing, updates)) return null;

  const merged = { ...(existing || {}), ...updates };
  const newDate = dayOf(merged.delivery_date);
  const patientId = merged.patient_id || null;
  const driverId = String(merged.driver_id || '');
  const storeId = merged.store_id || null;
  const selfId = existing?.id || merged.id || null;

  // ── 1. The patient's own window is the instruction ──────────────────────
  let patient = null;
  if (patientId) {
    try {
      patient = await offlineDB.getById(offlineDB.STORES.PATIENTS, patientId);
    } catch (_) { patient = null; }
  }
  const patientStart = norm(patient?.time_window_start);
  if (patientStart) {
    const next = {
      delivery_time_start: patientStart,
      time_window_start: patient.time_window_start,
    };
    const patientEnd = norm(patient?.time_window_end);
    if (patientEnd) {
      next.delivery_time_end = patientEnd;
      next.time_window_end = patient.time_window_end;
    }
    return next;
  }

  // ── 2/3. No patient window: derive from the new date's route ────────────
  let all = [];
  try {
    all = (await offlineDB.getAll(offlineDB.STORES.DELIVERIES)) || [];
  } catch (_) { all = []; }

  const onDate = all.filter((d) => d && d.id !== selfId && dayOf(d.delivery_date) === newDate);

  // First real stop of that driver's route on the new date.
  const firstStop = onDate
    .filter((d) => d.patient_id && !TERMINAL.has(String(d.status || ''))
      && String(d.driver_id || '') === driverId && stopStartOf(d))
    .sort((a, b) => {
      const ao = Number(a.stop_order);
      const bo = Number(b.stop_order);
      if (Number.isFinite(ao) && Number.isFinite(bo) && ao !== bo) return ao - bo;
      return String(a.delivery_time_start || '').localeCompare(String(b.delivery_time_start || ''));
    })[0];
  const firstStopPlus5 = firstStop ? addMinutesToTime(stopStartOf(firstStop), 5) : null;

  // Assigned pickups for this patient's store on the new date (any driver —
  // the pickup may not be assigned to this driver yet).
  const pickups = onDate
    .filter((d) => !d.patient_id && storeId && String(d.store_id || '') === String(storeId)
      && !TERMINAL.has(String(d.status || '')) && stopStartOf(d));
  const pickupTimes = pickups.map((p) => addMinutesToTime(stopStartOf(p), 5)).filter(Boolean);
  const pickupPlus5 = pickupTimes.sort((a, b) => (minutesOf(a) ?? 0) - (minutesOf(b) ?? 0))[0] || null;

  const resolved = laterOf(firstStopPlus5, pickupPlus5);
  if (!resolved) return null;

  // An end that now falls before the new start is stale (it came from the old
  // date), so it is cleared instead of leaving an impossible window behind.
  const existingEnd = norm(merged.delivery_time_end);
  const keepEnd = existingEnd && (minutesOf(existingEnd) ?? -1) >= (minutesOf(resolved) ?? 0);
  return {
    delivery_time_start: resolved,
    delivery_time_end: keepEnd ? existingEnd : '',
    time_window_start: resolved,
    time_window_end: keepEnd ? existingEnd : '',
  };
}

export default applyDateTransferWindows;
