import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Bell, BellOff, BellRing, Loader2, Share, X } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { WEB_VERSION, BAKED_APK_DIGIT, formatVersionDigits } from '@/version';

const APP_BUILD_LABEL = formatVersionDigits(BAKED_APK_DIGIT, WEB_VERSION);
import {
  getPatientPushState,
  enablePatientPush,
  disablePatientPush,
  isIosDevice,
  isStandalonePwa,
  ensurePatientPushRegistered,
  getPushDiagnostics } from
'./patientPushClient';

/**
 * Patient notifications control (owner request Nov 3 2026).
 *
 * The one-off banner could only ever ask ONCE and then vanished for good, so a
 * patient who dismissed it, blocked the prompt, or later wanted it off had no way
 * back in. This is the permanent control: a bell in the portal header that shows
 * the live state of THIS device and lets the patient turn notifications on or off
 * at any time.
 *
 * States come straight from patientPushClient:
 *   on            green bell  — this device is subscribed
 *   off           amber bell  — supported, permission not granted yet
 *   blocked       red bell    — permission denied in the browser/app settings
 *   needs-install grey bell   — iPhone without Add to Home Screen
 *   unsupported   grey bell   — no web push in this browser (e.g. some APK WebViews)
 */
export default function PatientNotificationToggle({ patient }) {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  // OWNER REPORT (Nov 25 2026): a failed turn-on used to be silent — the panel just
  // re-read the state and looked like the tap did nothing. Every reason is shown.
  const [notice, setNotice] = useState('');

  const refresh = useCallback(() => {
    getPatientPushState().then(setState).catch(() => setState('unsupported'));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh, patient?.id]);

  // OWNER REPORT (Nov 25 2026): the portal came back with notifications OFF on an
  // Android PWA after every restart. Repair the registration silently on boot so
  // an already-granted device stays registered and the toggle stays green.
  useEffect(() => {
    if (!patient?.id) return undefined;
    let cancelled = false;
    ensurePatientPushRegistered(patient)
      .then(() => { if (!cancelled) refresh(); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [patient?.id, refresh]);

  // Re-read the state whenever the patient comes back to the tab — permission may
  // have been changed in the browser/app settings while they were away.
  useEffect(() => {
    const onVisible = () => {if (document.visibilityState === 'visible') refresh();};
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);

  const NOTICE = {
    permission: 'Notifications were not allowed. Turn them on for this site in your settings, then try again.',
    needs_install: 'On iPhone, add this page to your Home Screen first, then turn notifications on from there.',
    ios_unsupported_browser: 'iPhone only allows notifications from a Safari Home Screen app. Open this page in Safari, add it to your Home Screen, then try again.',
    unsupported: 'This browser cannot show notifications.',
    push_plugin_missing: 'This build of the app has no notification plugin. Update the RxDeliver app and try again.',
    no_token: 'The phone did not return a notification token. Check that notifications are allowed for the RxDeliver app, then try again.',
    register_failed: 'The server could not save this device for notifications. Try again in a moment.',
    no_push_manager: 'This build cannot use web notifications. Update the RxDeliver app and try again.',
    push_plugin_missing: 'This build of the app has no notification plugin. Update the RxDeliver app, then try again.',
    no_vapid_key: 'Notifications are not configured on the server yet.',
  };

  // OWNER REQUEST (Nov 25 2026): a one-tap test so a device can prove it really
  // shows an alert, instead of waiting for a delivery push to guess.
  const handleTest = async () => {
    setBusy(true);
    setNotice('');
    try {
      // OWNER REPORT (Nov 25 2026): 'test' is now a public action (above the
      // auth.me() gate), because a patient is not a Base44 user. 'send' stays
      // staff-only, so the test must not ride it.
      const res = await base44.functions.invoke('patientPush', {
        action: 'test',
        patient_id: patient?.id,
        title: 'RxDeliver test',
        body: 'Test notification from your pharmacy',
      });
      const data = res?.data || res || {};
      const sent = Number(data?.sent || 0);
      const why = data?.errors?.[0] || data?.reason || 'unknown';
      setNotice(sent > 0
        ? 'Test sent. It should arrive in a moment.'
        : `No device accepted it (${why}).`);
    } catch (err) {
      // OWNER REPORT (Nov 25 2026): the notice said only "status code 500", which
      // could not tell a stale bundle apart from a real server error. The build
      // that ran the tap is now part of the message.
      const status = err?.response?.status || err?.status || '';
      const detail = err?.response?.data?.error || err?.response?.data?.errors?.[0] || err?.message || 'unknown error';
      setNotice(`Test failed on ${APP_BUILD_LABEL}${status ? ` (${status})` : ''}: ${detail}`);
    }
    setBusy(false);
  };

  const handleEnable = async () => {
    setBusy(true);
    setNotice('');
    let res = { ok: false, reason: 'error' };
    try {
      res = await enablePatientPush(patient);
    } catch (err) {
      res = { ok: false, reason: err?.message || 'error' };
    }
    setBusy(false);
    if (res.ok) { setState('on'); setNotice(''); return; }
    if (res.reason === 'permission') setState('blocked');
    else if (res.reason === 'needs_install') setState('needs-install');
    else if (res.reason === 'ios_unsupported_browser') setState('unsupported');
    setNotice(`${NOTICE[res.reason] || `Could not turn notifications on (${res.reason || 'unknown'}).`} · ${getPushDiagnostics()}`);
    refresh();
  };

  const handleDisable = async () => {
    setBusy(true);
    await disablePatientPush(patient);
    setBusy(false);
    refresh();
  };

  const iosNeedsInstall = state === 'needs-install' || state !== 'on' && isIosDevice() && !isStandalonePwa();

  const Icon = state === 'on' ? BellRing : state === 'off' ? Bell : BellOff;
  const dotClass = state === 'on' ?
  'bg-green-500' :
  state === 'off' || state === 'blocked' ?
  'bg-amber-500' :
  'bg-slate-400';
  const title = state === 'on' ?
  'Notifications are on' :
  state === 'blocked' ?
  'Notifications are blocked' :
  'Turn on notifications';

  // ── SLIDE-OUT ANCHOR (owner request Nov 3 2026) ──────────────────────────
  // The old panel was an in-flow popover inside the header, which sits in a
  // z-10 stacking context, so the Leaflet map painted straight over it. The
  // panel is now rendered into document.body with a fixed position measured
  // from the bell, giving it its own top layer, and it slides out from this
  // top corner instead of floating over the page.
  const btnRef = useRef(null);
  const [anchor, setAnchor] = useState({ top: 64, right: 12 });

  const measure = useCallback(() => {
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect) return;
    setAnchor({
      top: Math.round(rect.bottom + 8),
      right: Math.max(8, Math.round(window.innerWidth - rect.right)),
    });
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    measure();
    const onScrollOrResize = () => measure();
    window.addEventListener('resize', onScrollOrResize);
    window.addEventListener('scroll', onScrollOrResize, true);
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    const onDown = (e) => {
      if (btnRef.current?.contains(e.target)) return;
      if (e.target?.closest?.('[data-patient-notify-panel]')) return;
      setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    return () => {
      window.removeEventListener('resize', onScrollOrResize);
      window.removeEventListener('scroll', onScrollOrResize, true);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
    };
  }, [open, measure]);

  const panel = (
    <AnimatePresence>
      {open && (
        <motion.div
          data-patient-notify-panel="true"
          initial={{ opacity: 0, y: -14, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -14, scale: 0.96 }}
          transition={{ type: 'spring', stiffness: 320, damping: 28 }}
          style={{ position: 'fixed', top: anchor.top, right: anchor.right, zIndex: 2147483000, transformOrigin: 'top right' }}
          className="w-72 max-w-[calc(100vw-1.5rem)] rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-2xl p-3"
        >
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">Notifications</p>
            <button
              onClick={() => setOpen(false)}
              className="w-6 h-6 rounded-md flex items-center justify-center text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
              aria-label="Close"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          {state === null && (
            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">Checking this device…</p>
          )}

          {state === 'on' && (
            <>
              <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                This device gets a phone alert when your pharmacy replies or when your delivery is on the way.
              </p>
              {/* OWNER REPORT (Nov 25 2026): the portal screen still slept. This
                  readout says whether the wake lock or the barrier video is
                  actually holding, so a device can be diagnosed without a console. */}
              <p className="mt-1 text-[10px] leading-tight text-slate-400 dark:text-slate-500">
                {(() => {
                  const k = typeof window !== 'undefined' ? window.__rxKeepAwake : null;
                  if (!k) return 'Screen wake: not armed yet';
                  return `Screen wake: ${k.lock ? 'lock held' : 'no lock'} · ${k.video ? 'video on' : 'no video'}${k.ios ? ' · iOS' : ''}`;
                })()}
              </p>
              <button
                onClick={handleTest}
                disabled={busy}
                className="mt-2 w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-blue-700 hover:bg-blue-800 text-white text-sm font-semibold disabled:opacity-60"
              >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <BellRing className="w-4 h-4" />}
                Send a test notification
              </button>
              <button
                onClick={handleDisable}
                disabled={busy}
                className="mt-2 w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-sm font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-60"
              >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <BellOff className="w-4 h-4" />}
                Turn off on this device
              </button>
            </>
          )}

          {(state === 'off' || state === 'blocked') && (
            <>
              <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                {state === 'blocked'
                  ? 'Your browser or app has notifications blocked for this site. Allow them in the site settings (the padlock next to the address), then try again.'
                  : 'Turn these on to get a phone alert when your pharmacy replies or your delivery is on the way.'}
              </p>
              <button
                onClick={handleEnable}
                disabled={busy}
                className="mt-2 w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-blue-700 hover:bg-blue-800 text-white text-sm font-semibold disabled:opacity-60"
              >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <BellRing className="w-4 h-4" />}
                {state === 'blocked' ? 'Try again' : 'Turn on notifications'}
              </button>
            </>
          )}

          {!!notice && (
            <p className="mt-2 text-xs font-medium text-amber-700 dark:text-amber-300">{notice}</p>
          )}

          {iosNeedsInstall && (
            <>
              <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                On iPhone, notifications only work after adding this page to your Home Screen.
              </p>
              <p className="mt-1 flex items-center gap-1.5 text-xs font-medium text-slate-600 dark:text-slate-300">
                <Share className="w-3.5 h-3.5" /> Share, then Add to Home Screen
              </p>
            </>
          )}

          {state === 'unsupported' && (
            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
              This browser cannot show notifications. Open the portal in Chrome or Safari, or in the RxDeliver app, to turn them on.
            </p>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );

  return (
    <div className="relative">
      <button
        ref={btnRef}
        onClick={() => setOpen((v) => !v)}
        className="relative w-9 h-9 rounded-lg bg-slate-100 dark:bg-slate-800 flex items-center justify-center hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
        title={title}
        aria-label={title}
        aria-expanded={open}
      >
        <Icon className={`w-4 h-4 ${state === 'on' ? 'text-green-600 dark:text-green-400' : 'text-slate-500 dark:text-slate-400'}`} />
        <span className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-white dark:border-slate-900 ${dotClass}`} />
      </button>
      {typeof document !== 'undefined' ? createPortal(panel, document.body) : null}
    </div>
  );
}
