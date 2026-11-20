import { useEffect, useRef } from 'react';
import { format } from 'date-fns';
import { globalFilters } from '../utils/globalFilters';
import { smartRefreshManager } from '../utils/smartRefreshManager';
import { locationTracker } from '../utils/locationTracker';
import { remoteLogger } from '../utils/remoteLogger';
import { KEEP_AWAKE_VIDEO_SRC } from './keepAwakeVideo';

/**
 * Manages Wake Lock API and visibility change handling.
 * Triggers background sync when app regains focus after being hidden.
 */
export function useWakeLockAndVisibility({
  currentPageName,
  initialGlobalFiltersSet,
  currentUser,
  dataLoaded,
  isFormOverlayOpen,
  stores
}) {
  const wakeLockRef = useRef(null);
  const keepAwakeVideoRef = useRef(null);
  const keepAwakeDiagRef = useRef(false);
  // iOS never reliably holds a screen wake lock, so it keeps the video barrier
  // running alongside the lock instead of after it (see w29 note below).
  const isIOSDeviceRef = useRef(
    /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (/macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1)
  );
  const appFocusLostAtRef = useRef(null);
  const SMART_REFRESH_CYCLE = 15000;

  useEffect(() => {
    let batteryRef = null;

    // ── iOS KEEP-AWAKE FALLBACK (Nov 15 2026) ───────────────────────────────
    // A muted, inline, looping video is the only sleep barrier WebKit honours
    // consistently in a PWA. Started whenever the Screen Wake Lock API is
    // missing, refused, or released, and torn down as soon as the real lock is
    // held again so it never competes with it.
    // iOS KEEP-AWAKE FIX #2 (owner report Nov 15 2026: "it only keeps the screen on
    // once another form is open, never on the dashboard after a restart or refresh"):
    // the old version early-returned whenever an element already existed, so a video
    // that iOS had silently paused could never be revived - the dashboard sat there
    // holding a dead element while opening a form (a real touch) re-armed everything.
    // It now always nudges play() on the existing element, and rebuilds it if it was
    // detached from the DOM.
    const startKeepAwakeVideo = () => {
      if (document.visibilityState !== 'visible') return;
      const existing = keepAwakeVideoRef.current;
      if (existing) {
        if (existing.isConnected) {
          if (existing.paused || existing.ended) { try { existing.play().catch(() => {}); } catch {} }
          return;
        }
        try { existing.remove(); } catch {}
        keepAwakeVideoRef.current = null;
      }
      try {
        const v = document.createElement('video');
        v.setAttribute('playsinline', '');
        v.setAttribute('webkit-playsinline', '');
        v.muted = true;
        v.defaultMuted = true;
        v.loop = true;
        v.autoplay = true;
        v.preload = 'auto';
        v.src = KEEP_AWAKE_VIDEO_SRC;
        // 2x2 inside the viewport (NOT offscreen and NOT z-index:-1): iOS
        // suspends a video it considers hidden, so it must be laid out on screen
        // while staying invisible to the user.
        // z-index above the stop cards (10000), the forms (60000) and every dialog:
        // iOS pauses a video it decides is covered, and the dashboard is wall-to-wall
        // overlays, which is exactly why the barrier died there and survived in a form.
        v.style.cssText = 'position:fixed;top:0;left:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:2147483647;';
        document.body.appendChild(v);
        keepAwakeVideoRef.current = v;
        const play = () => { const pr = v.play(); if (pr && pr.catch) pr.catch(() => {}); };
        play();
        v.addEventListener('pause', play);
      } catch { keepAwakeVideoRef.current = null; }
    };

    const stopKeepAwakeVideo = () => {
      const v = keepAwakeVideoRef.current;
      keepAwakeVideoRef.current = null;
      if (v) { try { v.pause(); v.remove(); } catch {} }
    };

    const requestWakeLock = async () => {
      if (document.visibilityState !== 'visible') return;
      if (!('wakeLock' in navigator)) { startKeepAwakeVideo(); return; }
      try {
        // For on-duty drivers, keep the wake lock active regardless of battery level.
        // GPS tracking for active deliveries is mission-critical.
        const isOnDuty = locationTracker?.isTracking && locationTracker?.driverStatus === 'on_duty';
        if (!isOnDuty && 'getBattery' in navigator) {
          const battery = await navigator.getBattery();
          if (battery.level * 100 < 25 && !battery.charging) return;
        }
        wakeLockRef.current = await navigator.wakeLock.request('screen');
        // w29 (owner report Nov 15 2026: "the screen still keeps shutting off"):
        // iOS GRANTS the lock (hasWakeLock true on the iPhone, OS 18.7) and then
        // drops it silently without firing 'release'. Stopping the video here
        // removed the only barrier that actually worked, so on iOS the video now
        // stays up for as long as the app is visible, lock or no lock.
        if (!isIOSDeviceRef.current) stopKeepAwakeVideo();
        // iOS KEEP-AWAKE FIX (owner report Nov 15 2026): iOS releases the screen
        // wake lock on its own - on backgrounding, on a lock/unlock, and after a
        // period of no interaction - and it never re-acquires itself. The old
        // no-op release listener meant the screen then slept until a reload, which
        // is why keep-awake "does not work on iOS". Re-acquire straight away.
        wakeLockRef.current.addEventListener('release', () => {
          wakeLockRef.current = null;
          if (document.visibilityState === 'visible') setTimeout(() => { ensureWakeLock(); }, 250);
        });
      } catch {
        // API missing, refused or threw: fall back to the looping video.
        startKeepAwakeVideo();
      }
      if (!wakeLockRef.current && 'wakeLock' in navigator) startKeepAwakeVideo();
      if (!('wakeLock' in navigator)) startKeepAwakeVideo();
      // iOS: arm the video barrier straight away, in parallel with the lock.
      if (isIOSDeviceRef.current) startKeepAwakeVideo();
      if (!keepAwakeDiagRef.current) {
        keepAwakeDiagRef.current = true;
        try {
          remoteLogger.warn('[KEEP_AWAKE] capability', {
            hasWakeLock: 'wakeLock' in navigator,
            hasGetBattery: 'getBattery' in navigator,
            standalone: window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true,
            videoFallback: !!keepAwakeVideoRef.current,
            ua: navigator.userAgent
          });
        } catch {}
      }
    };

    const releaseWakeLock = () => {
      if (wakeLockRef.current) { wakeLockRef.current.release(); wakeLockRef.current = null; }
    };

    // Re-requests the lock unless we already hold a live one. Used by the
    // release handler, the heartbeat below and the first user gesture.
    const ensureWakeLock = async () => {
      if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
      const held = wakeLockRef.current;
      if (held && !held.released) return;
      wakeLockRef.current = null;
      await requestWakeLock();
    };

    const setupBatteryMonitoring = async () => {
      if (!('getBattery' in navigator)) return;
      try {
        batteryRef = await navigator.getBattery();
        const check = () => {
          const level = batteryRef.level * 100;
          const isOnDuty = locationTracker?.isTracking && locationTracker?.driverStatus === 'on_duty';
          if (level < 25 && !batteryRef.charging && wakeLockRef.current && !isOnDuty) releaseWakeLock();
          else if ((level >= 25 || batteryRef.charging || isOnDuty) && !wakeLockRef.current && document.visibilityState === 'visible') requestWakeLock();
        };
        batteryRef.addEventListener('levelchange', check);
        batteryRef.addEventListener('chargingchange', check);
      } catch {}
    };

    setupBatteryMonitoring();

    const handleVisibilityChange = async () => {
      if (document.visibilityState === 'visible') {
        await requestWakeLock();
        if (appFocusLostAtRef.current) {
          const hiddenDuration = Date.now() - appFocusLostAtRef.current;
          appFocusLostAtRef.current = null;

          if (locationTracker.isTracking && locationTracker.isPrimaryDevice) {
            // Primary device: push a fresh GPS fix so the online+offline DB are immediately current.
            locationTracker.refreshNow({ source: 'visibility-return' }).catch(() => {});
          } else if (!locationTracker.isPrimaryDevice) {
            // Non-primary device: reload AppUsers from offline DB and broadcast so markers
            // reflect the latest persisted location data without waiting for a WebSocket event.
            // CRITICAL: Only broadcast records that have NOT been updated via WebSocket in the
            // last 10 seconds. The WebSocket path (realtimeSync) already wrote the freshest
            // coords to the offline DB and dispatched driverLocationsUpdated with the real
            // timestamp. If we broadcast the entire IDB snapshot unconditionally here, records
            // without a real location_updated_at get stamped as ts=0 by mergeVisibleDriversByFreshness
            // and are correctly ignored — but records that DO have a real (older) timestamp can
            // still win the freshness race if the WS event hasn't arrived yet for this device,
            // causing the marker to snap back to the last persisted position mid-animation.
            // Gating on __wsAppUserLastUpdate prevents the IDB snapshot from racing the live WS stream.
            import('../utils/offlineDatabase').then(({ offlineDB }) => {
              offlineDB.getAll(offlineDB.STORES.APP_USERS).then((allAppUsers) => {
                if (!allAppUsers || allAppUsers.length === 0) return;
                const now = Date.now();
                const WS_GRACE_MS = 10000; // suppress IDB broadcast for drivers updated via WS in last 10s
                const wsLastUpdate = window.__wsAppUserLastUpdate || new Map();
                // Only include drivers whose last WS update was more than WS_GRACE_MS ago
                // (i.e., the WS stream is not actively delivering fresh coords for them).
                const staleOrUnseenAppUsers = allAppUsers.filter((au) => {
                  if (!au?.id) return false;
                  const key = au.user_id || au.id;
                  const lastWs = wsLastUpdate.get(key) || 0;
                  return (now - lastWs) >= WS_GRACE_MS;
                });
                if (staleOrUnseenAppUsers.length > 0) {
                  window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
                    detail: { appUsers: staleOrUnseenAppUsers, fromOfflineDB: true, mergeMode: 'merge' }
                  }));
                }
              }).catch(() => {});
            }).catch(() => {});
          }

          // Signal BLE consumers to reconnect and take a fresh reading after any absence
          window.dispatchEvent(new CustomEvent('appVisibilityRestored', {
            detail: { hiddenDurationMs: hiddenDuration }
          }));

          // Resume priority sync: fires on ANY page whenever the app resumes from
          // background / minimize / screen-on. Only gate kept is the 15s
          // hidden-duration gate (sub-15s background blips — notifications shade,
          // quick app switches — don't need a re-sync). The form-overlay gate was
          // removed per owner: the sync must ALWAYS run on resume, even with a
          // dialog open — the priority sync is merge-only, so it can't corrupt
          // form state.
          // ONE burst per resume: the SmartRefresh zeroing that used to run here
          // was removed — it forced every SmartRefresh entity to re-fetch on top
          // of the priority sync (double burst → 429s). SmartRefresh keeps its
          // own normal cadence; the forced priority sync is the single resume sync.
          if (hiddenDuration >= SMART_REFRESH_CYCLE && currentUser && dataLoaded) {
            const selectedDateStr = globalFilters.getSelectedDate() || format(new Date(), 'yyyy-MM-dd');
            const selectedCityId = globalFilters.getSelectedCityId();
            const cityIdForSync = selectedCityId && selectedCityId !== 'all' && selectedCityId !== 'waiting-for-selection' ? selectedCityId : null;
            import('../utils/offlineSync').then(({ loadPriorityDataForced }) => {
              loadPriorityDataForced(selectedDateStr, cityIdForSync).catch(() => {});
            }).catch(() => {});
          }
        }
      } else {
        appFocusLostAtRef.current = Date.now();
        releaseWakeLock();
        stopKeepAwakeVideo();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    if (document.visibilityState === 'visible') requestWakeLock();

    // iOS silently drops the wake lock (no event, terminated sentinel) and also
    // suspends a video it thinks is idle. The heartbeat therefore (a) revives the
    // video, (b) re-requests the lock, and (c) forces a brand new lock every
    // third tick, because a sentinel can read as live in JS while iOS has already
    // stopped honouring it - that silent drop is what still let the screen sleep.
    // iOS-only watchdog: every 5s confirm the barrier video is attached, playing and
    // actually decoding. Two consecutive stalled ticks (iOS pause with no event, or a
    // refresh where autoplay was refused before the first touch) rebuild it from scratch.
    let videoStalls = 0;
    const videoWatchdog = isIOSDeviceRef.current ? setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      const v = keepAwakeVideoRef.current;
      if (!v || !v.isConnected) { videoStalls = 0; startKeepAwakeVideo(); return; }
      if (v.paused || v.ended) { try { v.play().catch(() => {}); } catch {} }
      if (v.readyState < 2) {
        videoStalls += 1;
        if (videoStalls >= 2) { videoStalls = 0; stopKeepAwakeVideo(); setTimeout(() => startKeepAwakeVideo(), 60); }
      } else {
        videoStalls = 0;
      }
    }, 5000) : null;

    // A PWA refresh / bfcache restore fires pageshow after the effect has run; iOS has
    // dropped everything by then, so re-arm both the lock and the barrier video.
    const handlePageShow = () => {
      if (document.visibilityState !== 'visible') return;
      if (isIOSDeviceRef.current) startKeepAwakeVideo();
      ensureWakeLock().catch(() => {});
    };
    window.addEventListener('pageshow', handlePageShow);
    window.addEventListener('focus', handlePageShow);

    let wakeTick = 0;
    const wakeHeartbeat = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      wakeTick += 1;
      const v = keepAwakeVideoRef.current;
      if (isIOSDeviceRef.current) {
        if (!v) startKeepAwakeVideo();
        else if (v.paused) { try { v.play().catch(() => {}); } catch {} }
      }
      if (isIOSDeviceRef.current && wakeTick % 3 === 0) {
        releaseWakeLock();
        setTimeout(() => { ensureWakeLock().catch(() => {}); }, 50);
      } else {
        ensureWakeLock().catch(() => {});
      }
      // Evidence for the hourly digest: every 5 minutes, say what is actually
      // holding the screen so a sleeping device can be diagnosed from logs.
      if (wakeTick % 15 === 0) {
        try {
          // INFO, not WARN (owner Nov 19 2026): this heartbeat fires every 5
          // minutes on every device and was a third of the hourly warning
          // noise. It is still recorded for diagnosis, just no longer counted
          // as a warning.
          remoteLogger.info('[KEEP_AWAKE] state', {
            lock: wakeLockRef.current ? (wakeLockRef.current.released ? 'released' : 'held') : 'none',
            video: keepAwakeVideoRef.current ? (keepAwakeVideoRef.current.paused ? 'paused' : 'playing') : 'absent',
            ios: isIOSDeviceRef.current,
            hidden: document.visibilityState !== 'visible'
          });
        } catch {}
      }
    }, 20000);
    const gestureRetry = () => {
      // Owner report Nov 15 2026: keep-awake started working the moment a form was
      // opened. That was this gap — the retry only called ensureWakeLock(), which
      // returns early while the (silently ignored) iOS lock still looks held, so the
      // paused video was never restarted. Touch now re-arms both paths unconditionally.
      if (isIOSDeviceRef.current) startKeepAwakeVideo();
      ensureWakeLock().catch(() => {});
    };
    window.addEventListener('pointerdown', gestureRetry, { passive: true });
    window.addEventListener('touchstart', gestureRetry, { passive: true });

    return () => {
      stopKeepAwakeVideo();
      clearInterval(wakeHeartbeat);
      if (videoWatchdog) clearInterval(videoWatchdog);
      window.removeEventListener('pageshow', handlePageShow);
      window.removeEventListener('focus', handlePageShow);
      window.removeEventListener('pointerdown', gestureRetry);
      window.removeEventListener('touchstart', gestureRetry);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      releaseWakeLock();
    };
  }, [currentUser, dataLoaded]); // resume-sync effect: only these are read inside
}