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
export default function ApiUsageBadge({ currentUser, stopCardsHeight = 0, showRoutes = true, setShowRoutes, showBreadcrumbs = false, setShowBreadcrumbs, showCompletedRouteControls = false, selectedDate = null, selectedDriverIds = [], selectedPolylineOption = 'polylines', onPolylineOptionChange, children = null }) {
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

  // UTC day bounds — aligned with HERE's counter reset at 00:00 UTC
  // HERE resets daily quotas at UTC midnight (= ~6pm Edmonton time), so we must
  // query the same UTC window HERE uses, not a local-time window.
  const getDayBoundsISO = () => {
    const now = new Date();
    const startISO = new Date(Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0
    )).toISOString();
    const endISO = new Date(Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59
    )).toISOString();
    return { startISO, endISO };
  };

  // Track last successful fetch for throttling visibility-triggered refetches
  const lastFetchAtRef = useRef(0);

  const fetchCounts = async (attempt = 0) => {
    try {
      const { startISO, endISO } = getDayBoundsISO();

      // allSettled: an AppSettings failure must not kill the counts fetch
      // (and vice versa) — the old Promise.all made the whole badge show "..."
      // whenever either call failed during the cold boot burst.
      const [apiLogsRes, appSettingsRes] = await Promise.allSettled([
        base44.entities.GoogleAPILog.filter({
          timestamp: { $gte: startISO, $lte: endISO }
        }),
        base44.entities.AppSettings.filter({ setting_key: 'refresh_intervals' })]
      );

      const apiLogs = apiLogsRes.status === 'fulfilled' ? apiLogsRes.value : null;
      const appSettings = appSettingsRes.status === 'fulfilled' ? appSettingsRes.value : null;
      if (!apiLogs) throw new Error('GoogleAPILog fetch rejected');

      const activeKey = appSettings?.[0]?.setting_value?.selected_api_key || 'HERE_API_KEY';
      setSelectedApiKey(activeKey);
      setGoogleCount(sumApiLogCalls(apiLogs, (log) => getApiLogCategory(log) === 'google'));
      setHereRoutingCount(sumApiLogCalls(apiLogs, (log) => getApiLogCategory(log) === 'here_routing'));
      setHereTileCount(sumApiLogCalls(apiLogs, (log) => getApiLogCategory(log) === 'here_tiles'));
      lastFetchAtRef.current = Date.now();
    } catch (err) {
      // Non-critical; keep previous values
      console.warn("[ApiUsageBadge] Failed to fetch counts:", err?.message || err);
      // BOOT RESILIENCE (Sep 10, 2026): the old code fetched exactly ONCE on
      // mount — a transient failure during the cold-boot request burst (token
      // refresh, 429, network not ready) left the badge stuck on "..." all day.
      // Retry a few times with backoff.
      if (attempt < 3) {
        setTimeout(() => { fetchCounts(attempt + 1).catch(() => {}); }, 1500 * (attempt + 1));
      }
    }
  };

  useEffect(() => {
    if (!currentUser || !isOwner) return;

    // One initial fetch on load
    fetchCounts();

    // Refetch when the app becomes visible again (badge may have been stuck
    // from a failed boot fetch, or the day may have rolled over). Throttled.
    const handleVisibility = () => {
      if (document.hidden) return;
      if (Date.now() - lastFetchAtRef.current < 30000) return;
      fetchCounts().catch(() => {});
    };
    document.addEventListener('visibilitychange', handleVisibility);

    // WebSocket-driven incremental update — just increment the HERE routing count
    // without making another API call
    const handleRealtimeApiLog = (event) => {
      const log = event?.detail?.data;
      if (!log) return;
      const category = getApiLogCategory(log);
      const count = Number(log?.metadata?.call_count ?? 1);
      if (category === 'google') setGoogleCount((prev) => (prev ?? 0) + count);else
      if (category === 'here_routing') setHereRoutingCount((prev) => (prev ?? 0) + count);else
      if (category === 'here_tiles') setHereTileCount((prev) => (prev ?? 0) + count);
    };

    window.addEventListener('realtimeUpdate_GoogleAPILog', handleRealtimeApiLog);

    return () => {
      window.removeEventListener('realtimeUpdate_GoogleAPILog', handleRealtimeApiLog);
      document.removeEventListener('visibilitychange', handleVisibility);
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

  const counterButton =
  <TooltipProvider delayDuration={200}>
      <Tooltip open={isTooltipOpen} onOpenChange={handleTooltipOpenChange}>
        <TooltipTrigger asChild>
          <button
 type="button" className="px-1 text-xs font-medium rounded-md border shadow-sm text-label border-surface"
 onTouchStart={showApiTooltipForTouch}
 onClick={showApiTooltipForTouch}
 style={{ background: "transparent" }}>
            🛣️ {googleCount ?? "..."} / {hereRoutingCount ?? "..."} / {hereTileCount ?? "..."}
          </button>
        </TooltipTrigger>
        <TooltipContent
        side="top"
        className="max-w-[280px] p-3 z-[10000] text-body bg-surface" style={{ borderColor: 'var(--border-slate-300)' }}>
          <p className="font-semibold text-sm mb-1 text-body">
            Active Maps API Key
          </p>
          <p className="text-xs leading-relaxed mb-2 text-label">
            {selectedApiKey}
          </p>
          <div className="space-y-1 text-xs text-body-2">
            <div>Google API: {googleCount ?? '...'}</div>
            <div>HERE Routing API: {hereRoutingCount ?? '...'}</div>
            <div>HERE Map Tile API: {hereTileCount ?? '...'}</div>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>;


  return (
    <>
      {counterButton}
      {showCompletedRouteControls &&
      <div className="absolute top-4 right-4 z-[180] pointer-events-auto">
          <div className="px-2 py-2 rounded-xl border shadow-lg space-y-1 border-surface" style={{ background: 'transparent' }}>
            <div className="flex items-start justify-between gap-3">
              <RadioGroup
              value={selectedPolylineOption}
              onValueChange={(value) => {
                onPolylineOptionChange?.(value);
                setShowRoutes?.(value === 'polylines');
                setShowBreadcrumbs?.(value === 'breadcrumbs');
              }}
              className="gap-2">
              
                <label htmlFor="completed-route-polylines" className="flex items-center gap-3 cursor-pointer">
                  <RadioGroupItem
                  value="polylines"
                  id="completed-route-polylines" />
                
                  <div className="space-y-1"><div className="text-sm font-medium text-body">Show Polylines</div></div>
                </label>
                <label htmlFor="completed-route-breadcrumbs" className="flex items-center gap-3 cursor-pointer">
                  <RadioGroupItem
                  value="breadcrumbs"
                  id="completed-route-breadcrumbs" />
                
                  <div className="space-y-1"><div className="text-sm font-medium text-body">Show Breadcrumbs</div></div>
                </label>
              </RadioGroup>
              <ResetPolylinesButton selectedDriverIds={selectedDriverIds} selectedDate={selectedDate} selectedPolylineOption={selectedPolylineOption} />
            </div>
          </div>
        </div>
      }
    </>);

}