import React, { useEffect, useRef, useState } from "react";
import { getAppSettingRows } from '@/components/utils/appSettingsCache';
import { base44 } from "@/api/base44Client";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import ResetPolylinesButton from "@/components/dashboard/ResetPolylinesButton";
import { getApiLogCategory, sumApiLogCalls } from "@/components/utils/apiUsageLog";
import { isAppOwner } from "@/components/utils/userRoles";
import { readApiCounts, writeApiCounts, bumpApiCounts, needsServerRefresh } from '@/components/utils/apiCountsCache';
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

  // LOCAL day bounds (owner request Nov 8 2026): the usage counter resets at
  // local midnight -> local 23:59:59 again, NOT at 00:00 UTC. The UTC window was
  // only ever there to line the badge up with the HERE / Google quota sites,
  // which reset at UTC midnight (~6pm Edmonton); the owner wants the number to
  // follow the local working day. toISOString() converts the local bounds to the
  // matching UTC instants, so the stored-call comparison stays correct across DST.
  const getDayBoundsISO = () => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    return { startISO: start.toISOString(), endISO: end.toISOString() };
  };

  // RETRY (Oct 2 2026): fetchCounts previously had no retry — a boot-time
  // failure (entity calls racing ahead of the auth token actually attaching,
  // during the very first seconds after login/app load) was caught, logged,
  // and then PERMANENTLY left the badge on "..." until a full page reload,
  // since this only runs once on mount + on WS events (never re-fetches on
  // its own). Now retries up to 3 times with backoff (1.5s, 3s, 6s) before
  // giving up, which is enough to ride out the boot-loader race.
  // LIGHT PROFILE (owner spec Oct 14 2026): on secondary owner instances the
  // badge serves cached counts and refetches at most once per hour — the Editor
  // instance polls the same account-wide numbers, so extra fetches only fed
  // the rate-limit storms.
  const secondaryRef = useRef(false);
  const lastFetchAtRef = useRef(0);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { isSecondaryOwnerInstance } = await import('@/components/utils/deviceManager');
        const sec = await isSecondaryOwnerInstance(currentUser);
        if (alive) secondaryRef.current = sec;
      } catch (_) {}
    })();
    return () => { alive = false; };
  }, [currentUser?.id]);

  const fetchCounts = async (attempt = 0) => {
    // IDB FIRST (owner spec Nov 9 2026): a device only asks the server when its
    // own cached copy is 5+ minutes old. The old secondary-instance hourly cap is
    // gone — it could not stop the first fetch of a load, which is exactly the
    // call that fed the 429 bursts on the editor instance.
    if (attempt === 0) {
      const cached = await readApiCounts();
      if (!needsServerRefresh(cached)) {
        if (cached.hasData) {
          setGoogleCount(cached.google);
          setHereRoutingCount(cached.hereRouting);
          setHereTileCount(cached.hereTiles);
          countsMissingRef.current = false;
        }
        lastFetchAtRef.current = cached.fetchedAt || 0;
        return;
      }
    }
    try {
      const { startISO, endISO } = getDayBoundsISO();

      const [apiLogs, appSettings] = await Promise.all([
      // Oct 15 2026: filtered on `timestamp` (unindexed) this query scanned the
      // ever-growing GoogleAPILog collection and timed out at 15s on all 5
      // retries. `created_date` is the platform's built-in field (indexed) and
      // log rows are written at the moment they describe, so the day window is
      // identical.
      base44.entities.GoogleAPILog.filter({
        created_date: { $gte: startISO, $lte: endISO }
      }),
      getAppSettingRows('refresh_intervals')]
      );

      const activeKey = appSettings?.[0]?.setting_value?.selected_api_key || 'HERE_API_KEY';
      setSelectedApiKey(activeKey);
      const google = sumApiLogCalls(apiLogs, (log) => getApiLogCategory(log) === 'google');
      const hereRouting = sumApiLogCalls(apiLogs, (log) => getApiLogCategory(log) === 'here_routing');
      const hereTiles = sumApiLogCalls(apiLogs, (log) => getApiLogCategory(log) === 'here_tiles');
      lastFetchAtRef.current = Date.now();
      setGoogleCount(google);
      setHereRoutingCount(hereRouting);
      setHereTileCount(hereTiles);
      countsMissingRef.current = false;
      // Mirror to IDB so the next load / page switch paints without the network.
      writeApiCounts({ google, hereRouting, hereTiles }).catch(() => {});
    } catch (err) {
      const msg = String(err?.message || err);
      const status = Number(err?.status || err?.response?.status || 0);
      const rateLimited = status === 429 || /429|rate limit|too many/i.test(msg);
      console.warn(`[ApiUsageBadge] Failed to fetch counts (attempt ${attempt + 1}${rateLimited ? ', rate-limited' : ''}):`, msg);
      if (attempt < 6) {
        // RATE-AWARE BACKOFF (Oct 2 2026): a 429 means the platform's
        // per-minute quota is exhausted — retrying seconds later lands inside
        // the SAME limited window and just burns another failure (observed:
        // badge stuck 30-60s on hard boot while every short retry 429'd).
        // Rate-limited attempts wait in 15s/30s steps for the quota bucket to
        // refill; other transient errors keep the short 2-16s backoff.
        const wait = rateLimited ? [15000, 30000, 30000, 45000, 45000, 60000][attempt] : 2000 * Math.pow(2, attempt);
        setTimeout(() => fetchCounts(attempt + 1), wait);
      }
    }
  };

  // IDB PAINT (owner spec Nov 9 2026): on load, on a dashboard remount and on a
  // page switch the badge shows the cached counts immediately — no "..." and no
  // network. A server pull only happens when the cached copy is 5+ minutes old.
  useEffect(() => {
    if (!currentUser || !isOwner) return undefined;
    let alive = true;
    (async () => {
      const cached = await readApiCounts();
      if (!alive) return;
      if (cached.hasData) {
        setGoogleCount(cached.google);
        setHereRoutingCount(cached.hereRouting);
        setHereTileCount(cached.hereTiles);
        countsMissingRef.current = false;
        lastFetchAtRef.current = cached.fetchedAt || 0;
      }
      if (needsServerRefresh(cached)) fetchCounts(0);
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser?.id, isOwner]);

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
    let bootWaveFired = false;
    const startFetch = () => { timeoutId = null; idleId = null; fetchCounts(0); };
    timeoutId = setTimeout(() => {
      timeoutId = null;
      if (typeof window.requestIdleCallback === 'function') {
        idleId = window.requestIdleCallback(startFetch, { timeout: 4000 });
      } else {
        startFetch();
      }
    }, 6000);
    // If the main boot data wave finishes before the 6s idle timer, its
    // completion event is the ideal moment: the paced entity reads are done
    // and the quota bucket is free, so fire immediately instead of waiting.
    const onBootWave = () => {
      if (bootWaveFired) return;
      bootWaveFired = true;
      window.removeEventListener('lightweightRefreshComplete', onBootWave);
      if (timeoutId) clearTimeout(timeoutId);
      if (idleId !== null && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(idleId);
      }
      startFetch();
    };
    window.addEventListener('lightweightRefreshComplete', onBootWave);


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
      // Persist the broadcast increment too, so a later load paints from IDB with
      // the numbers this device already saw over the socket.
      bumpApiCounts(category, count).catch(() => {});
    };

    window.addEventListener('realtimeUpdate_GoogleAPILog', handleRealtimeApiLog);

    return () => {
      window.removeEventListener('realtimeUpdate_GoogleAPILog', handleRealtimeApiLog);
      window.removeEventListener('lightweightRefreshComplete', onBootWave);
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
      if (document.visibilityState === 'hidden') return;
      (async () => {
        const cached = await readApiCounts();
        if (cached.hasData) {
          setGoogleCount(cached.google);
          setHereRoutingCount(cached.hereRouting);
          setHereTileCount(cached.hereTiles);
          countsMissingRef.current = false;
        }
        if (needsServerRefresh(cached)) fetchCounts(0);
      })();
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