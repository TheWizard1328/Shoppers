p = 'src/components/deliveries/getLocalDeliveryPredictions.jsx'
s = open(p).read()

s = s.replace(
    "import { projectionVisibleInCycle } from '@/components/utils/projectionCycleRule';",
    """import {
  projectionVisibleInCycle,
  missedRotations,
  MISSED_ROTATION_LIMIT,
  readRestoredProjectionIds,
  readRetiredProjectionIds,
} from '@/components/utils/projectionCycleRule';

// Owner-set projection lists (restored / retired patients) are read once per
// 5 seconds instead of once per patient — this runs over thousands of rows.
let _projFlagsCache = { at: 0, restored: new Set(), retired: new Set() };
const getProjectionFlags = () => {
  if (Date.now() - _projFlagsCache.at > 5000) {
    _projFlagsCache = { at: Date.now(), restored: readRestoredProjectionIds(), retired: readRetiredProjectionIds() };
  }
  return _projFlagsCache;
};
export const invalidateProjectionFlagsCache = () => { _projFlagsCache = { at: 0, restored: new Set(), retired: new Set() }; };""",
    1)

old = """    if (shouldDeliver && !projectionVisibleInCycle({
      daysSinceLast,
      frequency,
      patient,
      lastDate,
      todayDow: dayOfWeek,
    })) {
      return null;
    }

    if (!shouldDeliver) return null;"""
new = """    // ── OWNER RULE (Nov 6 2026): 2 ROTATIONS WITH NO DELIVERY ───────────────
    // "If a patient has not had a delivery on their projected date for at least
    // 2 rotations, then we will either remove the recurrence from the patient or
    // we will ignore the recurrence in the projection list."
    // Soft ignore: the row is flagged instead of dropped, so the panel can list
    // it in its own collapsed group with Restore / Retire. A restored patient
    // (dispatcher override) or a retired one (recurrence removed) is handled
    // here — retired never comes back, restored always shows normally.
    const _missed = shouldDeliver ? missedRotations({ daysSinceLast, frequency }) : 0;
    const _flags = shouldDeliver ? getProjectionFlags() : null;
    if (shouldDeliver && _flags && _flags.retired.has(String(patient.id))) return null;
    const _suppressed = Boolean(
      shouldDeliver
      && _missed >= MISSED_ROTATION_LIMIT
      && !(_flags && _flags.restored.has(String(patient.id)))
    );

    // The cycle-window rule (Nov 3 2026) hides overdue rows for most of the week.
    // A suppressed row is listed in its own section instead, so it skips this.
    if (shouldDeliver && !_suppressed && !projectionVisibleInCycle({
      daysSinceLast,
      frequency,
      patient,
      lastDate,
      todayDow: dayOfWeek,
    })) {
      return null;
    }

    if (!shouldDeliver) return null;"""
assert old in s
s = s.replace(old, new, 1)

old2 = """      cod_total_amount_required: 0,
      prescription_number: '',
      extra_time: 0
    };"""
new2 = """      cod_total_amount_required: 0,
      prescription_number: '',
      extra_time: 0,
      // Nov 6 2026 — shown in the "No delivery in 2 rotations" group when true.
      suppressed: _suppressed,
      missed_rotations: _missed,
      days_since_last: daysSinceLast
    };"""
assert old2 in s
s = s.replace(old2, new2, 1)
open(p, 'w').write(s)
print('predictions flag suppressed rows')
