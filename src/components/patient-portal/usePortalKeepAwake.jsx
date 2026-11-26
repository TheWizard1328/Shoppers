/**
 * usePortalKeepAwake — the patient portal's own screen barrier.
 *
 * OWNER REPORT (Nov 24 2026, 1 AM): "the iPhone is on v2.28.320, i have done a full
 * restart and still the phone screen turns off" — while the staff/driver app on the
 * same phone stays awake. The shared useWakeLockAndVisibility hook is mounted on the
 * portal since w319, so the difference has to be inside it: it is written for an
 * authenticated app shell (it reads locationTracker, currentUser and dataLoaded, and
 * its heartbeat/watchdog timers are tuned to the driver dashboard). Rather than keep
 * guessing which guard is swallowing it in a patient session, the portal gets its own
 * small, unconditional barrier:
 *
 *   • a muted, inline, looping 2x2 video (the only sleep barrier WebKit honours in a
 *     PWA) is created on the FIRST render, before any data loads;
 *   • the Screen Wake Lock is requested immediately and retried on a dense ladder;
 *   • a 1s watchdog re-plays the video and re-requests the lock while the page is
 *     visible, so a silent WebKit pause is repaired within a second;
 *   • every visibility / pageshow / focus / gesture re-arms both paths.
 *
 * It returns the live state so the portal can show a temporary diagnostic badge.
 */
import { useEffect, useState } from 'react';
import { KEEP_AWAKE_VIDEO_SRC } from '@/components/layout/keepAwakeVideo';

const RETRY_LADDER_MS = [
0, 200, 500, 900, 1500, 2200, 3000, 4000, 5000, 6500, 8000, 10000, 13000, 16000,
20000, 25000, 30000, 40000, 50000, 60000];

