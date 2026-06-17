export function buildRecurringLabel(formData, prefix) {
  const days = [];
  if (formData.recurring_weekly_mon) days.push('Mon');
  if (formData.recurring_weekly_tue) days.push('Tue');
  if (formData.recurring_weekly_wed) days.push('Wed');
  if (formData.recurring_weekly_thu) days.push('Thu');
  if (formData.recurring_weekly_fri) days.push('Fri');
  if (formData.recurring_weekly_sat) days.push('Sat');
  if (formData.recurring_weekly_sun) days.push('Sun');
  return `${prefix} (${days.join(', ')})`;
}