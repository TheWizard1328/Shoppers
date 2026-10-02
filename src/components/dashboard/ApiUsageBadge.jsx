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
  // Mirror of "are counts still missing" for the focus self-heal effect below
  // (kept in a ref so that effect never re-subscribes on every count change)
  const countsMissingRef = useRef(true);
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

  // RETRY (Oct 2 2026): fetchCounts previously had no retry — a boot-time
  // failure (entity calls racing ahead of the auth token actually attaching,
  // during the very first seconds after login/app load) was caught, logged,
  // and then PERMANENTLY left the badge on "..." until a full page reload,
  // since this only runs once on mount + on WS events (never re-fetches on
  // its own). Now retries up to 3 times with backoff (1.5s, 3s, 6s) before
  // giving up, which is enough to ride out the boot-loader race.
  const fetchCounts = async (attempt = 0) => {
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
      countsMissingRef.current = false;
    } catch (err) {
      console.warn(`[ApiUsageBadge] Failed to fetch counts (attempt ${attempt + 1}):`, err?.message || err);
      if (attempt < 5) {
        setTimeout(() => fetchCounts(attempt + 1), 2000 * Math.pow(2, attempt));
      }
    }
  };

  useEffect(() => {
    if (!currentUser || !isOwner) return undefined;

    // DEFERRED INITIAL FETCH (Oct 2 2026, owner request): previously the
    // badge fetched immediately on mount, which lands right as the boot
    // loader clears — the same moment the app fires its first big wave of
    // entity reads (deliveries, patients, stores, IDB hydration). This badge's
    // two filter() calls joined that storm and frequently lost (429/timeouts),
    // leaving the counter on "..." for the whole session. Now the first fetch
    // waits out the boot storm: a 6s settle delay, then runs inside
    // requestIdleCallback (fallback: timeout) so it only fires once the
    // browser is actually quiet. Retries + focus self-heal below cover the rest.
    let idleId = null, timeoutId = null;
    const startFetch = () => { timeoutId = null; fetchCounts(0); };
    timeoutId = setTimeout(() => {
      timeoutId = null;
      if (typeof window.requestIdleCallback === 'function') {
        idleId = window.requestIdleCallback(startFetch, { timeout: 4000 });
      } else {
        startFetch();
      }
    }, 6000);


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
      if (timeoutId) clearTimeout(timeoutId);
      if (idleId !== null && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(idleId);
      }
    };
  }, [currentUser, isOwner]);


  // SELF-HEAL ON FOCUS (Oct 2 2026): if the initial fetch's retries all failed
  // (unusually long/slow boot) and the badge is still stuck on "...", try again
  // whenever the user returns to the app. Cheap (2 entity filters) and runs
  // only while values are missing.
  useEffect(() => {
    const retryIfMissing = () => {
      if (countsMissingRef.current) fetchCounts(0);
    };
    window.addEventListener('focus', retryIfMissing);
    document.addEventListener('visibilitychange', retryIfMissing);
    return () => {
      window.removeEventListener('focus', retryIfMissing);
      document.removeEventListener('visibilitychange', retryIfMissing);
    };
  }, []);

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