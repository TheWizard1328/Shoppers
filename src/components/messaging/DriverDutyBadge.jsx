import React from 'react';

/**
 * Driver duty status chip (owner request Nov 2 2026): a patient choosing who to
 * message must see whether that driver is on duty, on break or off duty.
 */
export const DRIVER_DUTY_LABELS = {
  on_duty: 'On duty',
  on_break: 'On break',
  off_duty: 'Off duty',
};

export const normalizeDriverDuty = (status) => (
  ['on_duty', 'on_break', 'off_duty'].includes(String(status)) ? String(status) : 'off_duty'
);

const STYLES = {
  on_duty: 'bg-green-100 text-green-700 border-green-200 dark:bg-green-950 dark:text-green-300 dark:border-green-800',
  on_break: 'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-800',
  off_duty: 'bg-slate-100 text-slate-500 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700',
};

const DOTS = {
  on_duty: 'bg-green-500',
  on_break: 'bg-amber-500',
  off_duty: 'bg-slate-400',
};

export default function DriverDutyBadge({ status, size = 'sm' }) {
  const key = normalizeDriverDuty(status);
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border ${STYLES[key]} ${size === 'xs' ? 'px-1.5 h-4 text-[10px]' : 'px-2 h-5 text-xs'} font-medium`}>
      <span className={`w-1.5 h-1.5 rounded-full ${DOTS[key]}`} />
      {DRIVER_DUTY_LABELS[key]}
    </span>
  );
}
