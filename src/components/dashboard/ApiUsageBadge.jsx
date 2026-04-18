import React, { useEffect, useState } from "react";
import { base44 } from "@/api/base44Client";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import ResetPolylinesButton from "@/components/dashboard/ResetPolylinesButton";
import { getApiLogProvider, sumApiLogCalls } from "@/components/utils/apiUsageLog";

// Small self-contained badge that shows Google/HERE API usage for today
// Props:
// - currentUser: object (used by parent to gate rendering)
// - stopCardsHeight: number (px) to position the badge just above stop cards
export default function ApiUsageBadge({ currentUser, stopCardsHeight = 0, showRoutes = true, showBreadcrumbs = false, showCompletedRouteControls = false, selectedDate = null, selectedDriverIds = [], selectedPolylineOption = 'polylines', onPolylineOptionChange }) {
  const [googleCount, setGoogleCount] = useState(null);
  const [hereCount, setHereCount] = useState(null);

  // Edmonton-local date helpers (match Dashboard behavior)
  const getEdmDate = () => {
    const p = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Edmonton",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(new Date());
    const y = p.find((x) => x.type === "year").value;
    const m = p.find((x) => x.type === "month").value;
    const d = p.find((x) => x.type === "day").value;
    return `${y}-${m}-${d}`;
  };

  const getDayBoundsISO = () => {
    const dateStr = getEdmDate();
    const start = new Date(`${dateStr}T00:00:00`);
    const end = new Date(`${dateStr}T23:59:59`);
    return { startISO: start.toISOString(), endISO: end.toISOString() };
  };

  const fetchCounts = async () => {
    try {
      const { startISO, endISO } = getDayBoundsISO();

      const apiLogs = await base44.entities.GoogleAPILog.filter({
        timestamp: { $gte: startISO, $lte: endISO }
      });

      setGoogleCount(sumApiLogCalls(apiLogs, (log) => getApiLogProvider(log) === 'google'));
      setHereCount(sumApiLogCalls(apiLogs, (log) => getApiLogProvider(log) === 'here'));
    } catch (err) {
      // Non-critical; keep previous values
      console.warn("[ApiUsageBadge] Failed to fetch counts:", err?.message || err);
    }
  };

  useEffect(() => {
    if (!currentUser) return;
    const delayedInitialFetch = setTimeout(fetchCounts, 12000);
    const interval = setInterval(fetchCounts, 120000);

    return () => {
      clearTimeout(delayedInitialFetch);
      clearInterval(interval);
    };
  }, [currentUser]);

  return (
    <>
      <div className="absolute left-4 z-[140]" style={{ bottom: `${(stopCardsHeight || 0) + 15}px` }}>
        <div className="px-2 py-1 text-xs font-medium rounded-lg border" style={{ background: "transparent", borderColor: "var(--border-slate-200)", color: "var(--text-slate-600)" }}>
          🛣️ {googleCount ?? "..."} / {hereCount ?? "..."}
        </div>
      </div>
      {showCompletedRouteControls &&
      <div className="absolute top-4 right-4 z-[180] pointer-events-auto">
          <div className="px-2 py-2 rounded-xl border shadow-lg space-y-1" style={{ background: 'transparent', borderColor: 'var(--border-slate-200)' }}>
            <div className="flex items-start justify-between gap-3">
              <RadioGroup
                value={selectedPolylineOption}
                onValueChange={onPolylineOptionChange}
                className="gap-2"
              >
                <label className="flex items-center gap-3 cursor-pointer">
                  <RadioGroupItem
                    value="polylines"
                    id="completed-route-polylines"
                    onClick={() => {
                      window.__dashboardCompletedRouteControls?.setShowRoutes?.(true);
                      window.__dashboardCompletedRouteControls?.setShowBreadcrumbs?.(false);
                    }}
                  />
                  <div className="space-y-1"><div className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>Show Polylines</div></div>
                </label>
                <label className="flex items-center gap-3 cursor-pointer">
                  <RadioGroupItem
                    value="breadcrumbs"
                    id="completed-route-breadcrumbs"
                    onClick={() => {
                      window.__dashboardCompletedRouteControls?.setShowRoutes?.(false);
                      window.__dashboardCompletedRouteControls?.setShowBreadcrumbs?.(true);
                    }}
                  />
                  <div className="space-y-1"><div className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>Show Breadcrumbs</div></div>
                </label>
              </RadioGroup>
              <ResetPolylinesButton selectedDriverIds={selectedDriverIds} selectedDate={selectedDate} selectedPolylineOption={selectedPolylineOption} />
            </div>
          </div>
        </div>
      }
    </>);

}