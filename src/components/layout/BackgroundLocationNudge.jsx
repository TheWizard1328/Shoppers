import { useState, useEffect } from 'react';
import { MapPin, Settings, X } from 'lucide-react';
import { isCapacitorNativeApp, getCapacitorPlatform, openAndroidLocationSettings } from '../utils/locationProviders/capacitorRuntime';

/**
 * BackgroundLocationNudge
 *
 * Shows a non-blocking banner when the driver is on duty on a native Android device
 * and we have reason to believe background location ("Allow all the time") has not
 * been granted. This guides the driver to Settings without blocking GPS tracking.
 *
 * Why we need this:
 * - Android 11+ (API 30+) prohibits apps from directly prompting for background location.
 * - The OS will only ever show "Allow while using app" from a runtime dialog.
 * - "Allow all the time" MUST be set by the user in the app's Settings page.
 * - Without it, the ForegroundService notification never appears and the OS kills GPS
 *   when the app is backgrounded.
 */
export default function BackgroundLocationNudge({ isOnDuty }) {
  const [dismissed, setDismissed] = useState(false);
  const [shouldShow, setShouldShow] = useState(false);

  useEffect(() => {
    if (!isOnDuty || dismissed) {
      setShouldShow(false);
      return;
    }

    // Only relevant on native Android
    if (!isCapacitorNativeApp() || getCapacitorPlatform() !== 'android') {
      setShouldShow(false);
      return;
    }

    // Check via Permissions API whether geolocation was granted.
    // If state is 'granted', foreground is allowed. Android doesn't distinguish
    // foreground vs background here, but we show the nudge anyway because
    // "Allow all the time" is a separate opt-in the user must do manually.
    // We show it once per on-duty session and let them dismiss if they've already done it.
    const checkAndShow = async () => {
      try {
        const result = await navigator.permissions.query({ name: 'geolocation' });
        // If denied, a different error path handles it. We only nudge when granted (foreground only likely).
        if (result.state === 'granted' || result.state === 'prompt') {
          setShouldShow(true);
        }
      } catch (e) {
        // Permissions API not available — show nudge anyway to be safe
        setShouldShow(true);
      }
    };

    checkAndShow();
  }, [isOnDuty, dismissed]);

  if (!shouldShow) return null;

  const handleOpenSettings = async () => {
    await openAndroidLocationSettings();
  };

  return (
    <div className="mx-3 mt-2 mb-1 rounded-lg border border-amber-400 bg-amber-50 px-3 py-2 flex items-start gap-2 shadow-sm">
      <MapPin className="text-amber-500 mt-0.5 shrink-0" size={16} />
      <div className="flex-1 min-w-0">
        <p className="text-xs font-semibold text-amber-800 leading-tight">
          Enable background GPS
        </p>
        <p className="text-xs text-amber-700 mt-0.5 leading-snug">
          Set Location to <strong>"Allow all the time"</strong> in Settings so GPS keeps running when the app is minimised.
        </p>
        <button
          onClick={handleOpenSettings}
          className="mt-1.5 flex items-center gap-1 text-xs font-semibold text-amber-900 underline underline-offset-2"
        >
          <Settings size={12} />
          Open Location Settings
        </button>
      </div>
      <button
        onClick={() => setDismissed(true)}
        className="text-amber-400 hover:text-amber-600 shrink-0 mt-0.5"
        aria-label="Dismiss"
      >
        <X size={14} />
      </button>
    </div>
  );
}
