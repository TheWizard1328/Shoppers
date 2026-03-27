export function clearRecurringSelection(prev) {
  return {
    ...prev,
    recurring: false,
    recurring_daily: false,
    recurring_biweekly: false,
    recurring_weekly_x4: false,
    recurring_monthly: false,
    recurring_bimonthly: false,
    recurring_weekly_mon: false,
    recurring_weekly_tue: false,
    recurring_weekly_wed: false,
    recurring_weekly_thu: false,
    recurring_weekly_fri: false,
    recurring_weekly_sat: false,
    recurring_weekly_sun: false
  };
}