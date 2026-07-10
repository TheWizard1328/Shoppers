import React from "react";
import { useDevice } from "@/components/utils/DeviceContext";
import { X, ArrowRight, TrendingUp, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Shows a before/after comparison of route optimization for AppOwner.
 * Sorted by new stop order (after optimization).
 *
 * Props:
 *   open: boolean
 *   onClose: () => void
 *   rows: Array<{
 *     deliveryId: string,
 *     name: string,           // patient/store/cycling marker display name
 *     oldStopOrder: number,
 *     oldEta: string,         // "HH:mm" or null
 *     newStopOrder: number,
 *     newEta: string,         // "HH:mm" or null
 *     orderChanged: boolean,
 *   }>
 */
export default function RouteOptimizationCompareDialog({ open, onClose, rows = [] }) {
  const { isMobile } = useDevice();

  if (!open) return null;

  // If newStopOrder is still null on all rows, we're in "before" (loading) state
  const isLoading = rows.length > 0 && rows.every(r => r.newStopOrder === null);
  // Sort by new order when available, otherwise by old order
  const sorted = [...rows].sort((a, b) =>
    isLoading
      ? (a.oldStopOrder || 0) - (b.oldStopOrder || 0)
      : (a.newStopOrder || 0) - (b.newStopOrder || 0)
  );

  // Mobile: center in the space between the top header (~56px) and bottom nav (~64px)
  // so the dialog sits visually centred in the usable viewport area
  const positionStyle = isMobile
    ? {
        position: "fixed",
        top: "calc(56px + (100dvh - 56px - 64px) / 2)",
        left: "50%",
        transform: "translate(-50%, -50%)",
        width: "calc(100vw - 24px)",
        maxWidth: 480,
        zIndex: 9999,
      }
    : {
        position: "fixed",
        top: "50%",
        left: 272,
        transform: "translateY(-50%)",
        width: "auto",
        minWidth: 360,
        maxWidth: 520,
        zIndex: 9999,
      };

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/40 z-[9998]"
        onClick={onClose}
      />

      {/* Dialog */}
      <div
        style={positionStyle}
        className="bg-white dark:bg-slate-950 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 flex flex-col overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 rounded-t-2xl">
          <div className="flex items-center gap-2">
            {isLoading
              ? <Loader2 className="w-4 h-4 text-amber-500 animate-spin" />
              : <TrendingUp className="w-4 h-4 text-emerald-500 dark:text-emerald-400" />
            }
            <span className="font-semibold text-sm text-slate-800 dark:text-slate-100">
              {isLoading ? "Optimizing Route…" : "Route Optimization — Before vs After"}
            </span>
            <span className="text-xs bg-blue-100 dark:bg-blue-900/60 text-blue-700 dark:text-blue-300 px-2 py-0.5 rounded-full">
              {sorted.length} stops
            </span>
          </div>
          <Button variant="ghost" size="icon" className="h-7 w-7 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100" onClick={onClose}>
            <X className="w-4 h-4" />
          </Button>
        </div>

        {/* Column headers */}
        <div className="grid grid-cols-[40px_56px_minmax(0,1fr)_56px_40px] gap-x-1 px-3 py-2 bg-slate-100 dark:bg-slate-800/80 border-b border-slate-200 dark:border-slate-700 text-xs font-semibold text-slate-500 dark:text-slate-400">
          <div className="text-center">#</div>
          <div className="text-center">Old ETA</div>
          <div className="text-center">Stop</div>
          <div className="text-center">New ETA</div>
          <div className="text-center">#</div>
        </div>

        {/* Rows */}
        <div className="overflow-y-auto bg-white dark:bg-slate-950" style={{ maxHeight: isMobile ? "55vh" : "60vh" }}>
          {sorted.length === 0 ? (
            <div className="text-center text-sm text-slate-400 dark:text-slate-500 py-10">No stops to compare</div>
          ) : (
            sorted.map((row, idx) => {
              const pending = row.newStopOrder === null;
              const moved = !pending && row.oldStopOrder !== row.newStopOrder;
              return (
                <div
                  key={row.deliveryId || idx}
                  className={`grid grid-cols-[40px_56px_minmax(0,1fr)_56px_40px] gap-x-1 px-3 py-2 items-center border-b text-xs ${
                    moved
                      ? "bg-amber-50 dark:bg-amber-950/40 border-amber-100 dark:border-amber-900/40"
                      : "bg-white dark:bg-slate-950 border-slate-100 dark:border-slate-800"
                  }`}
                >
                  {/* Old stop order */}
                  <div className="text-center font-mono text-slate-400 dark:text-slate-500">
                    {row.oldStopOrder ?? "—"}
                  </div>

                  {/* Old ETA */}
                  <div className="text-center font-mono text-slate-500 dark:text-slate-400">
                    {row.oldEta || "—"}
                  </div>

                  {/* Stop name + arrow if moved */}
                  <div className="flex items-center gap-1 min-w-0">
                    {moved && (
                      <ArrowRight className="w-3 h-3 text-amber-500 dark:text-amber-400 flex-shrink-0" />
                    )}
                    {/* Cycling marker coloured dot */}
                    {row.isCyclingStart && (
                      <span className="flex-shrink-0 w-2.5 h-2.5 rounded-full bg-green-500" title="Cycling Start" />
                    )}
                    {row.isCyclingEnd && (
                      <span className="flex-shrink-0 w-2.5 h-2.5 rounded-full bg-red-500" title="Cycling End" />
                    )}
                    <span
                      className={`truncate font-medium ${
                        row.isCyclingStart
                          ? "text-green-700 dark:text-green-400"
                          : row.isCyclingEnd
                          ? "text-red-700 dark:text-red-400"
                          : moved
                          ? "text-amber-800 dark:text-amber-300"
                          : "text-slate-700 dark:text-slate-200"
                      }`}
                      title={row.name}
                    >
                      {row.name || "Unknown"}
                    </span>
                  </div>

                  {/* New ETA */}
                  <div className="text-center font-mono font-semibold text-emerald-700 dark:text-emerald-400">
                    {pending ? <span className="text-slate-300 dark:text-slate-600">…</span> : (row.newEta || "—")}
                  </div>

                  {/* New stop order */}
                  <div className="text-center font-mono font-bold text-emerald-700 dark:text-emerald-400">
                    {pending ? <span className="text-slate-300 dark:text-slate-600">…</span> : (row.newStopOrder ?? "—")}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Footer legend */}
        <div className="px-4 py-2 bg-slate-50 dark:bg-slate-900 border-t border-slate-200 dark:border-slate-700 rounded-b-2xl flex items-center gap-4 text-xs text-slate-500 dark:text-slate-400">
          <span className="flex items-center gap-1">
            <span className="w-3 h-3 rounded bg-amber-100 dark:bg-amber-900/60 border border-amber-200 dark:border-amber-700 inline-block" />
            Stop position changed
          </span>
          <span className="flex items-center gap-1">
            <span className="font-bold text-emerald-600 dark:text-emerald-400">#</span>
            = new order
          </span>
        </div>
      </div>
    </>
  );
}