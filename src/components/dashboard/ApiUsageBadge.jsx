import React, { useEffect, useRef, useState } from "react";
import { base44 } from "@/api/base44Client";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import ResetPolylinesButton from "@/components/dashboard/ResetPolylinesButton";
import { getApiLogCategory, sumApiLogCalls } from "@/components/utils/apiUsageLog";
import { isAppOwner } from "@/components/utils/userRoles";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger } from
"@/components/ui/tooltip";

// Small self-contained badge that shows Google/HERE API usage for today
// Props:
// - currentUser: object (used by parent to gate rendering)
// - stopCardsHeight: number (px) to position the badge just above stop cards
export default function ApiUsageBadge({ currentUser, stopCardsHeight = 0, showRoutes = true, showBreadcrumbs = false, showCompletedRouteControls = false, selectedDate = null, selectedDriverIds = [], selectedPolylineOption = 'polylines', onPolylineOptionChange }) {
  const [googleCount, setGoogleCount] = useState(null);
  const [hereRoutingCount, setHereRoutingCount] = useState(null);
  const [hereTileCount, setHereTileCount] = useState(null);
  const [selectedApiKey, setSelectedApiKey] = useState('HERE_API_KEY');
  const [isTooltipOpen, setIsTooltipOpen] = useState(false);
  const tooltipTimerRef = useRef(null);
  const tooltipLockUntilRef = useRef(0);
  const bottomNavHeight = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--bottom-nav-height') || '0', 10) || 0;
  const fabBottomOffset = bottomNavHeight > 0 ? bottomNavHeight + 16 : 16;
  const hasVisibleStopCards = typeof document !== 'undefined' && !!document.querySelector('[data-stop-card], [id^="stop-card-"]');
  const effectiveStopCardsHeight = hasVisibleStopCards ? stopCardsHeight : 0;
  const isOwner = isAppOwner(currentUser);

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
      base44.entities.AppSettings.filter({ setting_key: 'refresh_intervals' })]
      );

      const activeKey = appSettings?.[0]?.setting_value?.selected_api_key || 'HERE_API_KEY';
      setSelectedApiKey(activeKey);
      setGoogleCount(sumApiLogCalls(apiLogs, (log) => getApiLogCategory(log) === 'google'));
      setHereRoutingCount(sumApiLogCalls(apiLogs, (log) => getApiLogCategory(log) === 'here_routing'));
      setHereTileCount(sumApiLogCalls(apiLogs, (log) => getApiLogCategory(log) === 'here_tiles'));
    } catch (err) {
      // Non-critical; keep previous values
      console.warn("[ApiUsageBadge] Failed to fetch counts:", err?.message || err);
    }
  };

  useEffect(() => {
    if (!currentUser || !isOwner) return;
    fetchCounts();
    const delayedInitialFetch = setTimeout(fetchCounts, 12000);
    const interval = setInterval(fetchCounts, 120000);
    const handleRealtimeApiLog = () => fetchCounts();

    window.addEventListener('realtimeUpdate_GoogleAPILog', handleRealtimeApiLog);

    return () => {
      clearTimeout(delayedInitialFetch);
      clearInterval(interval);
      window.removeEventListener('realtimeUpdate_GoogleAPILog', handleRealtimeApiLog);
    };
  }, [currentUser, isOwner]);

  useEffect(() => {
    return () => {
      if (tooltipTimerRef.current) {
        clearTimeout(tooltipTimerRef.current);
      }
    };
  }, []);

  const showApiTooltipForTouch = () => {
    if (tooltipTimerRef.current) {
      clearTimeout(tooltipTimerRef.current);
    }
    tooltipLockUntilRef.current = Date.now() + 3000;
    setIsTooltipOpen(true);
    tooltipTimerRef.current = setTimeout(() => {
      setIsTooltipOpen(false);
      tooltipTimerRef.current = null;
      tooltipLockUntilRef.current = 0;
    }, 3000);
  };

  const handleTooltipOpenChange = (open) => {
    if (!open && Date.now() < tooltipLockUntilRef.current) {
      return;
    }
    setIsTooltipOpen(open);
  };

  if (!isOwner) return null;

  return (
    <>
      <div className="absolute left-6 z-[100] pointer-events-auto" style={{ bottom: `${Math.max(effectiveStopCardsHeight + 10, fabBottomOffset)}px` }}>
        <TooltipProvider delayDuration={200}>
          <Tooltip open={isTooltipOpen} onOpenChange={handleTooltipOpenChange}>
            <TooltipTrigger asChild>
              <button
                type="button" className="px-1 text-xs font-medium rounded-md border shadow-sm"
                onTouchStart={showApiTooltipForTouch}
                onClick={showApiTooltipForTouch}
                style={{ background: "color-mix(in srgb, var(--bg-white) 55%, transparent)", borderColor: "var(--border-slate-200)", color: "var(--text-slate-600)" }}>
                
                🛣️ {googleCount ?? "..."} / {hereRoutingCount ?? "..."} / {hereTileCount ?? "..."}
              </button>
            </TooltipTrigger>
            <TooltipContent
              side="top"
              className="max-w-[280px] p-3 z-[10000]"
              style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
              
              <p className="font-semibold text-sm mb-1" style={{ color: 'var(--text-slate-900)' }}>
                Active Maps API Key
              </p>
              <p className="text-xs leading-relaxed mb-2" style={{ color: 'var(--text-slate-600)' }}>
                {selectedApiKey}
              </p>
              <div className="space-y-1 text-xs" style={{ color: 'var(--text-slate-700)' }}>
                <div>Google API: {googleCount ?? '...'}</div>
                <div>HERE Routing API: {hereRoutingCount ?? '...'}</div>
                <div>HERE Map Tile API: {hereTileCount ?? '...'}</div>
              </div>
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
              className="gap-2">
              
                <label htmlFor="completed-route-polylines" className="flex items-center gap-3 cursor-pointer">
                  <RadioGroupItem
                  value="polylines"
                  id="completed-route-polylines" />
                
                  <div className="space-y-1"><div className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>Show Polylines</div></div>
                </label>
                <label htmlFor="completed-route-breadcrumbs" className="flex items-center gap-3 cursor-pointer">
                  <RadioGroupItem
                  value="breadcrumbs"
                  id="completed-route-breadcrumbs" />
                
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