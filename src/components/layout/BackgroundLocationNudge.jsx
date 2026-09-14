import { useState, useEffect } from 'react';
import { MapPin, Settings, X, CheckCircle2 } from 'lucide-react';
import { isCapacitorNativeApp, getCapacitorPlatform, openAndroidLocationSettings, checkNativeGeolocationPermissions, requestBackgroundLocationPermission } from '../utils/locationProviders/capacitorRuntime';

/**
 * BackgroundLocationNudge
 *
 * Shows a non-blocking banner when the driver is on duty on a native Android device
 * and "Allow all the time" background location has NOT been granted.
 *
 * Why we need this:
 * - Android 11+ (API 30+) prohibits apps from directly prompting for background location.
 * - The OS will only ever show "Allow while using app" from a runtime dialog.
 * - "Allow all the time" MUST be set by the user in the app's Settings page.
 * - Without it, the ForegroundService notification never appears and the OS kills GPS
 *   when the app is backgrounded.
 *
 * Uses the @capgo/background-geolocation plugin's checkPermissions() to detect
 * the actual backgroundLocation permission state (granted/prompt/denied).
 *
 * Positioning: fixed + anchored below the real sticky header instead of flowing
 * as a normal header child. It used to render inline inside <header>, but
 * DashboardView's stats-panel wrapper is z-[230] (way above the header's z-50)
 * and starts where the header's static height ends, so the banner ended up
 * painted over by the stats card + driver legend on mobile (2026-09-13,
 * Robert's screenshot). Fixed using the same "measure [data-mobile-header]
 * bottom, render at z-10004" pattern already proven for
 * ProximityForegroundNudge since 2026-09-04.
 */
export default function BackgroundLocationNudge({ isOnDuty }) {
  const [dismissed, setDismissed] = useState(false);
  const [shouldShow, setShouldShow] = useState(false);
  const [bgStatus, setBgStatus] = useState('unknown');
  const [requesting, setRequesting] = useState(false);
  const [topOffset, setTopOffset] = useState(0);

  useEffect(() => {
    if (!isOnDuty || dismissed) {
      setShouldShow(false);
      return;
    }

    if (!isCapacitorNativeApp() || getCapacitorPlatform() !== 'android') {
      setShouldShow(false);
      return;
    }

    const checkAndShow = async () => {
      try {
        const result = await checkNativeGeolocationPermissions();
        const bgLoc = result?.backgroundLocation || 'unknown';
        setBgStatus(bgLoc);

        // Show nudge ONLY if background location is NOT granted
        // (prompt = user hasn't decided, denied = explicitly denied, unknown = can't tell)
        if (bgLoc !== 'granted') {
          setShouldShow(true);
        } else {
          setShouldShow(false);
        }
      } catch (e) {
        // Fallback: use the Web Permissions API as a rough indicator
        try {
          const permResult = await navigator.permissions.query({ name: 'geolocation' });
          if (permResult.state === 'granted' || permResult.state === 'prompt') {
            setShouldShow(true);
            setBgStatus('prompt');
          }
        } catch (e2) {
          setShouldShow(true);
          setBgStatus('unknown');
        }
      }
    };

    checkAndShow();

    // Re-check when the app returns to foreground (user may have just changed the setting)
    const onVisible = () => {
      if (!document.hidden && !dismissed) {
        checkAndShow();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [isOnDuty, dismissed]);

  // Anchor below the real sticky header — same measurement pattern as
  // ProximityForegroundNudge. The banner is `fixed` now (not part of the
  // header's flow), so [data-mobile-header]'s rect is stable.
  useEffect(() => {
    if (!shouldShow) return;
    const measure = () => {
      const header = document.querySelector('[data-mobile-header]');
      setTopOffset(header ? Math.ceil(header.getBoundingClientRect().bottom) : 0);
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('orientationchange', measure);
    // Header height can shift briefly during boot (fonts/icons settling) — a
    // couple of follow-up measures cheaply keep it accurate without polling.
    const t1 = setTimeout(measure, 150);
    const t2 = setTimeout(measure, 500);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('orientationchange', measure);
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [shouldShow]);

  if (!shouldShow) return null;

  const handleEnable = async () => {
    setRequesting(true);
    try {
      // Try the direct system dialog first — on Android 10+, this shows
      // the "Allow all the time" prompt without leaving the app.
      const result = await requestBackgroundLocationPermission();
      if (result?.backgroundLocation === 'granted') {
        setShouldShow(false);
        return;
      }
      // If the dialog didn't grant it (user denied or device doesn't support
      // the direct dialog), fall back to opening the Settings page.
      await openAndroidLocationSettings();
    } catch (e) {
      // Final fallback — open Settings
      await openAndroidLocationSettings();
    } finally {
      setRequesting(false);
    }
  };

  return (
    // z-[10004]: matches ProximityForegroundNudge — above the top-anchored
    // banner stack AND, crucially, above DashboardView's stats-panel wrapper
    // (z-[230]) so the stats card / driver legend can never paint over it.
    // data-bg-location-nudge lets ProximityForegroundNudge stack itself below
    // this banner when both are visible at once.
    <div
      data-bg-location-nudge
      className="fixed left-0 right-0 z-[10004] px-3 pt-2"
      style={{ top: `${topOffset}px` }}
    >
      <div className="mx-auto max-w-md rounded-lg border border-amber-400 bg-amber-50 dark:bg-amber-950 px-3 py-2 flex items-start gap-2 shadow-lg">
        <MapPin className="text-amber-500 mt-0.5 shrink-0" size={18} />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold text-amber-800 leading-tight">
            Enable Always-On GPS
          </p>
          <p className="text-xs text-amber-700 mt-0.5 leading-snug">
            Location is set to <strong>"Allow only while using the app"</strong>.
            Tap below, go to Permissions &rarr; Location, and select <strong>"Allow all the time"</strong>
            so GPS keeps running when the app is minimised.
          </p>
          <button
            onClick={handleEnable}
            disabled={requesting}
            className="mt-1.5 flex items-center gap-1.5 text-xs font-semibold text-amber-900 bg-amber-200 dark:bg-amber-800 dark:text-amber-100 rounded-md px-2.5 py-1 hover:bg-amber-300 dark:hover:bg-amber-700 transition-colors disabled:opacity-50"
          >
            <Settings size={14} />
            {requesting ? 'Requesting…' : 'Enable Always-On GPS'}
          </button>
        </div>
        <button
          onClick={() => setDismissed(true)}
          className="text-amber-400 hover:text-amber-600 shrink-0 mt-0.5"
          aria-label="Dismiss"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
}
