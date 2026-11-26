import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Bell, BellOff, BellRing, Loader2 } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { WEB_VERSION, BAKED_APK_DIGIT, formatVersionDigits } from '@/version';
import {
  getPatientPushState,
  enablePatientPush,
  disablePatientPush,
  ensurePatientPushRegistered,
  getPushDiagnostics } from
'./patientPushClient';
import { getInAppNotifications, setInAppNotifications } from './patientInAppNotifPref';

const APP_BUILD_LABEL = formatVersionDigits(BAKED_APK_DIGIT, WEB_VERSION);
const BALLOON_MS = 5000;
const BALLOON_MS_ERROR = 9000;

/**
 * Patient notifications control (owner request Nov 3 2026, reworked Nov 25 2026).
 *
 * OWNER REQUEST (Nov 25 2026): "instead of it opening up a drop-down dialog to
 * select the turn on notifications and turn off notifications let's give this
 * button a three-way touch activation. The dot for the status of the
 * notifications let's give it three different colors. Red if the actual app
 * notifications are off and the in app notifications are off as well. Orange if
 * the actual RxDeliver application notifications are on but the in-app
 * notifications are off. Green if they're both on. Toggling between the three
 * states will change the dot and give a brief 5 second pop down balloon stating
 * what's happening."
 *
 * So one tap cycles:  red (both off)  →  orange (phone alerts on, in-app off)
 *                     →  green (both on)  →  red (both off again).
 *
 * Device push state still comes straight from patientPushClient:
 *   on / off / blocked / needs-install / unsupported.
 * The in-app half lives in patientInAppNotifPref (localStorage, default on).
 *
 * Kept from the old panel: the silent boot repair (an Android PWA used to come
 * back unsubscribed after every restart) and the failure explanations, which now
 * land in the balloon. A long press (700ms) on the bell still sends the test
 * notification the old panel had a button for.
 */
