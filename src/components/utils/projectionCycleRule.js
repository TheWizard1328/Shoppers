/**
 * PROJECTION CYCLE VISIBILITY (owner rule Nov 3 2026)
 *
 * A projection that is more than 2 days PAST DUE used to sit in the projections
 * list every single day until somebody delivered it — Anne Kit Seto (Hamptons,
 * Weekly x4, missed by just over a week) never left the list, which buries the
 * stops that are actually due today.
 *
 * Owner rule: once a projection is more than 2 days overdue it drops out of the
 * projections and comes back ONLY inside its cycle window — the cycle WEEKDAY
 * plus the 2 days after it (e.g. Thursday, Friday, Saturday) — then hides for
 * the rest of the week and repeats weekly, unchanged, until it is delivered.
 *
 *   Anne, cycle weekday Thursday, today Tuesday Nov 3   -> hidden
 *   Thu Nov 5 / Fri Nov 6 / Sat Nov 7                   -> shown
 *   Sun Nov 8 .. Wed Nov 11                             -> hidden
 *   Thu Nov 12 / Fri Nov 13 / Sat Nov 14                -> shown again
 *
 * The cycle weekday is the patient's own weekly day flag (that is the day the
 * dispatcher runs that store), falling back to the weekday of the due date when
 * the patient carries no day flag (pure interval patterns).
 *
 * Pure functions, no imports — safe in every build and unit-testable in node.
 */

export const OVERDUE_GRACE_DAYS = 2;   // "more than 2 days over due"
export const CYCLE_WINDOW_DAYS = 3;    // cycle weekday + the 2 days after it

/** Days a pattern waits between deliveries. Key = the projection frequency label. */
export const CYCLE_INTERVAL_DAYS = Object.freeze({
  Daily: 1,
  Weekly: 7,
  'Bi-Weekly': 14,
  'x4 Weeks': 28,
  Monthly: 30,
  'Bi-Monthly': 60,
});

// ── MISSED ROTATIONS (owner rule Nov 6 2026) ────────────────────────────────
// "If a patient has not had a delivery on their projected date for at least 2
// rotations, then we will either remove the recurrence from the patient or we
// will ignore the recurrence in the projection list."
//
// Implemented as a SOFT ignore: the patient is pulled out of the normal
// projections list and listed in a collapsed "No delivery in 2 rotations"
// section, where the dispatcher can Restore them (back in the list) or Retire
// them (the actual recurrence removal, admin only, confirmed). Nothing is
// deleted automatically — a holiday, a hospital stay or a store move must not
// silently wipe a schedule.
export const MISSED_ROTATION_LIMIT = 2;  // rotations with no delivery before hiding
export const ROTATION_GRACE_DAYS = 2;    // "on their projected date" ± this window

/**
 * How many projected dates have passed with no delivery at all.
 * daysSinceLast 16, weekly (7), grace 2 -> the dates at day 7 and day 14 are
 * both more than 2 days gone, so 2 rotations were missed.
 *
 * @returns {number} whole missed rotations, never negative
 */
export function missedRotations({ daysSinceLast, frequency }) {
  const interval = CYCLE_INTERVAL_DAYS[frequency];
  const elapsed = Number(daysSinceLast);
  if (!interval || !Number.isFinite(elapsed)) return 0;
  const missed = Math.floor((elapsed - ROTATION_GRACE_DAYS) / interval);
  return missed > 0 ? missed : 0;
}

/** True when the patient has missed at least MISSED_ROTATION_LIMIT rotations. */
export function isSuppressedByMissedRotations({ daysSinceLast, frequency }) {
  return missedRotations({ daysSinceLast, frequency }) >= MISSED_ROTATION_LIMIT;
}

export const RESTORED_PROJECTION_IDS_KEY = 'rxdeliver_projection_restored_ids';
export const RETIRED_PROJECTION_IDS_KEY = 'rxdeliver_projection_retired_ids';

/** Patient ids the dispatcher explicitly put back into the projections list. */
export function readRestoredProjectionIds() {
  try {
    const raw = localStorage.getItem(RESTORED_PROJECTION_IDS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr.filter(Boolean) : []);
  } catch { return new Set(); }
}

export function restoreProjectionPatient(patientId) {
  if (!patientId) return;
  try {
    const ids = readRestoredProjectionIds();
    ids.add(String(patientId));
    localStorage.setItem(RESTORED_PROJECTION_IDS_KEY, JSON.stringify([...ids]));
  } catch { /* ignore */ }
}

export function readRetiredProjectionIds() {
  try {
    const raw = localStorage.getItem(RETIRED_PROJECTION_IDS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr.filter(Boolean) : []);
  } catch { return new Set(); }
}

export function retireProjectionPatient(patientId) {
  if (!patientId) return;
  try {
    const ids = readRetiredProjectionIds();
    ids.add(String(patientId));
    localStorage.setItem(RETIRED_PROJECTION_IDS_KEY, JSON.stringify([...ids]));
  } catch { /* ignore */ }
}

const WEEK_FLAG_ORDER = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * The weekday a patient's cycle is anchored to.
 * Their weekly day flag wins (that is the store's run day); otherwise the due
 * date's own weekday.
 *
 * @returns {number|null} 0=Sunday … 6=Saturday, or null when nothing decides it
 */
export function resolveCycleDow(patient, lastDate = null, frequency = null) {
  if (patient) {
    for (let i = 0; i < WEEK_FLAG_ORDER.length; i += 1) {
      if (patient[`recurring_weekly_${WEEK_FLAG_ORDER[i]}`]) return i;
    }
  }
  if (!(lastDate instanceof Date) || Number.isNaN(lastDate.getTime())) return null;
  // No day flag: the cycle day is the weekday the NEXT delivery fell due on.
  const interval = CYCLE_INTERVAL_DAYS[frequency] || 0;
  const due = new Date(lastDate.getTime() + interval * 86400000);
  return due.getDay();
}

/** True when todayDow falls on the cycle weekday or the 2 days after it. */
export function isInCycleWindow(todayDow, anchorDow) {
  if (anchorDow == null || !Number.isFinite(anchorDow) || !Number.isFinite(todayDow)) return true;
  const offset = (((todayDow - anchorDow) % 7) + 7) % 7;
  return offset < CYCLE_WINDOW_DAYS;
}

/**
 * Should this overdue projection be listed today?
 *
 * @param {object} params
 * @param {number} params.daysSinceLast   - days between the last delivery and today
 * @param {string} params.frequency       - projection label ('Weekly', 'x4 Weeks', …)
 * @param {object} params.patient         - patient row (weekly day flags)
 * @param {Date}   [params.lastDate]      - last delivery date
 * @param {number} params.todayDow        - 0=Sunday … 6=Saturday
 * @returns {boolean} true = keep it in the projections
 */
export function projectionVisibleInCycle({ daysSinceLast, frequency, patient, lastDate = null, todayDow }) {
  const interval = CYCLE_INTERVAL_DAYS[frequency];
  if (!interval || daysSinceLast == null || !Number.isFinite(daysSinceLast)) return true;
  const overdueDays = daysSinceLast - interval;
  if (overdueDays <= OVERDUE_GRACE_DAYS) return true;   // not overdue enough yet
  return isInCycleWindow(todayDow, resolveCycleDow(patient, lastDate, frequency));
}

export default projectionVisibleInCycle;
