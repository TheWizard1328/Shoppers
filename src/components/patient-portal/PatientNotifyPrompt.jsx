import React, { useState, useEffect } from 'react';
import { Bell, Loader2, X, Share } from 'lucide-react';
import { getPatientPushState, enablePatientPush, isIosDevice, isStandalonePwa } from './patientPushClient';

/**
 * Slim banner asking the patient to turn on notifications (owner build
 * Nov 2 2026). Push is what makes a pharmacy reply reach them while the portal
 * is closed, so this sits at the top of the portal until it is allowed or
 * dismissed for good.
 */
export default function PatientNotifyPrompt({ patient }) {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(true);

  const dismissKey = patient?.id ? `rxdeliver_patient_push_dismissed_${patient.id}` : null;

  useEffect(() => {
    let cancelled = false;
    if (!dismissKey) return undefined;
    const wasDismissed = localStorage.getItem(dismissKey) === '1';
    setDismissed(wasDismissed);
    if (wasDismissed) return undefined;
    getPatientPushState().then((s) => { if (!cancelled) setState(s); });
    return () => { cancelled = true; };
  }, [dismissKey]);

  if (dismissed || !state || state === 'on' || state === 'unsupported') return null;

  const iosNeedsInstall = state === 'needs-install' || (isIosDevice() && !isStandalonePwa());

  const handleEnable = async () => {
    setBusy(true);
    const res = await enablePatientPush(patient);
    setBusy(false);
    if (res.ok) setState('on');
    else if (res.reason === 'permission') setState('blocked');
    else if (res.reason === 'needs_install') setState('needs-install');
  };

  const handleDismiss = () => {
    if (dismissKey) localStorage.setItem(dismissKey, '1');
    setDismissed(true);
  };

  return (
    <div className="mx-4 mt-3 rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 px-3 py-2 flex items-start gap-2">
      <Bell className="w-4 h-4 text-amber-600 dark:text-amber-400 mt-0.5 flex-shrink-0" />
      <div className="min-w-0 flex-1">
        {iosNeedsInstall ? (
          <p className="text-xs text-amber-800 dark:text-amber-200 leading-snug">
            <span className="font-semibold">Add this page to your Home Screen</span> to get delivery and message
            alerts on iPhone. Tap <Share className="inline w-3 h-3 -mt-0.5" /> Share, then “Add to Home Screen”.
          </p>
        ) : (
          <p className="text-xs text-amber-800 dark:text-amber-200 leading-snug">
            {state === 'blocked'
              ? 'Notifications are blocked for this site. Allow them in your browser settings to get delivery and message alerts.'
              : 'Turn on notifications to hear about your delivery and get pharmacy replies right away.'}
          </p>
        )}
        {!iosNeedsInstall && state !== 'blocked' && (
          <button
            onClick={handleEnable}
            disabled={busy}
            className="mt-1.5 inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg bg-amber-600 text-white text-xs font-semibold disabled:opacity-60"
          >
            {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Bell className="w-3 h-3" />}
            Turn on notifications
          </button>
        )}
      </div>
      <button onClick={handleDismiss} className="w-6 h-6 flex items-center justify-center flex-shrink-0" aria-label="Dismiss">
        <X className="w-3.5 h-3.5 text-amber-700 dark:text-amber-300" />
      </button>
    </div>
  );
}
