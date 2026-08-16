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
 */
export default function BackgroundLocationNudge({ isOnDuty }) {
  const [dismissed, setDismissed] = useState(false);
  const [shouldShow, setShouldShow] = useState(false);
  const [bgStatus, setBgStatus] = useState('unknown');

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

  if (!shouldShow) return null;

  const [requesting, setRequesting] = useState(false);

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
    <div className="mx-3 mt-2 mb-1 rounded-lg border border-amber-400 bg-amber-50 dark:bg-amber-950 px-3 py-2 flex items-start gap-2 shadow-sm">
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
  );
}
