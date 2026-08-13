import React, { useMemo, useState } from 'react';
import { Loader2, Scissors, Save, X, MapPin } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';

// ─── ResegmentStopsDialog ─────────────────────────────────────────────────────
// Confirmation popup shown when the user clicks the "Resegment" scissors button
// on a master breadcrumb timeline (stop_order === -1).
//
// Lists every completed/failed/cancelled stop for the same driver+date with
// checkboxes. Stops whose breadcrumb segment has already been saved to the
// delivery (saved_to_route === true) are left UNCHECKED by default; unsaved
// stops are auto-CHECKED so the user can immediately re-clip them.
//
// Props:
//   masterItem    — the master breadcrumb record (driver_id + delivery_date)
//   deliveries    — full Delivery[] list from PolylineViewer state
//   breadcrumbs   — full DeliveryBreadcrumbs[] list from PolylineViewer state
//   onConfirm     — (selectedStopOrders: number[]) => void
//   onCancel      — () => void
//   isResegmenting — disable actions while the backend call is in flight
// ──────────────────────────────────────────────────────────────────────────────

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

const computeStops = (deliveries, driver_id, delivery_date) => {
  if (!driver_id || !delivery_date) return [];
  return (deliveries || [])
    .filter(d => d && d.driver_id === driver_id && d.delivery_date === delivery_date && d.stop_order != null)
    .filter(d => TERMINAL_STATUSES.has(String(d.status || '').toLowerCase()))
    .sort((a, b) => Number(a.stop_order) - Number(b.stop_order));
};

const computeBreadcrumbMap = (breadcrumbs, driver_id, delivery_date) => {
  const map = new Map();
  if (!driver_id || !delivery_date) return map;
  (breadcrumbs || []).forEach(b => {
    if (b && b.driver_id === driver_id && b.delivery_date === delivery_date
        && b.stop_order != null && b.stop_order !== -1) {
      map.set(Number(b.stop_order), b);
    }
  });
  return map;
};

const computeInitialChecked = (stops, breadcrumbByStop) => {
  const m = new Set();
  stops.forEach(d => {
    const bc = breadcrumbByStop.get(Number(d.stop_order));
    // Auto-check stops that have NOT been saved to a delivery yet.
    if (!bc?.saved_to_route) m.add(Number(d.stop_order));
  });
  return m;
};

const STATUS_COLORS = {
  completed: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
  failed: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
  cancelled: 'bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300',
};

