import { useEffect, useState } from 'react';
import { Smartphone, X, ArrowUpFromLine } from 'lucide-react';
import { isCapacitorNativeApp, getCapacitorPlatform } from '../utils/locationProviders/capacitorRuntime';

/**
 * ProximityForegroundNudge
 *
 * The proximity auto-foreground feature (see proximityForegroundTrigger.js) can
 * only TRULY bring RxDeliver to the front while the app is backgrounded and the
 * screen is ON when Android's "Display over other apps" special access
 * (SYSTEM_ALERT_WINDOW) is granted — it is an official Background Activity
 * Launch exemption. Without it we fall back to a full-screen-intent
 * notification (auto-opens only when the screen is OFF).
 *
 * Android will never show a runtime dialog for this permission — the user must
 * flip the toggle in system settings. This card nudges the driver once to do
 * that, following the same pattern as BackgroundLocationNudge.
 *
 * Dismissal is snoozed for 7 days via localStorage.
 */

const SNOOZE_KEY = 'rxdeliver_overlay_nudge_snoozed_at';
const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

export default function ProximityForegroundNudge() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const check = () => {
      if (cancelled) return;
      // Native Android APK only
      if (!isCapacitorNativeApp() || getCapacitorPlatform() !== 'android') {
        setVisible(false);
        return;
      }
      const bridge = typeof window !== 'undefined' ? window.AndroidNative : null;
      if (!bridge || typeof bridge.hasOverlayPermission !== 'function') {
        setVisible(false);
        return;
      }
      // Already granted → nothing to do
      try {
        if (bridge.hasOverlayPermission()) {
          setVisible(false);
          return;
        }
      } catch (e) {
        setVisible(false);
        return;
      }
      // Snoozed recently?
      try {
        const snoozedAt = parseInt(localStorage.getItem(SNOOZE_KEY) || '0', 10);
        if (snoozedAt && Date.now() - snoozedAt < SNOOZE_MS) {
          setVisible(false);
          return;
        }
      } catch (e) { /* ignore */ }
      setVisible(true);
    };

    check();
    // Re-check when returning from the settings page (app comes back to front)
    const onVisible = () => { if (!document.hidden) check(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  if (!visible) return null;

  const enableNow = () => {
    try {
      window.AndroidNative?.requestOverlayPermission?.();
    } catch (e) { /* ignore */ }
    // Card hides when the user returns (visibilitychange re-check flips it off)
  };

  const snooze = () => {
    try {
      localStorage.setItem(SNOOZE_KEY, String(Date.now()));
    } catch (e) { /* ignore */ }
    setVisible(false);
  };

  return (
    <div className="fixed left-0 right-0 top-0 z-[9900] px-2 pt-2 pointer-events-none">
      <div className="mx-auto max-w-md rounded-xl border border-amber-300 bg-amber-50 dark:bg-amber-950/80 dark:border-amber-800 shadow-lg p-3 pointer-events-auto">
        <div className="flex items-start gap-2.5">
          <div className="mt-0.5 h-8 w-8 shrink-0 rounded-lg bg-amber-500/15 flex items-center justify-center">
            <ArrowUpFromLine className="h-4 w-4 text-amber-600 dark:text-amber-400" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-amber-900 dark:text-amber-100">
              Auto-foreground at your next stop
            </p>
            <p className="mt-0.5 text-xs text-amber-800/90 dark:text-amber-200/80 leading-snug">
              Grant "Display over other apps" once so RxDeliver can bring itself to the front
              when you approach your next delivery.
            </p>
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                onClick={enableNow}
                className="inline-flex items-center gap-1.5 rounded-md bg-amber-500 hover:bg-amber-600 px-2.5 py-1.5 text-xs font-semibold text-white transition-colors"
              >
                <Smartphone className="h-3.5 w-3.5" />
                Open settings
              </button>
              <button
                type="button"
                onClick={snooze}
                className="rounded-md px-2.5 py-1.5 text-xs font-medium text-amber-800/80 dark:text-amber-200/70 hover:bg-amber-100 dark:hover:bg-amber-900/60 transition-colors"
              >
                Not now
              </button>
            </div>
          </div>
          <button
            type="button"
            onClick={snooze}
            aria-label="Dismiss"
            className="shrink-0 rounded-md p-1 text-amber-800/60 dark:text-amber-200/50 hover:bg-amber-100 dark:hover:bg-amber-900/60 transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
