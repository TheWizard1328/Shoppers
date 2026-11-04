import { addMinutesToTime } from '@/components/dashboard/DashboardHelpers';

/**
 * OWNER DIAGNOSIS (Nov 4 2026): "Beverly and Londonderry are in the wrong
 * order. When the care pro deliveries were created they all have patient start
 * times at 4:00 p.m. but when they were transitioned from Staged to pending
 * they all got delivery start times for 12:05 — five minutes after the
 * Callingwood ETA. They should have been set with the patient delivery start
 * times when they were transitioned to pending, and double checked when the
 * route is accepted."
 *
 * So: the patient's OWN window is the truth at Staged -> pending, and a
 * pickup-derived time (pickup start + 5 or pickup ETA + 5) is never the
 * patient's instruction. A window a dispatcher typed on the delivery still
 * wins at acceptance — only auto-derived values are re-checked.
 */

const norm = (v) => String(v || '').trim().slice(0, 5);

/** True when `value` looks auto-stamped from the pickup rather than typed. */
export function isPickupDerivedWindow(value, pickup) {
  const v = norm(value);
  if (!v) return true;
  if (!pickup) return false;
  const candidates = [pickup.delivery_time_start, pickup.delivery_time_eta, pickup.estimated_arrival]
    .filter(Boolean)
    .map((t) => norm(addMinutesToTime(t, 5)));
  return candidates.includes(v);
}

/**
 * Force the patient's window onto a delivery. Used when a stop moves from
 * Staged to pending: the patient's start/end ARE the instruction.
 * Returns a new object (never mutates the input).
 */
export function applyPatientWindowOnPending(delivery, patient) {
  if (!delivery || !patient?.time_window_start) return delivery;
  const next = { ...delivery };
  next.delivery_time_start = norm(patient.time_window_start) || delivery.delivery_time_start;
  if (patient.time_window_end) next.delivery_time_end = norm(patient.time_window_end) || delivery.delivery_time_end;
  next.time_window_start = patient.time_window_start;
  next.time_window_end = patient.time_window_end || next.time_window_end || '';
  return next;
}

/**
 * Acceptance double-check: keep a real (typed/dispatcher) window, but replace a
 * value that is merely the pickup's time + 5 with the patient's own window.
 */
export function recheckWindowAgainstPatient(delivery, patient, pickup) {
  if (!delivery || !patient?.time_window_start) return delivery;
  const own = norm(delivery.delivery_time_start);
  if (own && !isPickupDerivedWindow(own, pickup)) return delivery;
  return applyPatientWindowOnPending(delivery, patient);
}

