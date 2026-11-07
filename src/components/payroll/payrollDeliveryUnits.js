/**
 * payrollDeliveryUnits — ONE definition of "what counts as a delivery" for payroll.
 *
 * WHY (owner report Nov 7 2026): the page badge, the store/day grid and the driver
 * summary cards each implemented their own after-hours rule and their own status
 * filter, so the headline delivery total included after-hours pickups while the
 * daily rows and store column totals (and some driver summaries) did not. The
 * numbers could never agree.
 *
 * Every surface now calls these helpers, so a change here moves all of them
 * together instead of one at a time.
 *
 * RULES (owner rules, unchanged in substance):
 *  - A patient stop or an ISD-/ISP- interstore stop counts when completed or
 *    failed, or cancelled IF the patient address carries (RTN).
 *  - An after-hours PICKUP (no patient, not interstore, after_hours_pickup) is a
 *    delivery in its own right when completed or cancelled.
 *  - DELIVERY UNITS: a normal stop = 1 unit. An after-hours DELIVERY (patient or
 *    interstore) is paid 2x base, so it counts as 2 units. An after-hours pickup
 *    is 1 unit. This is the number the payroll cards show and the number the grid
 *    adds into the day and store totals.
 */

export const isInterStoreDelivery = (d) => {
  const id = String(d?.delivery_id || '').toUpperCase();
  return id.startsWith('ISD-') || id.startsWith('ISP-');
};

// Truthy-tolerant: a row written as "true"/1 must behave like a real true.
export const isAfterHours = (d) =>
  d?.after_hours_pickup === true || d?.after_hours_pickup === 'true' || d?.after_hours_pickup === 1;

export const isAfterHoursPickupStop = (d) =>
  !!d && !d.patient_id && !isInterStoreDelivery(d) && isAfterHours(d) &&
  (d.status === 'completed' || d.status === 'cancelled');

export const isAfterHoursDeliveryStop = (d) =>
  !!d && isAfterHours(d) && (!!d.patient_id || isInterStoreDelivery(d));

/**
 * @param {object} d delivery row
 * @param {(deliveryId:string)=>boolean} [isPatientReturn] optional (RTN) resolver
 */
export const isCountablePayrollStop = (d, isPatientReturn) => {
  if (!d) return false;
  if (d.status !== 'completed' && d.status !== 'failed' && d.status !== 'cancelled') return false;
  if (d.patient_id || isInterStoreDelivery(d)) {
    if (d.status === 'cancelled') return !!(isPatientReturn && isPatientReturn(d));
    return true;
  }
  // bare pickup: only an after-hours one counts, and only when completed/cancelled
  return isAfterHoursPickupStop(d);
};

/** 2 for an after-hours delivery (paid 2x base), 1 otherwise. */
export const deliveryUnitsFor = (d) => (isAfterHoursDeliveryStop(d) ? 2 : 1);

/** Total delivery UNITS across rows, skipping anything that does not count. */
export const countDeliveryUnits = (rows, isPatientReturn) => {
  const list = Array.isArray(rows) ? rows : [];
  return list.reduce(
    (sum, d) => (isCountablePayrollStop(d, isPatientReturn) ? sum + deliveryUnitsFor(d) : sum),
    0,
  );
};