export function usePortalKeepAwake() {
  const [state, setState] = useState({ lock: false, video: false });

  useEffect(() => {
    let videoEl = null;
    let wakeLock = null;
    let stopped = false;
    const timers = [];

    // OWNER REPORT (Nov 26 2026): fresh restart on the iPhone read "L0 ... T0.2"
    // — no wake lock AND a video clock that was not counting, so both barriers
    // were down. A WebKit video that is paused internally stays "playing" in JS
    // but its clock freezes, so the watchdog now measures advance and rebuilds
    // the element when it stops.
    // OWNER REPORT (Nov 26 2026): the video clock DOES advance (T swings 0.2 to
    // 2.0, its 2s loop), so only the wake lock is missing on the iPhone. Record
    // WHY the request is refused so the badge names the real cause.
    let lockErr = '';
    const shortErr = (e) => {
      const n = String(e?.name || 'ERR');
      if (n === 'NotAllowedError') return 'NA';
      if (n === 'NotSupportedError') return 'NS';
      if (n === 'SecurityError') return 'SE';
      if (n === 'AbortError') return 'AB';
      return n.slice(0, 4);
    };
    let lastClock = -1;
    let stalledTicks = 0;
    let stalled = false;
    const publish = () => {
      if (stopped) return;
      const lockHeld = !!(wakeLock && !wakeLock.released);
      const videoOn = !!(videoEl && videoEl.isConnected && !videoEl.paused);
      // OWNER REQUEST (Nov 25 2026): he tests the iPhone's screen-off bug on this
      // badge, so it also reports the video's readyState, whether it is actually
      // ADVANCING (a stalled WebKit video stays unpaused but stops counting), and
      // whether this browser even has the Wake Lock API.
      const ready = videoEl ? videoEl.readyState : -1;
      const clock = videoEl && Number.isFinite(videoEl.currentTime) ? Math.round(videoEl.currentTime * 10) / 10 : 0;
      const hasWakeLock = typeof navigator !== 'undefined' && 'wakeLock' in navigator;
      setState({ lock: lockHeld, video: videoOn, ready, clock, hasWakeLock, stalled, lockErr });
      // Read by the bell panel's "Screen wake:" line.
      try {
        window.__rxKeepAwake = {
          lock: lockHeld,
          video: videoOn,
          ios: /iphone|ipad|ipod/i.test(navigator.userAgent),
          ready,
          clock,
          hasWakeLock,
          stalled,
          lockErr,
          forced: true,
          at: Date.now(),
        };
      } catch { /* no window */ }
    };

    const startVideo = () => {
      if (stopped || document.visibilityState !== 'visible') return;
      if (videoEl && videoEl.isConnected) {
        if (videoEl.paused || videoEl.ended) {
          const pr = videoEl.play();
          if (pr && pr.catch) pr.catch(() => {});
        }
        return;
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
        // Laid out on screen (iOS suspends a video it thinks is hidden) but invisible
        // to the patient, above every portal overlay (map cards, sheets, dialogs).
        // OWNER REPORT (Nov 26 2026): iOS suspends a 2x2 element it decides is
        // effectively hidden. A real 96x96 box at 1% opacity is invisible to the
        // patient but keeps WebKit's video pipeline alive.
        v.style.cssText = 'position:fixed;top:0;left:0;width:96px;height:96px;opacity:0.01;pointer-events:none;z-index:2147483647;';
        document.body.appendChild(v);
        videoEl = v;
        const play = () => {
          const pr = v.play();
          if (pr && pr.catch) pr.catch(() => {});
        };
        play();
        v.addEventListener('pause', play);
        v.addEventListener('loadeddata', play);
        v.addEventListener('canplay', play);
        v.addEventListener('playing', () => { publish(); void requestLock(); });
        try { window.requestAnimationFrame(play); } catch { /* older webview */ }
      } catch { videoEl = null; }
      publish();
    };

    const requestLock = async () => {
      if (stopped || document.visibilityState !== 'visible') return;
      if (!('wakeLock' in navigator)) { publish(); return; }
      try {
        if (wakeLock && !wakeLock.released) { publish(); return; }
        wakeLock = await navigator.wakeLock.request('screen');
        lockErr = '';
        wakeLock.addEventListener('release', () => {
          wakeLock = null;
          publish();
          if (!stopped && document.visibilityState === 'visible') {
            setTimeout(() => { void requestLock(); }, 200);
          }
        });
      } catch (e) { wakeLock = null; lockErr = shortErr(e); }
      publish();
    };

    // A stalled element never recovers from play(): rebuild it from scratch.
    const rebuildVideo = () => {
      try { if (videoEl) { videoEl.pause(); videoEl.remove(); } } catch { /* detached */ }
      videoEl = null;
      lastClock = -1;
      stalled = false;
      stalledTicks = 0;
      startVideo();
    };

    const armBoth = () => {
      startVideo();
      void requestLock();
    };

    // First render: both paths immediately.
    armBoth();
    RETRY_LADDER_MS.forEach((ms) => timers.push(setTimeout(armBoth, ms)));

    // 1s watchdog: repair a silent WebKit pause / dropped lock within a second.
    const watchdog = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      const live = videoEl && videoEl.isConnected && !videoEl.paused ? Math.round((videoEl.currentTime || 0) * 10) / 10 : -1;
      if (live >= 0 && live === lastClock) {
        stalledTicks += 1;
        if (stalledTicks >= 2) {
          stalled = true;
          publish();
          rebuildVideo();
          void requestLock();
          return;
        }
      } else {
        stalledTicks = 0;
        stalled = false;
      }
      lastClock = live;
      startVideo();
      if (!wakeLock || wakeLock.released) void requestLock();
      publish();
    }, 1000);

    const onVisible = () => {
      if (document.visibilityState === 'visible') armBoth();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pageshow', armBoth);
    window.addEventListener('focus', armBoth);
    window.addEventListener('pointerdown', armBoth, { passive: true });
    window.addEventListener('touchstart', armBoth, { passive: true });
    window.addEventListener('click', armBoth, { passive: true });
    window.addEventListener('keydown', armBoth, { passive: true });

    return () => {
      stopped = true;
      clearInterval(watchdog);
      timers.forEach(clearTimeout);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pageshow', armBoth);
      window.removeEventListener('focus', armBoth);
      window.removeEventListener('pointerdown', armBoth);
      window.removeEventListener('touchstart', armBoth);
      window.removeEventListener('click', armBoth);
      window.removeEventListener('keydown', armBoth);
      try { if (wakeLock) wakeLock.release(); } catch { /* already gone */ }
      try { if (videoEl) { videoEl.pause(); videoEl.remove(); } } catch { /* detached */ }
    };
  }, []);

  return state;
}
