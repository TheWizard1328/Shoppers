import React, { useEffect, useState } from "react";
import { base44 } from "@/api/base44Client";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import ResetPolylinesButton from "@/components/dashboard/ResetPolylinesButton";
import { getApiLogProvider, sumApiLogCalls } from "@/components/utils/apiUsageLog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// Small self-contained badge that shows Google/HERE API usage for today
// Props:
// - currentUser: object (used by parent to gate rendering)
// - stopCardsHeight: number (px) to position the badge just above stop cards
export default function ApiUsageBadge({ currentUser, stopCardsHeight = 0, showRoutes = true, showBreadcrumbs = false, showCompletedRouteControls = false, selectedDate = null, selectedDriverIds = [], selectedPolylineOption = 'polylines', onPolylineOptionChange }) {
  const [googleCount, setGoogleCount] = useState(null);
  const [hereCount, setHereCount] = useState(null);
  const [selectedApiKey, setSelectedApiKey] = useState('HERE_API_KEY');

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

      const [apiLogs, appSettings] = await Promise.all([
        base44.entities.GoogleAPILog.filter({
          timestamp: { $gte: startISO, $lte: endISO }
        }),
        base44.entities.AppSettings.filter({ setting_key: 'refresh_intervals' })
      ]);

      const activeKey = appSettings?.[0]?.setting_value?.selected_api_key || 'HERE_API_KEY';
      setSelectedApiKey(activeKey);
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
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="px-2 py-1 text-xs font-medium rounded-lg border"
                style={{ background: "transparent", borderColor: "var(--border-slate-200)", color: "var(--text-slate-600)" }}
              >
                🛣️ {googleCount ?? "..."} / {hereCount ?? "..."}
              </button>
            </TooltipTrigger>
            <TooltipContent
              side="top"
              className="max-w-[280px] p-3 z-[10000]"
              style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}
            >
              <p className="font-semibold text-sm mb-1" style={{ color: 'var(--text-slate-900)' }}>
                Active Maps API Key
              </p>
              <p className="text-xs leading-relaxed" style={{ color: 'var(--text-slate-600)' }}>
                {selectedApiKey}
              </p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      {showCompletedRouteControls &&
      <div className="absolute top-4 right-4 z-[180] pointer-events-auto">
          <div className="px-2 py-2 rounded-xl border shadow-lg space-y-1" style={{ background: 'transparent', borderColor: 'var(--border-slate-200)' }}>
            <div className="flex items-start justify-between gap-3">
              <RadioGroup
                value={selectedPolylineOption}
                onValueChange={(value) => {
                  onPolylineOptionChange?.(value);
                  window.__dashboardCompletedRouteControls?.setShowRoutes?.(value === 'polylines');
                  window.__dashboardCompletedRouteControls?.setShowBreadcrumbs?.(value === 'breadcrumbs');
                }}
                className="gap-2"
              >
                <label htmlFor="completed-route-polylines" className="flex items-center gap-3 cursor-pointer">
                  <RadioGroupItem
                    value="polylines"
                    id="completed-route-polylines"
                  />
                  <div className="space-y-1"><div className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>Show Polylines</div></div>
                </label>
                <label htmlFor="completed-route-breadcrumbs" className="flex items-center gap-3 cursor-pointer">
                  <RadioGroupItem
                    value="breadcrumbs"
                    id="completed-route-breadcrumbs"
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