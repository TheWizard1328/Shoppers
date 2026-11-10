import React, { useEffect, useState } from 'react';
import { MessageSquare } from 'lucide-react';
import { updatePatientLocal } from '@/components/utils/entityMutations';

/**
 * "Text" toggle badge (owner spec Nov 10 2026).
 *
 * Sits to the RIGHT of the Pr Phone / Alt Phone labels, in the same label row
 * the Patient Address badge uses, and looks and clicks the same way.
 *
 * Toggles one of two booleans on the PATIENT record:
 *   primary   -> sms_primary
 *   secondary -> sms_secondary
 *
 * Green (true) means this number accepts SMS, gray (false) means it does not.
 * The flag is patient-level on purpose: turning it on applies to every past,
 * present and future delivery for that patient.
 *
 * Disabled when there is no number to text, so the badge can never advertise a
 * number that does not exist. Clearing a number also resets its flag to false.
 */
export default function TextBadge({ patient = null, which = 'primary', disabled = false, onChanged = null }) {
  const flagField = which === 'secondary' ? 'sms_secondary' : 'sms_primary';
  const phoneField = which === 'secondary' ? 'phone_secondary' : 'phone';
  const digits = String(patient?.[phoneField] || '').replace(/[^0-9]/g, '');
  const [on, setOn] = useState(patient?.[flagField] === true);
  const [busy, setBusy] = useState(false);

  useEffect(() => { setOn(patient?.[flagField] === true); }, [patient?.[flagField], patient?.id]);

  // A number that no longer exists can not accept texts.
  useEffect(() => {
    if (digits.length < 7 && patient?.[flagField] === true && patient?.id) {
      updatePatientLocal(patient.id, { [flagField]: false }).catch(() => {});
    }
  }, [digits.length, patient?.id, patient?.[flagField]]);

  const noNumber = digits.length < 7;
  const locked = disabled || busy || noNumber || !patient?.id;

  const toggle = async (e) => {
    e.stopPropagation();
    if (locked) return;
    const next = !on;
    setOn(next);
    setBusy(true);
    try {
      await updatePatientLocal(patient.id, { [flagField]: next });
      if (onChanged) onChanged(next);
    } catch (_) {
      setOn(!next);
    } finally {
      setBusy(false);
    }
  };

  const title = noNumber
    ? 'No number on this patient to text'
    : on
      ? `${which === 'secondary' ? 'Alternate' : 'Primary'} number accepts SMS — click to turn off`
      : `${which === 'secondary' ? 'Alternate' : 'Primary'} number does not accept SMS — click to turn on`;

  return (
    <button
      type="button"
      title={title}
      onClick={toggle}
      disabled={locked}
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold leading-none transition-colors shrink-0 ${on
        ? 'bg-emerald-500 text-white hover:bg-emerald-600'
        : 'bg-slate-200 text-slate-500 hover:bg-slate-300 dark:bg-slate-700 dark:text-slate-300'} ${locked ? 'opacity-40 cursor-not-allowed' : ''}`}
    >
      <MessageSquare className="w-2.5 h-2.5" />
      Text
    </button>
  );
}