export default function PatientNotificationToggle({ patient }) {
  const [state, setState] = useState(null);
  const [inApp, setInApp] = useState(() => getInAppNotifications());
  const [busy, setBusy] = useState(false);
  const [balloon, setBalloon] = useState(null); // { tone, title, message, ms }
  const [anchor, setAnchor] = useState({ top: 64, right: 12 });
  const btnRef = useRef(null);
  const hideTimer = useRef(null);
  const longPressTimer = useRef(null);
  const longPressFired = useRef(false);

  const refresh = useCallback(() => {
    getPatientPushState().then(setState).catch(() => setState('unsupported'));
  }, []);

  useEffect(() => { refresh(); }, [refresh, patient?.id]);

  // The portal came back with notifications OFF on an Android PWA after every
  // restart — repair the registration silently on boot.
  useEffect(() => {
    if (!patient?.id) return undefined;
    let cancelled = false;
    ensurePatientPushRegistered(patient).
    then(() => { if (!cancelled) refresh(); }).
    catch(() => {});
    return () => { cancelled = true; };
  }, [patient?.id, refresh]);

  // Permission may change in the browser/app settings while the patient is away.
  useEffect(() => {
    const onVisible = () => {if (document.visibilityState === 'visible') refresh();};
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);

  // Another tab (or this one) flipping the in-app half keeps the dot honest.
  useEffect(() => {
    const onChange = () => setInApp(getInAppNotifications());
    window.addEventListener('storage', onChange);
    window.addEventListener('rx-patient-inapp-pref', onChange);
    return () => {
      window.removeEventListener('storage', onChange);
      window.removeEventListener('rx-patient-inapp-pref', onChange);
    };
  }, []);

  const NOTICE = {
    permission: 'Notifications were not allowed. Turn them on for this site in your settings, then try again.',
    needs_install: 'On iPhone, add this page to your Home Screen first, then turn notifications on from there.',
    ios_unsupported_browser: 'iPhone only allows notifications from a Safari Home Screen app. Open this page in Safari, add it to your Home Screen, then try again.',
    unsupported: 'This browser cannot show notifications.',
    push_plugin_missing: 'This build of the app has no notification plugin. Update the RxDeliver app and try again.',
    no_token: 'The phone did not return a notification token. Check that notifications are allowed for the RxDeliver app, then try again.',
    register_failed: 'The server could not save this device for notifications. Try again in a moment.',
    no_push_manager: 'This build cannot use web notifications. Update the RxDeliver app and try again.',
    no_vapid_key: 'Notifications are not configured on the server yet.' };

  const showBalloon = useCallback((next) => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setBalloon(next);
    hideTimer.current = setTimeout(() => setBalloon(null), next.ms || BALLOON_MS);
  }, []);

  useEffect(() => () => { if (hideTimer.current) clearTimeout(hideTimer.current); }, []);

  const pushOn = state === 'on';
  const bothOn = pushOn && inApp;
  // Red = both off · amber = phone alerts on, in-app off · green = both on.
  const tone = bothOn ? 'green' : pushOn ? 'amber' : 'red';
  const dotClass =
  tone === 'green' ? 'bg-green-500' :
  tone === 'amber' ? 'bg-amber-500' :
  'bg-red-500';
  const Icon = tone === 'green' ? BellRing : tone === 'amber' ? Bell : BellOff;

  const announce = (nextTone) => {
    showBalloon({
      tone: nextTone,
      title: nextTone === 'green' ? 'All notifications on' : nextTone === 'amber' ? 'Phone alerts on' : 'Notifications off',
      message: nextTone === 'green' ?
      'System notifications: ON · In-app alerts: ON' :
      nextTone === 'amber' ?
      'System notifications: ON · In-app alerts: OFF' :
      'System notifications: OFF · In-app alerts: OFF' });

  };

  const measure = useCallback(() => {
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect) return;
    setAnchor({
      top: Math.round(rect.bottom + 8),
      right: Math.max(8, Math.round(window.innerWidth - rect.right)) });

  }, []);

  useEffect(() => {
    if (!balloon) return undefined;
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [balloon, measure]);

  // OWNER REQUEST (Nov 25 2026): one tap = next state in the three-way cycle.
  const cycle = async () => {
    if (busy) return;
    // iPhone without Add to Home Screen / no web push: explain, do not cycle.
    if (state === 'needs-install' || state === 'unsupported') {
      showBalloon({
        tone: 'red',
        title: 'Notifications unavailable',
        message: NOTICE[state] || NOTICE.unsupported,
        ms: BALLOON_MS_ERROR });

      return;
    }

    if (!pushOn) {
      // RED → ORANGE: ask the phone for permission and subscribe this device.
      setBusy(true);
      let res = { ok: false, reason: 'error' };
      try {
        res = await enablePatientPush(patient);
      } catch (err) {
        res = { ok: false, reason: err?.message || 'error' };
      }
      setBusy(false);
      if (res.ok) {
        setState('on');
        // In-app starts OFF so the patient sees the middle (orange) state.
        setInAppNotifications(false);
        setInApp(false);
        announce('amber');
        return;
      }
      if (res.reason === 'permission') setState('blocked');
      else if (res.reason === 'needs_install') setState('needs-install');
      else if (res.reason === 'ios_unsupported_browser') setState('unsupported');
      showBalloon({
        tone: 'red',
        title: 'Could not turn alerts on',
        message: `${NOTICE[res.reason] || `Could not turn notifications on (${res.reason || 'unknown'}).`} · ${getPushDiagnostics()}`,
        ms: BALLOON_MS_ERROR });

      refresh();
      return;
    }

    if (!inApp) {
      // ORANGE → GREEN: in-app pop-ups back on.
      setInAppNotifications(true);
      setInApp(true);
      announce('green');
      return;
    }

    // GREEN → RED: turn both halves off on this device.
    setBusy(true);
    setInAppNotifications(false);
    setInApp(false);
    await disablePatientPush(patient);
    setBusy(false);
    refresh();
    announce('red');
  };

  // Long press keeps the old panel's test button reachable (owner kept asking
  // whether a device really shows alerts).
  const sendTest = async () => {
    showBalloon({ tone: 'amber', title: 'Sending test', message: 'Test notification on its way to this device…' });
    try {
      const res = await base44.functions.invoke('patientPush', {
        action: 'test',
        patient_id: patient?.id,
        title: 'RxDeliver test',
        body: 'Test notification from your pharmacy' });

      const data = res?.data || res || {};
      const sent = Number(data?.sent || 0);
      const why = data?.errors?.[0] || data?.reason || 'unknown';
      showBalloon({
        tone: sent > 0 ? 'green' : 'red',
        title: sent > 0 ? 'Test sent' : 'Test not delivered',
        message: sent > 0 ? 'It should arrive in a moment.' : `No device accepted it (${why}).`,
        ms: sent > 0 ? BALLOON_MS : BALLOON_MS_ERROR });

    } catch (err) {
      const detail = err?.response?.data?.error || err?.message || 'unknown error';
      showBalloon({ tone: 'red', title: 'Test failed', message: `${APP_BUILD_LABEL}: ${detail}`, ms: BALLOON_MS_ERROR });
    }
  };

  const onPressStart = () => {
    longPressFired.current = false;
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
    longPressTimer.current = setTimeout(() => {
      longPressFired.current = true;
      sendTest();
    }, 700);
  };
  const onPressEnd = () => {
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
    longPressTimer.current = null;
  };

  const toneStyles =
  balloon?.tone === 'green' ?
  { ring: 'border-green-300 dark:border-green-800', dot: 'bg-green-500', text: 'text-green-700 dark:text-green-400' } :
  balloon?.tone === 'amber' ?
  { ring: 'border-amber-300 dark:border-amber-800', dot: 'bg-amber-500', text: 'text-amber-700 dark:text-amber-400' } :
  { ring: 'border-red-300 dark:border-red-800', dot: 'bg-red-500', text: 'text-red-700 dark:text-red-400' };

  const title =
  tone === 'green' ? 'Notifications on' :
  tone === 'amber' ? 'Phone alerts on, in-app off' :
  'Notifications off';

  const pop = (
    <AnimatePresence>
      {balloon &&
      <motion.div
        initial={{ opacity: 0, y: -14, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -14, scale: 0.96 }}
        transition={{ type: 'spring', stiffness: 320, damping: 28 }}
        style={{ position: 'fixed', top: anchor.top, right: anchor.right, zIndex: 2147483000, transformOrigin: 'top right' }}
        onClick={() => setBalloon(null)}
        className={`w-[250px] max-w-[calc(100vw-1.5rem)] rounded-xl border ${toneStyles.ring} bg-white dark:bg-slate-900 shadow-2xl px-3 py-2.5`}>

          <div className="flex items-start gap-2">
            <span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${toneStyles.dot}`} />
            <div className="min-w-0">
              <p className={`text-[13px] font-semibold leading-tight ${toneStyles.text}`}>{balloon.title}</p>
              <p className="mt-0.5 text-[11px] leading-snug text-slate-600 dark:text-slate-300">{balloon.message}</p>
            </div>
          </div>
        </motion.div>
      }
    </AnimatePresence>);


  return (
    <div className="relative">
      <button
        ref={btnRef}
        onClick={() => { if (!longPressFired.current) cycle(); }}
        onTouchStart={onPressStart}
        onTouchEnd={onPressEnd}
        onTouchCancel={onPressEnd}
        onMouseDown={onPressStart}
        onMouseUp={onPressEnd}
        onMouseLeave={onPressEnd}
        onContextMenu={(e) => e.preventDefault()}
        className="relative w-9 h-9 rounded-lg bg-slate-100 dark:bg-slate-800 flex items-center justify-center hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
        title={title}
        aria-label={`${title}. Tap to change.`}>

        {busy ?
        <Loader2 className="w-4 h-4 animate-spin text-slate-500 dark:text-slate-400" /> :
        <Icon className={`w-4 h-4 ${tone === 'green' ? 'text-green-600 dark:text-green-400' : tone === 'amber' ? 'text-amber-600 dark:text-amber-400' : 'text-slate-500 dark:text-slate-400'}`} />}
        <span className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-white dark:border-slate-900 ${dotClass}`} />
      </button>
      {typeof document !== 'undefined' ? createPortal(pop, document.body) : null}
    </div>);

}
