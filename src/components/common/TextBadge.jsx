import React, { useEffect, useState } from 'react';
import { updatePatientLocal } from '@/components/utils/entityMutations';

/**
 * "Text" toggle badge (owner spec Nov 10 2026, styled to match the Change badge).
 *
 * Mirrors the Patient Address "Change" badge exactly: same h-6, px-2, rounded-full,
 * text-xs font-medium, same border treatment and the same 1.5rem row height, so
 * the two phone badges line up with it. Word only, no icon.
 *
 * Green (on) means the number accepts SMS, gray (off) means it does not.
 * Toggles sms_primary / sms_secondary on the PATIENT record, so the flag follows
 * the patient into every past, present and future delivery.
 *
 * Disabled when there is no number to text; clearing a number resets its flag.
 */
export const TEXT_BADGE_ON =
  'inline-flex items-center h-6 px-2 rounded-full text-xs font-medium bg-emerald-100 text-emerald-700 hover:bg-emerald-200 border border-emerald-300 transition-colors cursor-pointer select-none';
export const TEXT_BADGE_OFF =
  'inline-flex items-center h-6 px-2 rounded-full text-xs font-medium bg-slate-100 dark:bg-slate-800 text-slate-400 dark:text-slate-400 border border-slate-200 dark:border-slate-700 transition-colors cursor-pointer select-none hover:bg-slate-200 dark:hover:bg-slate-700';
export const TEXT_BADGE_LOCKED =
  'inline-flex items-center h-6 px-2 rounded-full text-xs font-medium bg-slate-100 dark:bg-slate-800 text-slate-400 dark:text-slate-400 border border-slate-200 dark:border-slate-700 cursor-not-allowed select-none opacity-60';

export default function TextBadge({ patient = null, which = 'primary', disabled = false, onChanged = null }) {
  const flagField = which === 'secondary' ? 'sms_secondary' : 'sms_primary';
  const phoneField = which === 'secondary' ? 'phone_secondary' : 'phone';
  const digits = String(patient?.[phoneField] || '').replace(/[^0-9]/g, '');
  const [on, setOn] = useState(patient?.[flagField] === true);
  const [busy, setBusy] = useState(false);

  useEffect(() => { setOn(patient?.[flagField] === true); }, [patient?.[flagField], patient?.id]);

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
    <span
      role="button"
      tabIndex={locked ? -1 : 0}
      title={title}
      onClick={toggle}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(e); } }}
      aria-pressed={on}
      aria-disabled={locked}
      style={{ minHeight: 0, display: 'inline-flex' }}
      className={locked ? TEXT_BADGE_LOCKED : on ? TEXT_BADGE_ON : TEXT_BADGE_OFF}
    >
      Text
    </span>
  );
}
