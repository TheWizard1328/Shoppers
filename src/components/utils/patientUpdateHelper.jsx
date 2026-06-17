/**
 * Build a patient update payload from formData for saving to Patient entity.
 * Includes time_window fields and recurring schedule fields.
 */
export function buildPatientUpdatePayload(formData) {
  let weeklyX4Day = undefined;
  if (formData.recurring_weekly_x4) {
    if (formData.recurring_weekly_mon) weeklyX4Day = 'mon';
    else if (formData.recurring_weekly_tue) weeklyX4Day = 'tue';
    else if (formData.recurring_weekly_wed) weeklyX4Day = 'wed';
    else if (formData.recurring_weekly_thu) weeklyX4Day = 'thu';
    else if (formData.recurring_weekly_fri) weeklyX4Day = 'fri';
    else if (formData.recurring_weekly_sat) weeklyX4Day = 'sat';
    else if (formData.recurring_weekly_sun) weeklyX4Day = 'sun';
  }

  return {
    full_name: formData.patient_name,
    phone: formData.patient_phone,
    phone_secondary: formData.patient_phone_secondary ?? '',
    unit_number: formData.unit_number,
    notes: formData.delivery_instructions,
    time_window_start: formData.time_window_start || '',
    time_window_end: formData.time_window_end || '',
    mailbox_ok: formData.mailbox_ok,
    call_upon_arrival: formData.call_upon_arrival,
    ring_bell: formData.ring_bell,
    dont_ring_bell: formData.dont_ring_bell,
    back_door: formData.back_door,
    signature_needed: formData.signature_needed,
    recurring: formData.recurring,
    recurring_daily: formData.recurring_daily,
    recurring_weekly_mon: formData.recurring_weekly_mon,
    recurring_weekly_tue: formData.recurring_weekly_tue,
    recurring_weekly_wed: formData.recurring_weekly_wed,
    recurring_weekly_thu: formData.recurring_weekly_thu,
    recurring_weekly_fri: formData.recurring_weekly_fri,
    recurring_weekly_sat: formData.recurring_weekly_sat,
    recurring_weekly_sun: formData.recurring_weekly_sun,
    recurring_biweekly: formData.recurring_biweekly,
    recurring_weekly_x4: formData.recurring_weekly_x4,
    recurring_weekly_x4_day: weeklyX4Day,
    recurring_monthly: formData.recurring_monthly,
    recurring_bimonthly: formData.recurring_bimonthly
  };
}