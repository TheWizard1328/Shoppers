import React from 'react';
import { Magnet, AlertTriangle, CheckCircle, Zap, MapPin, X, Check, RefreshCw } from 'lucide-react';

// ─── SnapAnalysisDialog ───────────────────────────────────────────────────────
// Non-blocking floating panel showing the gap analysis BEFORE any HERE API calls.
// Confirm/cancel live on the card's inline ✓ / ✗ buttons (magnet + scissors
// transform), so this panel stays informational and must not cover those buttons.
// Props:
//   analysis   — object returned by snapMasterTimeline with analyze_only=true
//   onCancel   — user dismissed (inline ✗ or this panel's close button)
//   isSnapping — snap is in progress after confirm (disables buttons)
//   isAnalyzing— analyze_only call in flight (spins the refresh button)
//   onRefresh  — re-run analyze_only (after the user edits short gaps on the map)
// ─────────────────────────────────────────────────────────────────────────────
export default function SnapAnalysisDialog({ analysis, onCancel, isSnapping, isAnalyzing, onRefresh }) {
  if (!analysis) return null;

  const {
    total_points,
    gap_threshold_m,
    raw_gaps_found,
    snap_zones,
    estimated_api_calls,
    zone_details = [],
  } = analysis;

  const hasGaps = snap_zones > 0;

  return (
    <div className="fixed bottom-4 right-4 z-40 w-full max-w-sm pointer-events-auto">
      <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl overflow-hidden border border-slate-200 dark:border-slate-700">

        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b bg-slate-50 dark:bg-slate-800">
          <Magnet className="w-5 h-5 text-cyan-600 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <h2 className="font-semibold text-slate-900 dark:text-slate-100 text-base">Route Gap Analysis</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">Gaps &gt; {gap_threshold_m}m flagged for surgical snapping</p>
          </div>
          <button
            title="Re-run analysis after editing gaps"
            onClick={onRefresh}
            disabled={isAnalyzing || isSnapping || !onRefresh}
            className="p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-700 text-cyan-600 dark:text-cyan-400 disabled:opacity-50 transition-colors flex-shrink-0"
          >
            <RefreshCw className={`w-4 h-4 ${isAnalyzing ? 'animate-spin' : ''}`} />
          </button>
          <button
            title="Close"
            onClick={onCancel}
            disabled={isSnapping}
            className="p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-500 dark:text-slate-400 disabled:opacity-50 transition-colors flex-shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Summary stats */}
        <div className="grid grid-cols-3 gap-px bg-slate-200 border-b dark:bg-slate-700">
          <Stat label="Total Points" value={total_points.toLocaleString()} />
          <Stat label="Gaps Found" value={raw_gaps_found} accent={raw_gaps_found > 0 ? 'amber' : 'green'} />
          <Stat label="API Calls" value={estimated_api_calls} accent={estimated_api_calls > 0 ? 'cyan' : 'green'} />
        </div>

        {/* Body */}
        <div className="px-5 py-4 max-h-64 overflow-y-auto space-y-2">
          {!hasGaps ? (
            <div className="flex items-center gap-2 text-green-700 bg-green-50 dark:bg-green-950 dark:text-green-300 rounded-lg p-3 text-sm">
              <CheckCircle className="w-4 h-4 flex-shrink-0" />
              No gaps found — the master timeline is already clean!
            </div>
          ) : (
            <>
              <p className="text-xs text-slate-500 dark:text-slate-400 mb-1">
                {snap_zones} consolidated snap zone{snap_zones !== 1 ? 's' : ''} detected.
                Dense sections between zones are preserved untouched.
              </p>
              {zone_details.map((z) => (
                <div key={z.zone_index} className="flex items-start gap-2.5 p-2.5 bg-amber-50 dark:bg-amber-950 border border-amber-100 dark:border-amber-900 rounded-lg text-xs">
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-600 flex-shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-slate-800 dark:text-slate-200">
                      Zone {z.zone_index} — {z.gaps_in_zone} gap{z.gaps_in_zone !== 1 ? 's' : ''}
                    </div>
                    {(z.stop_before != null || z.stop_after != null) && (
                      <div className="text-cyan-700 dark:text-cyan-400 font-medium mt-0.5 flex items-center gap-1">
                        <MapPin className="w-3 h-3 flex-shrink-0" />
                        Stop #{z.stop_before ?? '?'} → Stop #{z.stop_after ?? '?'}
                      </div>
                    )}
                    <div className="text-slate-500 dark:text-slate-400 flex flex-wrap gap-x-3 gap-y-0.5 mt-0.5">
                      <span>Pts #{z.start_idx}–#{z.end_idx} ({z.points_in_zone} total)</span>
                      <span>Largest gap: {z.max_gap_m.toLocaleString()}m</span>
                      <span>Total missing: {(z.total_gap_distance_m / 1000).toFixed(2)}km</span>
                    </div>
                  </div>
                  <div className="flex-shrink-0 flex items-center gap-1 text-cyan-700 dark:text-cyan-400 font-semibold">
                    <Zap className="w-3 h-3" />
                    1 call
                  </div>
                </div>
              ))}
            </>
          )}
        </div>

        {/* Hint footer — confirm/cancel live on the card's inline ✓ / ✗ buttons */}
        <div className="px-5 py-3 border-t bg-slate-50 dark:bg-slate-800 text-xs text-slate-500 dark:text-slate-400 flex items-center gap-1.5 flex-wrap">
          <span>Use</span>
          <span className="inline-flex items-center justify-center w-5 h-5 rounded bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300">
            <Check className="w-3 h-3" />
          </span>
          <span>on the card to regenerate segments, or</span>
          <span className="inline-flex items-center justify-center w-5 h-5 rounded bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-300">
            <X className="w-3 h-3" />
          </span>
          <span>to cancel.</span>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, accent }) {
  const colorMap = {
    amber: 'text-amber-600',
    cyan: 'text-cyan-600',
    green: 'text-green-600',
  };
  return (
    <div className="bg-white dark:bg-slate-900 flex flex-col items-center justify-center py-3 px-2 text-center">
      <span className={`text-xl font-bold ${colorMap[accent] || 'text-slate-800 dark:text-slate-200'}`}>{value}</span>
      <span className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{label}</span>
    </div>
  );
}