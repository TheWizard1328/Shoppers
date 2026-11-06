p = 'src/components/utils/projectionCycleRule.js'
s = open(p).read()

anchor = "const WEEK_FLAG_ORDER = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];"
assert anchor in s
add = """// ── MISSED ROTATIONS (owner rule Nov 6 2026) ────────────────────────────────
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

""" + anchor
s = s.replace(anchor, add, 1)
open(p, 'w').write(s)
print('rule module extended')
