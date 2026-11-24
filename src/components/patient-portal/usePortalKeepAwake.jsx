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

    const publish = () => {
      if (stopped) return;
      setState({
        lock: !!(wakeLock && !wakeLock.released),
        video: !!(videoEl && videoEl.isConnected && !videoEl.paused)
      });
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
        v.style.cssText = 'position:fixed;top:0;left:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:2147483647;';
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
        v.addEventListener('playing', publish);
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
        wakeLock.addEventListener('release', () => {
          wakeLock = null;
          publish();
          if (!stopped && document.visibilityState === 'visible') {
            setTimeout(() => { void requestLock(); }, 200);
          }
        });
      } catch { wakeLock = null; }
      publish();
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
