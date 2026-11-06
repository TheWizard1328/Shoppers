p = 'src/components/deliveries/DeliveryFormStaged.jsx'
s = open(p).read()

# imports + local state helpers
s = s.replace("import { shouldShowStoreBadges } from '../utils/userRoles';",
"""import { shouldShowStoreBadges, userHasRole } from '../utils/userRoles';
import {
  restoreProjectionPatient,
  retireProjectionPatient,
  readRestoredProjectionIds,
} from '@/components/utils/projectionCycleRule';""", 1)

s = s.replace("import { Plus, Trash2 } from \"lucide-react\";",
              "import { Plus, Trash2, ChevronDown, ChevronRight, RotateCcw, Ban } from \"lucide-react\";", 1)

old_head = """      {/* Projected Deliveries Section */}
      {sortedProjectedDeliveries.length > 0 &&
      <div className="text-[10px] font-semibold uppercase tracking-wider px-1 py-1 text-yellow-600">
          Projected ({sortedProjectedDeliveries.length})
        </div>
      }
      {sortedProjectedDeliveries.map((projected) => {"""
new_head = """      {/* Projected Deliveries Section */}
      {activeProjectedDeliveries.length > 0 &&
      <div className="text-[10px] font-semibold uppercase tracking-wider px-1 py-1 text-yellow-600">
          Projected ({activeProjectedDeliveries.length})
        </div>
      }
      {activeProjectedDeliveries.map((projected) => {"""
assert old_head in s, 'projected header anchor missing'
s = s.replace(old_head, new_head, 1)

# split lists just before the return statement of the component
marker = "  const getDaysSinceLastDelivery = (lastDeliveryDate) => {"
assert marker in s
split = """  // ── PROJECTIONS SUPPRESSED FOR 2 MISSED ROTATIONS (owner rule Nov 6 2026) ──
  // Flagged rows are pulled out of the normal list and shown in a collapsed
  // group so nothing is silently dropped: Restore puts the patient straight back
  // into the projected list, Retire removes the recurrence (admin only).
  const [showSuppressedProjections, setShowSuppressedProjections] = React.useState(false);
  const [restoredProjectionIds, setRestoredProjectionIds] = React.useState(() => readRestoredProjectionIds());
  const activeProjectedDeliveries = React.useMemo(
    () => (sortedProjectedDeliveries || []).filter((p) => {
      if (!p?.suppressed) return true;
      return restoredProjectionIds.has(String(p.patient_id));
    }),
    [sortedProjectedDeliveries, restoredProjectionIds]
  );
  const suppressedProjectedDeliveries = React.useMemo(
    () => (sortedProjectedDeliveries || []).filter((p) => p?.suppressed && !restoredProjectionIds.has(String(p.patient_id))),
    [sortedProjectedDeliveries, restoredProjectionIds]
  );
  const canRetireProjection = userHasRole(currentUser, 'admin');

  const handleRestoreProjection = (patientId) => {
    restoreProjectionPatient(patientId);
    setRestoredProjectionIds(readRestoredProjectionIds());
  };

  const handleRetireProjection = async (projected) => {
    const patientId = projected?.patient_id;
    if (!patientId) return;
    const label = projected?.patient_name || 'this patient';
    if (!window.confirm(`Remove the recurring projection for ${label}? This clears the recurrence on the patient record.`)) return;
    try {
      const { updatePatient } = await import('@/components/utils/entityMutations');
      const patient = (patients || []).find((pt) => pt && pt.id === patientId) || {};
      const candidates = {
        recurring: false,
        recurring_daily: false,
        recurring_biweekly: false,
        recurring_bimonthly: false,
        recurring_monthly: false,
        recurring_weekly_sun: false,
        recurring_weekly_mon: false,
        recurring_weekly_tue: false,
        recurring_weekly_wed: false,
        recurring_weekly_thu: false,
        recurring_weekly_fri: false,
        recurring_weekly_sat: false,
      };
      // Only touch fields this patient actually carries (no schema surprises).
      const updates = {};
      Object.entries(candidates).forEach(([key, value]) => {
        if (Object.prototype.hasOwnProperty.call(patient, key)) updates[key] = value;
      });
      if (Object.keys(updates).length === 0) updates.recurring = false;
      await updatePatient(patientId, updates);
      retireProjectionPatient(patientId);
      setProjectedDeliveries((prev) => (prev || []).filter((row) => String(row?.patient_id) !== String(patientId)));
    } catch (error) {
      console.error('[projections] retire failed:', error);
      window.alert('Could not remove that recurrence. Nothing was changed.');
    }
  };

""" + marker
s = s.replace(marker, split, 1)

# suppressed section after the projected map block: insert before staged/projected end
tail_anchor = """      <div className="border-t-2 border-orange-200 my-2" />"""
if tail_anchor not in s:
    tail_anchor = "{sortedStagedDeliveries.length > 0 &&"
assert tail_anchor in s, 'tail anchor missing'
section = """      {/* No delivery in 2 rotations — collapsed by default */}
      {suppressedProjectedDeliveries.length > 0 && (
        <div className="mt-1">
          <button
            type="button"
            onClick={() => setShowSuppressedProjections((v) => !v)}
            className="flex w-full items-center gap-1 px-1 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500 hover:text-slate-700"
          >
            {showSuppressedProjections ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            No delivery in 2 rotations ({suppressedProjectedDeliveries.length})
          </button>
          {showSuppressedProjections && suppressedProjectedDeliveries.map((projected) => {
            const rowPatient = patients?.find((pt) => pt && pt.id === projected.patient_id);
            const rotations = projected.missed_rotations || 2;
            const days = projected.days_since_last;
            return (
              <div key={`suppressed-${projected.patient_id}`} className="mx-1 mb-1 rounded border border-slate-200 bg-slate-50 px-2 py-1.5">
                <div className="text-xs font-medium text-body truncate">{projected.patient_name || rowPatient?.full_name || 'Patient'}</div>
                <div className="text-[10px] text-soft">
                  {projected.frequency || projected.reason} · {rotations} rotations missed
                  {Number.isFinite(days) ? ` · ${days} days since last delivery` : ''}
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => handleRestoreProjection(projected.patient_id)}
                    className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-700 hover:underline"
                  >
                    <RotateCcw className="h-3 w-3" /> Restore
                  </button>
                  {canRetireProjection && (
                    <button
                      type="button"
                      onClick={() => handleRetireProjection(projected)}
                      className="inline-flex items-center gap-1 text-[10px] font-semibold text-red-600 hover:underline"
                    >
                      <Ban className="h-3 w-3" /> Retire recurrence
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

""" + tail_anchor
s = s.replace(tail_anchor, section, 1)
open(p, 'w').write(s)
print('suppressed projections section added')
