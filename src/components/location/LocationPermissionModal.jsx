import React, { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { MapPin, Settings, X, CheckCircle2, Loader2 } from 'lucide-react';
import {
  getLocationPermission,
  requestLocationPermission,
  openLocationSettings,
  isLocationGranted,
  LOCATION_PERMISSION_EVENT,
  LOCATION_PERMISSION_NEEDED_EVENT,
} from '@/components/utils/locationPermission';
import { isCapacitorNativeApp } from '@/components/utils/locationProviders/capacitorRuntime';

/**
 * LocationPermissionModal
 * ────────────────────────────────────────────────────────────────────────────
 * OWNER REQUEST (Nov 20 2026): when location is denied or not yet approved,
 * tell the user location is required — "while using the app" on web, "always"
 * on the APK — and give them a button that re-triggers the OS approval instead
 * of making them hunt through settings.
 *
 * Behaviour:
 *  - Granted  → renders nothing.
 *  - Prompt   → shows once per session with an Enable button (a real tap, which
 *               is the only way browsers will show the OS dialog).
 *  - Denied   → shows the settings instructions; Android APK deep-links to the
 *               app's location settings, iOS web can only be told what to tap.
 *  - Re-opens on LOCATION_PERMISSION_NEEDED_EVENT (an action was blocked because
 *    we have no grant), even if dismissed earlier in the session.
 */

const SESSION_DISMISS_KEY = 'rxdeliver_loc_perm_modal_dismissed';

export default function LocationPermissionModal() {
  const [state, setState] = useState(null); // null = not checked yet
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [backgroundGranted, setBackgroundGranted] = useState(null);
  const isNative = isCapacitorNativeApp();

  const evaluate = useCallback(async (opts = {}) => {
    const res = await getLocationPermission(opts);
    setState(res.state);
    setBackgroundGranted(res.backgroundGranted ?? null);
    if (isLocationGranted(res.state)) {
      setOpen(false);
      return res;
    }
    // Defer the popup unless this session has not shown it yet.
    let dismissed = false;
    try { dismissed = sessionStorage.getItem(SESSION_DISMISS_KEY) === '1'; } catch { /* ignore */ }
    if (!dismissed) setOpen(true);
    return res;
  }, []);

  useEffect(() => {
    // Slight delay so the modal never competes with the loading screen.
    const t = setTimeout(() => { evaluate().catch(() => null); }, 2500);
    return () => clearTimeout(t);
  }, [evaluate]);

  useEffect(() => {
    const onChanged = (e) => {
      const s = e?.detail?.state;
      if (!s) return;
      setState(s);
      setBackgroundGranted(e?.detail?.backgroundGranted ?? null);
      if (isLocationGranted(s)) setOpen(false);
    };
    const onNeeded = () => {
      setOpen(true);
      evaluate({ force: true }).catch(() => null);
    };
    window.addEventListener(LOCATION_PERMISSION_EVENT, onChanged);
    window.addEventListener(LOCATION_PERMISSION_NEEDED_EVENT, onNeeded);
    return () => {
      window.removeEventListener(LOCATION_PERMISSION_EVENT, onChanged);
      window.removeEventListener(LOCATION_PERMISSION_NEEDED_EVENT, onNeeded);
    };
  }, [evaluate]);

  // Re-check whenever the app comes back to the foreground (the user may have
  // flipped the switch in Settings and returned).
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible' && !isLocationGranted(state)) {
        evaluate({ force: true }).catch(() => null);
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [evaluate, state]);

  const handleEnable = async () => {
    setBusy(true);
    try {
      const res = await requestLocationPermission();
      setState(res.state);
      setBackgroundGranted(res.backgroundGranted ?? null);
      if (isLocationGranted(res.state)) setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  const handleSettings = async () => {
    const opened = await openLocationSettings();
    if (!opened) {
      // Web / iOS: no deep link exists. Leave the instructions on screen.
      setBusy(false);
    }
  };

  const handleDismiss = () => {
    setOpen(false);
    try { sessionStorage.setItem(SESSION_DISMISS_KEY, '1'); } catch { /* ignore */ }
  };

  if (!open || isLocationGranted(state)) return null;

  const denied = state === 'denied';
  const needsAlways = isNative && backgroundGranted === false;

  return (
    <div className="fixed inset-0 z-[60000] flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-sm rounded-2xl bg-white shadow-2xl overflow-hidden">
        <div className="flex items-start gap-3 p-4 pb-2">
          <div className="mt-0.5 rounded-full bg-amber-100 p-2">
            <MapPin className="h-5 w-5 text-amber-600" />
          </div>
          <div className="flex-1">
            <h2 className="text-base font-semibold text-slate-900">Location is required</h2>
            <p className="mt-1 text-sm text-slate-600">
              {isNative
                ? 'RxDeliver needs location set to “Allow all the time” so deliveries, breadcrumbs and arrival detection work while the app is closed.'
                : 'RxDeliver needs location set to “Allow while using the app” so deliveries, breadcrumbs and arrival detection work.'}
            </p>
          </div>
          <button
            type="button"
            onClick={handleDismiss}
            className="rounded-full p-1 text-slate-400 hover:bg-slate-100"
            aria-label="Dismiss"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {denied && (
          <div className="mx-4 mb-2 rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
            {isNative ? (
              <span>
                Location is currently blocked. Tap <strong>Open settings</strong>, then set Location to
                {' '}<strong>Allow all the time</strong>.
              </span>
            ) : (
              <span>
                Your browser has blocked location for this site. Open the site settings (the
                {' '}<strong>aA</strong> or lock icon in the address bar), set Location to
                {' '}<strong>Allow</strong>, then reload.
              </span>
            )}
          </div>
        )}

        {!denied && needsAlways && (
          <div className="mx-4 mb-2 rounded-lg bg-amber-50 p-3 text-xs text-amber-800">
            Foreground location is on. Set it to <strong>Allow all the time</strong> so GPS keeps
            working in the background.
          </div>
        )}

        <div className="flex flex-col gap-2 p-4 pt-2">
          {!denied && (
            <Button onClick={handleEnable} disabled={busy} className="w-full">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
              <span className="ml-2">{busy ? 'Waiting for approval…' : 'Allow location'}</span>
            </Button>
          )}
          {(denied || needsAlways) && (
            <Button variant="outline" onClick={handleSettings} className="w-full">
              <Settings className="h-4 w-4" />
              <span className="ml-2">{isNative ? 'Open settings' : 'How to allow'}</span>
            </Button>
          )}
          <button
            type="button"
            onClick={handleDismiss}
            className="text-xs text-slate-500 hover:text-slate-700 py-1"
          >
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}
