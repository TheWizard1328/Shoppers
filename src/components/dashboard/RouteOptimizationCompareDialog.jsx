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

  // Dark mode here — the app's real dark-mode system flips the --bg-white /
  // --text-slate-XXX / --border-slate-200 custom properties on html.dark-theme
  // (or html.auto-theme under prefers-color-scheme). This dialog previously
  // used Tailwind's ambient `dark:` class variants for the same job, but those
  // weren't reliably activating here (header/rows/footer all stayed light),
  // hiding the whole panel's readability at night. Switching structural colors
  // (backgrounds, borders, base text) to the same CSS-variable tokens used
  // everywhere else in the app guarantees they track the real theme state.
  // Amber/emerald/blue accent highlights are kept but resolved from this same
  // isDark flag instead of dark: classes, for the same reason.
  const [isDark, setIsDark] = React.useState(
    () => typeof document !== "undefined" && document.documentElement.classList.contains("dark-theme")
  );

  React.useEffect(() => {
    if (!open || typeof document === "undefined") return;
    const root = document.documentElement;
    const sync = () => setIsDark(root.classList.contains("dark-theme"));
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, [open]);

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

  // Accent colors — hand-picked light/dark pairs (amber/emerald/blue/green/red)
  // matching the original Tailwind intent, resolved via isDark instead of dark:.
  const accent = {
    emeraldIcon: isDark ? '#34d399' : '#10b981',
    blueChipBg: isDark ? 'rgba(30, 58, 138, 0.6)' : '#dbeafe',
    blueChipText: isDark ? '#93c5fd' : '#1d4ed8',
    closeIcon: isDark ? '#94a3b8' : '#64748b',
    closeIconHover: isDark ? '#f1f5f9' : '#0f172a',
    amberMovedBg: isDark ? 'rgba(120, 53, 15, 0.4)' : '#fffbeb',
    amberMovedBorder: isDark ? 'rgba(146, 64, 14, 0.4)' : '#fef3c7',
    amberArrow: isDark ? '#fbbf24' : '#f59e0b',
    amberText: isDark ? '#fcd34d' : '#92400e',
    greenText: isDark ? '#4ade80' : '#15803d',
    redText: isDark ? '#f87171' : '#b91c1c',
    emeraldText: isDark ? '#34d399' : '#047857',
    dimText: isDark ? '#64748b' : '#cbd5e1',
    amberSwatchBg: isDark ? 'rgba(120, 53, 15, 0.6)' : '#fef3c7',
    amberSwatchBorder: isDark ? '#b45309' : '#fde68a',
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
        style={{ ...positionStyle, background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}
        className="rounded-2xl shadow-2xl border flex flex-col overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 rounded-t-2xl border-b" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
          <div className="flex items-center gap-2">
            {isLoading
              ? <Loader2 className="w-4 h-4 text-amber-500 animate-spin" />
              : <TrendingUp className="w-4 h-4" style={{ color: accent.emeraldIcon }} />
            }
            <span className="font-semibold text-sm" style={{ color: 'var(--text-slate-900)' }}>
              {isLoading ? "Optimizing Route…" : "Route Optimization — Before vs After"}
            </span>
            <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: accent.blueChipBg, color: accent.blueChipText }}>
              {sorted.length} stops
            </span>
          </div>
          <Button variant="ghost" size="icon" className="h-7 w-7" style={{ color: accent.closeIcon }} onClick={onClose}>
            <X className="w-4 h-4" />
          </Button>
        </div>

        {/* Column headers: Old # | Old ETA | Stop | New ETA | New # */}
        <div className="grid grid-cols-[32px_52px_minmax(0,1fr)_60px_32px] gap-x-1 px-3 py-2 border-b text-xs font-semibold" style={{ background: 'var(--bg-slate-100)', borderColor: 'var(--border-slate-200)', color: 'var(--text-slate-500)' }}>
          <div className="text-center">#</div>
          <div className="text-center">Old ETA</div>
          <div className="text-center">Stop</div>
          <div className="text-center">New ETA</div>
          <div className="text-center">#</div>
        </div>

        {/* Rows */}
        <div className="overflow-y-auto" style={{ background: 'var(--bg-white)', maxHeight: isMobile ? "55vh" : "60vh" }}>
          {sorted.length === 0 ? (
            <div className="text-center text-sm py-10" style={{ color: 'var(--text-slate-400)' }}>No stops to compare</div>
          ) : (
            sorted.map((row, idx) => {
              const pending = row.newStopOrder === null;
              const moved = !pending && row.oldStopOrder !== row.newStopOrder;
              return (
                <div
                  key={row.deliveryId || idx}
                  className="grid grid-cols-[32px_52px_minmax(0,1fr)_60px_32px] gap-x-1 px-3 py-2 items-center border-b text-xs"
                  style={{
                    background: moved ? accent.amberMovedBg : 'var(--bg-white)',
                    borderColor: moved ? accent.amberMovedBorder : 'var(--border-slate-200)',
                  }}
                >
                  {/* Old stop order */}
                  <div className="text-center font-mono" style={{ color: 'var(--text-slate-400)' }}>
                    {row.oldStopOrder ?? "—"}
                  </div>

                  {/* Old ETA */}
                  <div className="text-center font-mono" style={{ color: 'var(--text-slate-500)' }}>
                    {row.oldEta || "—"}
                  </div>

                  {/* Store badge + Stop name */}
                  <div className="flex items-center gap-1.5 min-w-0">
                    {moved && (
                      <ArrowRight className="w-3 h-3 flex-shrink-0" style={{ color: accent.amberArrow }} />
                    )}
                    {row.isCyclingStart && (
                      <span className="flex-shrink-0 w-2.5 h-2.5 rounded-full bg-green-500" title="Cycling Start" />
                    )}
                    {row.isCyclingEnd && (
                      <span className="flex-shrink-0 w-2.5 h-2.5 rounded-full bg-red-500" title="Cycling End" />
                    )}
                    {!row.isCyclingStart && !row.isCyclingEnd && row.storeAbbrev && (
                      <span
                        className="text-[9px] font-bold leading-none px-1.5 py-0.5 rounded-full text-white flex-shrink-0"
                        style={{ backgroundColor: row.storeColor || '#64748b' }}
                      >
                        {row.storeAbbrev}
                      </span>
                    )}
                    <span
                      className="truncate font-medium"
                      style={{
                        color: row.isCyclingStart
                          ? accent.greenText
                          : row.isCyclingEnd
                          ? accent.redText
                          : moved
                          ? accent.amberText
                          : 'var(--text-slate-700)'
                      }}
                      title={row.name}
                    >
                      {row.name || "Unknown"}
                    </span>
                  </div>

                  {/* New ETA */}
                  <div className="text-center font-mono font-semibold" style={{ color: accent.emeraldText }}>
                    {pending ? <span style={{ color: accent.dimText }}>…</span> : (row.newEta || "—")}
                  </div>

                  {/* New stop order */}
                  <div className="text-center font-mono font-bold" style={{ color: accent.emeraldText }}>
                    {pending ? <span style={{ color: accent.dimText }}>…</span> : (row.newStopOrder ?? "—")}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Footer legend */}
        <div className="px-4 py-2 rounded-b-2xl border-t flex items-center gap-4 text-xs" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)', color: 'var(--text-slate-500)' }}>
          <span className="flex items-center gap-1">
            <span className="w-3 h-3 rounded border inline-block" style={{ background: accent.amberSwatchBg, borderColor: accent.amberSwatchBorder }} />
            Stop position changed
          </span>
          <span className="flex items-center gap-1">
            <span className="font-bold" style={{ color: accent.emeraldText }}>#</span>
            = new order
          </span>
        </div>
      </div>
    </>
  );
}
