import React from 'react';
import { Loader2, Magnet, AlertTriangle, CheckCircle, Zap, MapPin } from 'lucide-react';
import { Button } from '@/components/ui/button';

// ─── SnapAnalysisDialog ───────────────────────────────────────────────────────
// Shows the gap analysis before committing any HERE API calls.
// Props:
//   analysis  — object returned by snapMasterTimeline with analyze_only=true
//   onConfirm — user accepted, proceed to snap
//   onCancel  — user dismissed
//   isSnapping — snap is in progress after confirm
// ─────────────────────────────────────────────────────────────────────────────
export default function SnapAnalysisDialog({ analysis, onConfirm, onCancel, isSnapping }) {
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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">

        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b bg-slate-50">
          <Magnet className="w-5 h-5 text-cyan-600 flex-shrink-0" />
          <div>
            <h2 className="font-semibold text-slate-900 text-base">Route Gap Analysis</h2>
            <p className="text-xs text-slate-500">Gaps &gt; {gap_threshold_m}m flagged for surgical snapping</p>
          </div>
        </div>

        {/* Summary stats */}
        <div className="grid grid-cols-3 gap-px bg-slate-200 border-b">
          <Stat label="Total Points" value={total_points.toLocaleString()} />
          <Stat label="Gaps Found" value={raw_gaps_found} accent={raw_gaps_found > 0 ? 'amber' : 'green'} />
          <Stat label="API Calls" value={estimated_api_calls} accent={estimated_api_calls > 0 ? 'cyan' : 'green'} />
        </div>

        {/* Body */}
        <div className="px-5 py-4 max-h-64 overflow-y-auto space-y-2">
          {!hasGaps ? (
            <div className="flex items-center gap-2 text-green-700 bg-green-50 rounded-lg p-3 text-sm">
              <CheckCircle className="w-4 h-4 flex-shrink-0" />
              No gaps found — the master timeline is already clean!
            </div>
          ) : (
            <>
              <p className="text-xs text-slate-500 mb-1">
                {snap_zones} consolidated snap zone{snap_zones !== 1 ? 's' : ''} detected.
                Dense sections between zones are preserved untouched.
              </p>
              {zone_details.map((z) => (
                <div key={z.zone_index} className="flex items-start gap-2.5 p-2.5 bg-amber-50 border border-amber-100 rounded-lg text-xs">
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-600 flex-shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-slate-800">
                      Zone {z.zone_index} — {z.gaps_in_zone} gap{z.gaps_in_zone !== 1 ? 's' : ''}
                    </div>
                    <div className="text-slate-500 flex flex-wrap gap-x-3 gap-y-0.5 mt-0.5">
                      <span>Pts #{z.start_idx}–#{z.end_idx} ({z.points_in_zone} total)</span>
                      <span>Largest gap: {z.max_gap_m.toLocaleString()}m</span>
                      <span>Total missing: {(z.total_gap_distance_m / 1000).toFixed(2)}km</span>
                    </div>
                  </div>
                  <div className="flex-shrink-0 flex items-center gap-1 text-cyan-700 font-semibold">
                    <Zap className="w-3 h-3" />
                    1 call
                  </div>
                </div>
              ))}
            </>
          )}
        </div>

        {/* Actions */}
        <div className="flex gap-2 px-5 py-4 border-t bg-slate-50">
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            onClick={onCancel}
            disabled={isSnapping}
          >
            Cancel
          </Button>
          {hasGaps && (
            <Button
              size="sm"
              className="flex-1 bg-cyan-600 hover:bg-cyan-700 text-white gap-2"
              onClick={onConfirm}
              disabled={isSnapping}
            >
              {isSnapping
                ? <><Loader2 className="w-4 h-4 animate-spin" /> Snapping…</>
                : <><Magnet className="w-4 h-4" /> Snap {estimated_api_calls} Zone{estimated_api_calls !== 1 ? 's' : ''}</>
              }
            </Button>
          )}
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
    <div className="bg-white flex flex-col items-center justify-center py-3 px-2 text-center">
      <span className={`text-xl font-bold ${colorMap[accent] || 'text-slate-800'}`}>{value}</span>
      <span className="text-xs text-slate-500 mt-0.5">{label}</span>
    </div>
  );
}