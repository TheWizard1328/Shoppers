import { getLastDeliveryDate } from '@/components/utils/patientHistoryUtils';
import React from 'react';
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Plus, Trash2, ChevronDown, ChevronRight, RotateCcw, Ban } from "lucide-react";
import SpecialSymbolsBadges from '../utils/SpecialSymbolsBadges';
import { getStoreColor, hexToRgba } from '../utils/colorGenerator';
import { shouldShowStoreBadges, userHasRole } from '../utils/userRoles';
import {
  restoreProjectionPatient,
  retireProjectionPatient,
  readRestoredProjectionIds,
} from '@/components/utils/projectionCycleRule';
import { formatPhoneNumber } from '../utils/phoneFormatter';

export default function DeliveryFormStaged({
  sortedStagedDeliveries,
  sortedProjectedDeliveries,
  stores,
  patients,
  currentUser,
  editingStagedId,
  isMobileDevice,
  handleStagedDeliveryClick,
  handleClearForm,
  stagedDeliveries,
  fullPredictionListRef,
  setProjectedDeliveries,
  setStagedDeliveries,
  setEditingStagedId,
  patientSearchInputRef,
  confirmAddProjectedToStaged,
  setDeleteConfirmation,
  isLoadingPredictions,
  shouldAutoFocusFields,
  selectedDate
}) {
  // ── PROJECTIONS SUPPRESSED FOR 2 MISSED ROTATIONS (owner rule Nov 6 2026) ──
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

  const getDaysSinceLastDelivery = (lastDeliveryDate) => {
    if (!lastDeliveryDate) return null;

    const rawValue = String(lastDeliveryDate).trim();
    const normalizedDate = rawValue.includes('T') ? rawValue.split('T')[0] : rawValue;
    const [year, month, day] = normalizedDate.split('-').map(Number);
    if (!year || !month || !day) return null;

    const deliveredAt = new Date(year, month - 1, day);
    if (Number.isNaN(deliveredAt.getTime())) return null;

    // Use the form's selected date as reference, falling back to today.
    // IMPORTANT: parse as local date (not UTC) to avoid timezone off-by-one errors.
    let refStart;
    if (selectedDate) {
      const [ry, rm, rd] = String(selectedDate).split('T')[0].split('-').map(Number);
      refStart = new Date(ry, rm - 1, rd);
    } else {
      const now = new Date();
      refStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    }
    const diffMs = refStart.getTime() - deliveredAt.getTime();
    const diffDays = Math.floor(diffMs / 86400000);

    return diffDays >= 0 ? diffDays : null;
  };

  const parseFrequencyDays = (frequency) => {
    if (!frequency) return null;

    const normalized = String(frequency).toLowerCase();
    const match = normalized.match(/(\d+)\s*(day|days|wk|wks|week|weeks|mon|mons|month|months)/);
    if (!match) return null;

    const amount = Number(match[1]);
    const unit = match[2];
    if (unit.startsWith('day')) return amount;
    if (unit.startsWith('wk') || unit.startsWith('week')) return amount * 7;
    if (unit.startsWith('mon') || unit.startsWith('month')) return amount * 30;
    return null;
  };

  // Returns { expected, low, high, label } for known recurrence types, null otherwise
  const getRecurrenceWindow = (frequency) => {
    if (!frequency) return null;
    const f = String(frequency).toLowerCase();
    if (f.includes('bi-month') || f.includes('bimonth')) return { expected: 60, low: 57, high: 63, label: '2Mon' };
    if (f.includes('month'))                               return { expected: 30, low: 27, high: 33, label: '1Mon' };
    if (f.includes('x4') || f.includes('4 week'))         return { expected: 28, low: 25, high: 31, label: '4Wks' };
    if (f.includes('bi-week') || f.includes('biweek'))    return { expected: 14, low: 12, high: 16, label: '2Wks' };
    return null;
  };

  const formatLastDelivered = (lastDeliveryDate, frequency) => {
    const diffDays = getDaysSinceLastDelivery(lastDeliveryDate);
    if (diffDays === null) return null;

    const window = getRecurrenceWindow(frequency);

    if (window) {
      const { expected, low, high, label } = window;
      if (diffDays >= low && diffDays <= high) {
        if (diffDays === expected) return `LD: ${label}`;
        if (diffDays < expected)  return `LD: ~${label}`;
        return `LD: >${label}`;
      }
      // Outside window — overdue
      if (diffDays > high) return `LD: >${label}`;
      // Under window — not yet due, show approximate
      return `LD: ~${label}`;
    }

    // No known window — show raw elapsed time
    if (diffDays < 7)  return `LD: ${diffDays}d`;
    if (diffDays < 30) return `LD: ${Math.floor(diffDays / 7)}Wks`;
    return `LD: ${Math.floor(diffDays / 30)}Mon`;
  };

  // ── FUTURE-DATE PENDING SPLIT (owner request Nov 4 2026) ──────────────────
  // "for pending stops in the staged/pending panel on the add to route form that
  // are for a future date can we separate them into another pending section
  // divided with a date header?" Pending stops on the date being edited stay in
  // the normal Pending list; every pending stop booked for another date drops
  // into its own date-headed group so they no longer mix in with today's work.
  const _dateKeyOf = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return '';
    return raw.includes('T') ? raw.split('T')[0] : raw.split(' ')[0];
  };
  const _todayKey = (() => {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  })();
  const referenceDateKey = _dateKeyOf(selectedDate) || _todayKey;
  const _formatDateHeader = (key) => {
    const [y, m, d] = String(key || '').split('-').map(Number);
    if (!y || !m || !d) return 'Other date';
    const dt = new Date(y, m - 1, d);
    if (Number.isNaN(dt.getTime())) return String(key);
    const opts = { weekday: 'short', month: 'short', day: 'numeric' };
    if (y !== new Date().getFullYear()) opts.year = 'numeric';
    return dt.toLocaleDateString(undefined, opts);
  };
  const pendingItems = sortedStagedDeliveries.filter((s) => s.id);
  const sameDatePending = pendingItems.filter((s) => _dateKeyOf(s.delivery_date) === referenceDateKey);
  const _futureByDate = new Map();
  pendingItems.forEach((s) => {
    const key = _dateKeyOf(s.delivery_date);
    if (key === referenceDateKey) return;
    const bucketKey = key || 'unknown';
    if (!_futureByDate.has(bucketKey)) _futureByDate.set(bucketKey, []);
    _futureByDate.get(bucketKey).push(s);
  });
  const futurePending = Array.from(_futureByDate.values()).reduce((acc, list) => acc + list.length, 0);
  const pendingSections = [
    { key: `same::${referenceDateKey}`, header: null, items: sameDatePending },
    ...Array.from(_futureByDate.keys()).sort().map((key) => ({
      key: `future::${key}`,
      header: key === 'unknown' ? 'No date' : `${_formatDateHeader(key)} (${_futureByDate.get(key).length})`,
      items: _futureByDate.get(key),
    })),
  ];

  return (
    <div className="space-y-1 flex-1 min-h-0 h-full max-h-[55vh] overflow-y-auto overscroll-contain custom-scrollbar">
      {/* Staged Deliveries Section (new, not yet saved) */}
      {sortedStagedDeliveries.filter((s) => !s.id).length > 0 &&
      <>
          <div className="text-[10px] font-semibold uppercase tracking-wider px-1 py-1 text-emerald-600">
            Staged ({sortedStagedDeliveries.filter((s) => !s.id).length})
          </div>
          {sortedStagedDeliveries.filter((s) => !s.id).map((staged) => {
          const stagedStore = stores?.find((s) => s && s.id === staged.store_id);
          const storeColor = stagedStore ? getStoreColor(stagedStore) : '#64748b';
          const fadedBgColor = hexToRgba(storeColor, 0.1);
          // OWNER SPEC (Oct 23 2026): inactive patients get a red border on staged/pending cards
          const stagedPatient = staged.patient_id ? (patients || []).find((p) => p && p.id === staged.patient_id) : null;
          const isInactivePatient = stagedPatient?.status === 'inactive';

          return (
            <div
              key={staged._tempId}
              className={`flex p-2 rounded border-2 text-xs cursor-pointer transition-colors ${editingStagedId === staged._tempId ? 'border-blue-300' : isInactivePatient ? 'border-red-500' : 'border-emerald-300'} hover:bg-slate-50 dark:bg-slate-800 dark:hover:bg-slate-800`}
              style={{
                backgroundColor: editingStagedId === staged._tempId ? hexToRgba(storeColor, 0.2) : fadedBgColor
              }}
              onClick={() => handleStagedDeliveryClick(staged)}>

                <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium truncate flex-1 min-w-0">{staged.care_pros && staged.cp_name ? `CP ${staged.cp_name}` : staged.patient_name}</span>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      {staged.store_abbreviation && shouldShowStoreBadges(currentUser) &&
                    <Badge className="text-white text-[10px] px-1.5 py-0 h-4" style={{ backgroundColor: storeColor }}>
                         {staged.store_abbreviation}
                       </Badge>
                    }
                      {staged.distanceFromStore !== null && staged.distanceFromStore !== undefined && typeof staged.distanceFromStore === 'number' &&
                    <Badge
                      className="text-white text-[10px] px-1.5 py-0 h-4"
                      style={{
                        backgroundColor: staged.distanceFromStore <= 10 ? '#10b981' :
                        staged.distanceFromStore <= 15 ? '#f59e0b' : '#ef4444'
                      }}>
                         {staged.distanceFromStore.toFixed(1)} km
                       </Badge>
                    }
                    </div>
                  </div>
                  <div className="flex items-center gap-1 min-h-0">
                    <div className="truncate flex-1 min-w-0 text-slate-700 dark:text-slate-300 text-[10px] leading-none">{staged.delivery_address}</div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <SpecialSymbolsBadges
                      delivery={staged}
                      patient={null}
                      isPickup={false}
                      size="sm" />
                    
                      {Array.isArray(staged.barcode_values) && staged.barcode_values.length > 0 &&
                    <Badge className="text-[10px] px-1.5 py-0 h-4 bg-emerald-100 text-emerald-700 flex items-center gap-1">
                          <svg className="h-3 w-4" viewBox="0 0 40 12" aria-hidden="true">
                            <rect x="1" y="1" width="2" height="10" fill="currentColor" />
                            <rect x="6" y="1" width="1" height="10" fill="currentColor" />
                            <rect x="9" y="1" width="3" height="10" fill="currentColor" />
                            <rect x="14" y="1" width="1" height="10" fill="currentColor" />
                            <rect x="17" y="1" width="2" height="10" fill="currentColor" />
                            <rect x="21" y="1" width="1" height="10" fill="currentColor" />
                            <rect x="24" y="1" width="3" height="10" fill="currentColor" />
                            <rect x="29" y="1" width="1" height="10" fill="currentColor" />
                            <rect x="32" y="1" width="2" height="10" fill="currentColor" />
                            <rect x="36" y="1" width="1" height="10" fill="currentColor" />
                          </svg>
                          x{staged.barcode_values.length}
                        </Badge>
                    }
                      {staged.ampm_deliveries &&
                    <Badge className={`text-[10px] px-1.5 py-0 h-4 ${staged.ampm_deliveries === 'AM' ? 'bg-sky-100 text-sky-700 rounded-full' : 'bg-indigo-100 text-indigo-700 rounded-lg'}`}>
                          {staged.ampm_deliveries}
                        </Badge>
                    }
                    </div>
                  </div>
                  <div className="text-slate-700 dark:text-slate-300 text-[10px] truncate pr-1 leading-none min-h-0">
                    {staged.patient_phone ? formatPhoneNumber(staged.patient_phone) : ''}
                  </div>
                </div>

                <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 w-7 p-0 flex-shrink-0 bg-red-600 hover:bg-red-700 text-white rounded ml-1"
                onClick={(e) => {
                  e.stopPropagation();
                  setStagedDeliveries((prev) => prev.filter((item) => item._tempId !== staged._tempId));

                  const remainingStagedIds = new Set(
                    stagedDeliveries.
                    filter((item) => item._tempId !== staged._tempId).
                    map((d) => d.patient_id).
                    filter(Boolean)
                  );
                  const filteredPredictions = fullPredictionListRef.current.filter((pred) => !remainingStagedIds.has(pred.patient_id));
                  setProjectedDeliveries(filteredPredictions);

                  if (editingStagedId === staged._tempId) {
                    setEditingStagedId(null);
                    handleClearForm();
                  }

                  if (shouldAutoFocusFields) {
                    setTimeout(() => patientSearchInputRef.current?.focus(), 100);
                  }
                }}>
                  <Trash2 className="w-5 h-5" />
                </Button>
              </div>);

        })}
          <div className="border-t-2 border-emerald-200 my-2" />
        </>
      }

      {/* Pending Deliveries Section */}
      {sortedStagedDeliveries.filter((s) => s.id).length > 0 &&
      <>
          <div className="text-[10px] font-semibold uppercase tracking-wider px-1 py-1 text-orange-600">
            Pending ({sameDatePending.length})
          </div>
          {futurePending > 0 &&
            <div className="text-[10px] font-semibold uppercase tracking-wider px-1 py-1 text-orange-700">
              Future Pending ({futurePending})
            </div>
          }
          {pendingSections.map((section) => (
          <React.Fragment key={section.key}>
          {section.header &&
            <div className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-1 mt-1 mb-0.5 text-orange-700 bg-orange-50 dark:bg-orange-950/40 rounded">
              {section.header}
            </div>
          }
          {section.items.map((staged) => {
          const stagedStore = stores?.find((s) => s && s.id === staged.store_id);
          const storeColor = stagedStore ? getStoreColor(stagedStore) : '#64748b';
          const fadedBgColor = hexToRgba(storeColor, 0.1);
          // OWNER SPEC (Oct 23 2026): inactive patients get a red border on staged/pending cards
          const stagedPatient = staged.patient_id ? (patients || []).find((p) => p && p.id === staged.patient_id) : null;
          const isInactivePatient = stagedPatient?.status === 'inactive';

          return (
            <div
              key={staged._tempId}
              className={`flex p-2 rounded border text-xs cursor-pointer transition-colors ${editingStagedId === staged._tempId ? 'border-blue-300' : isInactivePatient ? 'border-red-500 border-2' : 'border-surface'} hover:bg-slate-50 dark:bg-slate-800 dark:hover:bg-slate-800`}
              style={{
                backgroundColor: editingStagedId === staged._tempId ? hexToRgba(storeColor, 0.2) : fadedBgColor
              }}
              onClick={() => handleStagedDeliveryClick(staged)}>

                <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium truncate flex-1 min-w-0">{staged.care_pros && staged.cp_name ? `CP ${staged.cp_name}` : staged.patient_name}</span>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      {staged.store_abbreviation && shouldShowStoreBadges(currentUser) &&
                    <Badge className="text-white text-[10px] px-1.5 py-0 h-4" style={{ backgroundColor: storeColor }}>
                         {staged.store_abbreviation}
                       </Badge>
                    }
                      {staged.distanceFromStore !== null && staged.distanceFromStore !== undefined && typeof staged.distanceFromStore === 'number' &&
                    <Badge
                      className="text-white text-[10px] px-1.5 py-0 h-4"
                      style={{
                        backgroundColor: staged.distanceFromStore <= 10 ? '#10b981' :
                        staged.distanceFromStore <= 15 ? '#f59e0b' : '#ef4444'
                      }}>
                         {staged.distanceFromStore.toFixed(1)} km
                       </Badge>
                    }
                    </div>
                  </div>
                  <div className="flex items-center gap-1 min-h-0">
                    <div className="truncate flex-1 min-w-0 text-slate-700 dark:text-slate-300 text-[10px] leading-none">{staged.delivery_address}</div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <SpecialSymbolsBadges
                      delivery={staged}
                      patient={null}
                      isPickup={false}
                      size="sm" />
                    
                      {Array.isArray(staged.barcode_values) && staged.barcode_values.length > 0 &&
                    <Badge className="text-[10px] px-1.5 py-0 h-4 bg-emerald-100 text-emerald-700 flex items-center gap-1">
                          <svg className="h-3 w-4" viewBox="0 0 40 12" aria-hidden="true">
                            <rect x="1" y="1" width="2" height="10" fill="currentColor" />
                            <rect x="6" y="1" width="1" height="10" fill="currentColor" />
                            <rect x="9" y="1" width="3" height="10" fill="currentColor" />
                            <rect x="14" y="1" width="1" height="10" fill="currentColor" />
                            <rect x="17" y="1" width="2" height="10" fill="currentColor" />
                            <rect x="21" y="1" width="1" height="10" fill="currentColor" />
                            <rect x="24" y="1" width="3" height="10" fill="currentColor" />
                            <rect x="29" y="1" width="1" height="10" fill="currentColor" />
                            <rect x="32" y="1" width="2" height="10" fill="currentColor" />
                            <rect x="36" y="1" width="1" height="10" fill="currentColor" />
                          </svg>
                          x{staged.barcode_values.length}
                        </Badge>
                    }
                      {staged.ampm_deliveries &&
                    <Badge className={`text-[10px] px-1.5 py-0 h-4 ${staged.ampm_deliveries === 'AM' ? 'bg-sky-100 text-sky-700 rounded-full' : 'bg-indigo-100 text-indigo-700 rounded-lg'}`}>
                          {staged.ampm_deliveries}
                        </Badge>
                    }
                    </div>
                  </div>
                  <div className="text-slate-700 dark:text-slate-300 text-[10px] truncate pr-1 leading-none min-h-0">
                    {staged.patient_phone ? formatPhoneNumber(staged.patient_phone) : ''}
                  </div>
                </div>

                <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 w-7 p-0 flex-shrink-0 bg-red-600 hover:bg-red-700 text-white rounded ml-1"
                onClick={(e) => {
                  e.stopPropagation();
                  if (staged.id) {
                    setDeleteConfirmation({ show: true, staged });
                  } else {
                    setStagedDeliveries((prev) => prev.filter((item) => item._tempId !== staged._tempId));

                    const remainingStagedIds = new Set(
                      stagedDeliveries.
                      filter((item) => item._tempId !== staged._tempId).
                      map((d) => d.patient_id).
                      filter(Boolean)
                    );
                    const filteredPredictions = fullPredictionListRef.current.filter((pred) => !remainingStagedIds.has(pred.patient_id));
                    setProjectedDeliveries(filteredPredictions);

                    if (editingStagedId === staged._tempId) {
                      setEditingStagedId(null);
                      handleClearForm();
                    }

                    if (shouldAutoFocusFields) {
                      setTimeout(() => patientSearchInputRef.current?.focus(), 100);
                    }
                  }
                }}>
                  <Trash2 className="w-5 h-5" />
                </Button>
              </div>);

        })}
          </React.Fragment>
          ))}
          {/* No delivery in 2 rotations — collapsed by default */}
      {suppressedProjectedDeliveries.length > 0 && (
        <div className="mt-1">
          <button
            type="button"
            onClick={() => setShowSuppressedProjections((v) => !v)}
            className="flex w-full items-center gap-1 px-1 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
          >
            {showSuppressedProjections ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            No delivery in 2 rotations ({suppressedProjectedDeliveries.length})
          </button>
          {showSuppressedProjections && suppressedProjectedDeliveries.map((projected) => {
            const rowPatient = patients?.find((pt) => pt && pt.id === projected.patient_id);
            const rotations = projected.missed_rotations || 2;
            const days = projected.days_since_last;
            return (
              <div key={`suppressed-${projected.patient_id}`} className="mx-1 mb-1 rounded border border-slate-200 bg-slate-50 dark:border-slate-600 dark:bg-slate-800 px-2 py-1.5">
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

      <div className="border-t-2 border-orange-200 my-2" />
        </>
      }

      {/* Projected Deliveries Section */}
      {activeProjectedDeliveries.length > 0 &&
      <div className="text-[10px] font-semibold uppercase tracking-wider px-1 py-1 text-yellow-600">
          Projected ({activeProjectedDeliveries.length})
        </div>
      }
      {activeProjectedDeliveries.map((projected) => {
        const projectedStore = stores?.find((s) => s && s.id === projected.store_id);
        const storeColor = projectedStore ? getStoreColor(projectedStore) : '#64748b';
        const projectedPatient = patients?.find((p) => p && p.id === projected.patient_id);
        const projectedAddress = projected.delivery_address || projectedPatient?.address || '';
        const projectedUnitNumber = projected.unit_number || projectedPatient?.unit_number || '';
        const projectedRecurrence = [
        projected.frequency || projected.reason,
        formatLastDelivered(getLastDeliveryDate(projectedPatient) || projected.last_delivery_date, projected.frequency)].
        filter(Boolean).join(' • ');

        // Border/fill color: green = on/exact due date, red = overdue, bright yellow = early/upcoming
        const ldText = formatLastDelivered(getLastDeliveryDate(projectedPatient) || projected.last_delivery_date, projected.frequency);
        const isOverdue = ldText?.includes('>');
        const isExact = ldText && !ldText.includes('~') && !ldText.includes('>') && getRecurrenceWindow(projected.frequency);
        const projCardClass = isOverdue
          ? 'bg-red-50 border-red-500 dark:bg-red-950/70 dark:border-red-700'
          : isExact
          ? 'bg-green-50 border-green-600 dark:bg-green-950/70 dark:border-green-700'
          : 'bg-yellow-50 border-yellow-500 dark:bg-yellow-950/70 dark:border-yellow-700';

        return (
          <div
            key={`proj-${projected.patient_id}`} className={`px-2 py-2 text-xs rounded flex border-2 transition-colors ${projCardClass}`}>
            

            <div className="flex-1 min-w-0 flex flex-col gap-[1px] leading-none">
              <div className="flex items-center gap-1.5 min-h-0">
                <span className="font-medium truncate flex-1 min-w-0 text-slate-900 dark:text-slate-50 leading-none">{projectedPatient?.care_pros && projectedPatient?.cp_name ? `CP ${projectedPatient.cp_name}` : projected.patient_name}</span>
                <div className="flex items-center gap-1 flex-shrink-0">
                  {projectedStore?.abbreviation && shouldShowStoreBadges(currentUser) &&
                  <Badge className="text-white text-[10px] px-1.5 py-0 h-4" style={{ backgroundColor: storeColor }}>
                      {projectedStore.abbreviation}
                    </Badge>
                  }
                  <Badge className="bg-yellow-500 text-white text-[10px] px-1.5 py-0 h-4">PROJ</Badge>
                </div>
              </div>
              <div className="flex items-center gap-1 min-h-0">
                <div className="truncate flex-1 min-w-0 text-slate-700 dark:text-slate-300 text-[10px] leading-none">
                  {projectedAddress}
                  {projectedUnitNumber ? ` #${projectedUnitNumber}` : ''}
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <SpecialSymbolsBadges
                    delivery={projected}
                    patient={projectedPatient}
                    isPickup={false}
                    size="sm" />
                  
                </div>
              </div>
              <div className="text-slate-700 dark:text-slate-300 text-[10px] truncate pr-1 leading-none min-h-0">
                {projectedRecurrence}
              </div>
            </div>

            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 w-7 p-0 flex-shrink-0 rounded ml-1"
              style={{ backgroundColor: '#059669', color: '#ffffff' }}
              onClick={() => {
                confirmAddProjectedToStaged(projected);
                if (shouldAutoFocusFields) {
                  setTimeout(() => patientSearchInputRef.current?.focus(), 100);
                }
              }}
              title="Add to route">
              <Plus className="w-5 h-5" />
            </Button>
          </div>);

      })}

      {isLoadingPredictions &&
      <div className="p-4 text-center text-slate-500 dark:text-slate-400 text-xs flex items-center justify-center gap-2">
          <div className="animate-spin w-3 h-3 border-2 border-white border-t-transparent rounded-full"></div>
          Refreshing projections...
        </div>
      }

      {!isLoadingPredictions && sortedStagedDeliveries.length === 0 && sortedProjectedDeliveries.length === 0 &&
      <div className="p-4 text-center text-slate-400 dark:text-slate-400 text-xs">
          No deliveries staged yet
        </div>
      }
    </div>);

}