export default function ResegmentStopsDialog({
  masterItem,
  deliveries = [],
  breadcrumbs = [],
  onConfirm,
  onCancel,
  isResegmenting = false,
}) {
  const driver_id = masterItem?.driver_id;
  const delivery_date = masterItem?.delivery_date;

  const stops = useMemo(
    () => computeStops(deliveries, driver_id, delivery_date),
    [deliveries, driver_id, delivery_date]
  );

  const breadcrumbByStop = useMemo(
    () => computeBreadcrumbMap(breadcrumbs, driver_id, delivery_date),
    [breadcrumbs, driver_id, delivery_date]
  );

  const [checkedSet, setCheckedSet] = useState(() =>
    computeInitialChecked(
      computeStops(deliveries, driver_id, delivery_date),
      computeBreadcrumbMap(breadcrumbs, driver_id, delivery_date)
    )
  );

  if (!masterItem) return null;

  const toggle = (so) => {
    setCheckedSet(prev => {
      const next = new Set(prev);
      if (next.has(so)) next.delete(so);
      else next.add(so);
      return next;
    });
  };

  const allChecked = stops.length > 0 && checkedSet.size === stops.length;
  const setAll = (checked) => {
    setCheckedSet(checked ? new Set(stops.map(s => Number(s.stop_order))) : new Set());
  };

  const savedCount = stops.filter(s => breadcrumbByStop.get(Number(s.stop_order))?.saved_to_route).length;
  const unsavedCount = stops.length - savedCount;
  const selectedCount = checkedSet.size;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-full max-w-md max-h-[90vh] flex flex-col overflow-hidden">

        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b bg-slate-50 dark:bg-slate-800 flex-shrink-0">
          <Scissors className="w-5 h-5 text-orange-600 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <h2 className="font-semibold text-slate-900 dark:text-slate-100 text-base">Reclip Stop Segments</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 dark:text-slate-500 truncate">
              Pick which stops to re-slice from the master trail.
            </p>
          </div>
          <button
            onClick={onCancel}
            disabled={isResegmenting}
            className="p-1 rounded-md hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-500 dark:text-slate-400 transition-colors flex-shrink-0"
            title="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-px bg-slate-200 border-b flex-shrink-0">
          <Stat label="Total Stops" value={stops.length} />
          <Stat label="Saved" value={savedCount} accent="green" />
          <Stat label="Unsaved" value={unsavedCount} accent="amber" />
        </div>

        {/* Select-all row */}
        <div className="flex items-center justify-between px-5 py-2 bg-slate-50 dark:bg-slate-800 border-b flex-shrink-0">
          <label className="flex items-center gap-2 cursor-pointer">
            <Checkbox
              checked={allChecked}
              onCheckedChange={(c) => setAll(!!c)}
              disabled={isResegmenting || stops.length === 0}
            />
            <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
              {allChecked ? 'Deselect all' : 'Select all'}
            </span>
          </label>
          <span className="text-xs text-slate-500 dark:text-slate-400">{selectedCount} selected</span>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {stops.length === 0 ? (
            <div className="p-6 text-center text-sm text-slate-400 dark:text-slate-500">
              <MapPin className="w-8 h-8 mx-auto mb-2 opacity-40" />
              No completed stops found for this driver/date.
            </div>
          ) : (
            stops.map((d) => {
              const so = Number(d.stop_order);
              const bc = breadcrumbByStop.get(so);
              const saved = !!bc?.saved_to_route;
              const isChecked = checkedSet.has(so);
              return (
                <div
                  key={d.id || so}
                  className={`flex items-center gap-3 px-5 py-2.5 border-b border-slate-100 dark:border-slate-800 cursor-pointer transition-colors hover:bg-slate-50 dark:hover:bg-slate-800 ${
                    isChecked ? 'bg-orange-50 dark:bg-orange-950' : ''
                  }`}
                  onClick={() => !isResegmenting && toggle(so)}
                >
                  <Checkbox
                    checked={isChecked}
                    onCheckedChange={() => toggle(so)}
                    onClick={e => e.stopPropagation()}
                    disabled={isResegmenting}
                    className="flex-shrink-0"
                  />
                  <div className="flex-1 min-w-0 flex items-center gap-1.5 flex-wrap">
                    <span className="font-medium text-sm text-slate-900 dark:text-slate-100">
                      Stop #{so}
                    </span>
                    <Badge variant="outline" className={`text-xs py-0 px-1.5 border-0 ${STATUS_COLORS[d.status] || ''}`}>
                      {d.status}
                    </Badge>
                    {saved ? (
                      <Badge className="text-xs py-0 px-1.5 bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300 border-0">
                        <Save className="w-3 h-3 mr-1" />Saved
                      </Badge>
                    ) : bc ? (
                      <Badge className="text-xs py-0 px-1.5 bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300 border-0">
                        Not saved
                      </Badge>
                    ) : (
                      <Badge className="text-xs py-0 px-1.5 bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300 border-0">
                        No crumb
                      </Badge>
                    )}
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400 flex-shrink-0 text-right">
                    <div className="truncate max-w-[100px]">{d.delivery_id || d.tracking_number || '—'}</div>
                    <div>{bc?.point_count ?? 0} pts</div>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Actions */}
        <div className="flex gap-2 px-5 py-4 border-t bg-slate-50 dark:bg-slate-800 flex-shrink-0">
          <Button variant="outline" size="sm" className="flex-1" onClick={onCancel} disabled={isResegmenting}>
            Cancel
          </Button>
          <Button
            size="sm"
            className="flex-1 bg-orange-600 hover:bg-orange-700 text-white gap-2"
            onClick={() => onConfirm(Array.from(checkedSet).sort((a, b) => a - b))}
            disabled={isResegmenting || selectedCount === 0}
          >
            {isResegmenting
              ? <><Loader2 className="w-4 h-4 animate-spin" /> Re-clip…</>
              : <><Scissors className="w-4 h-4" /> Reclip {selectedCount}</>
            }
          </Button>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, accent }) {
  const colorMap = {
    amber: 'text-amber-600',
    green: 'text-green-600',
  };
  return (
    <div className="bg-white dark:bg-slate-900 flex flex-col items-center justify-center py-3 px-2 text-center">
      <span className={`text-xl font-bold ${colorMap[accent] || 'text-slate-800 dark:text-slate-200'}`}>{value}</span>
      <span className="text-xs text-slate-500 dark:text-slate-400 dark:text-slate-500 mt-0.5">{label}</span>
    </div>
  );
}