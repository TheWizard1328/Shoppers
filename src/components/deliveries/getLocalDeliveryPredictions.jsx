const RECENT_DELIVERY_LOOKBACK_DAYS = 2;

const userHasRole = (user, role) => {
  if (!user || !role) return false;
  if (Array.isArray(user.app_roles)) return user.app_roles.includes(role);
  if (user.app_role === role) return true;
  return false;
};

const diffDays = (leftDate, rightDate) => {
  return Math.floor((leftDate - rightDate) / (1000 * 60 * 60 * 24));
};

export function getLocalDeliveryPredictions({ currentUser, stores, patients, allDeliveries, selectedDate }) {
  if (!currentUser || !selectedDate) return [];

  const dateObj = new Date(`${selectedDate}T00:00:00`);
  const dayOfWeek = dateObj.getDay();
  const dayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const selectedDayName = dayNames[dayOfWeek];

  let storeIdsToPredict = [];

  if (userHasRole(currentUser, 'admin')) {
    // Admins see ALL stores — projections cover every driver/store for the selected date/city.
    // The form's driver filter will narrow down from there.
    storeIdsToPredict = (stores || []).map((store) => store.id);
  } else if (userHasRole(currentUser, 'dispatcher')) {
    storeIdsToPredict = currentUser.store_ids || [];
  } else if (userHasRole(currentUser, 'driver')) {
    // Drivers only see their own assigned store slots for the day.
    const isSaturday = dayOfWeek === 6;
    const isSunday = dayOfWeek === 0;
    const slotStoreIds = (stores || []).filter((store) => {
      return isSaturday && (store.saturday_am_driver_id === currentUser.id || store.saturday_pm_driver_id === currentUser.id) ||
        isSunday && (store.sunday_am_driver_id === currentUser.id || store.sunday_pm_driver_id === currentUser.id) ||
        !isSaturday && !isSunday && (store.weekday_am_driver_id === currentUser.id || store.weekday_pm_driver_id === currentUser.id);
    }).map((store) => store.id);
    storeIdsToPredict = slotStoreIds.length > 0 ? slotStoreIds : (currentUser.store_ids || []);
  }

  if (storeIdsToPredict.length === 0 && !userHasRole(currentUser, 'admin')) return [];

  const existingPatientIds = new Set(
    (allDeliveries || [])
      .filter((delivery) => delivery && delivery.delivery_date === selectedDate && storeIdsToPredict.includes(delivery.store_id) && delivery.patient_id)
      .map((delivery) => delivery.patient_id)
  );

  const recentlyDeliveredPatientIds = new Set(
    (allDeliveries || [])
      .filter((delivery) => {
        if (!delivery || !delivery.patient_id || !storeIdsToPredict.includes(delivery.store_id)) return false;
        if (delivery.status !== 'completed') return false;
        if (!delivery.delivery_date) return false;
        const deliveredDate = new Date(`${delivery.delivery_date}T00:00:00`);
        const daysAgo = diffDays(dateObj, deliveredDate);
        return daysAgo >= 0 && daysAgo <= RECENT_DELIVERY_LOOKBACK_DAYS;
      })
      .map((delivery) => delivery.patient_id)
  );

  return (patients || []).filter((patient) => {
    if (!patient || patient.status !== 'active') return false;
    if (!storeIdsToPredict.includes(patient.store_id)) return false;
    if (existingPatientIds.has(patient.id)) return false;
    return patient.recurring ||
      patient.recurring_daily ||
      patient.recurring_weekly_mon || patient.recurring_weekly_tue || patient.recurring_weekly_wed ||
      patient.recurring_weekly_thu || patient.recurring_weekly_fri || patient.recurring_weekly_sat || patient.recurring_weekly_sun ||
      patient.recurring_biweekly || patient.recurring_weekly_x4 || patient.recurring_monthly || patient.recurring_bimonthly;
  }).map((patient) => {
    const hasDaySelected = patient[`recurring_weekly_${selectedDayName}`];
    const lastDate = patient.last_delivery_date ? new Date(`${patient.last_delivery_date}T00:00:00`) : null;
    const daysSinceLast = lastDate ? diffDays(dateObj, lastDate) : null;

    let shouldDeliver = false;
    let frequency = null;

    if (patient.recurring_daily) {
      shouldDeliver = true;
      frequency = 'Daily';
    } else if (hasDaySelected && !patient.recurring_biweekly && !patient.recurring_weekly_x4) {
      shouldDeliver = true;
      frequency = 'Weekly';
    } else if (patient.recurring_biweekly && hasDaySelected) {
      shouldDeliver = true;
      frequency = 'Bi-Weekly';
    } else if (patient.recurring_weekly_x4 && (!lastDate || Math.abs(dateObj.getDate() - lastDate.getDate()) <= 3)) {
      shouldDeliver = true;
      frequency = 'x4 Weeks';
    } else if (patient.recurring_monthly && (!lastDate || Math.abs(dateObj.getDate() - lastDate.getDate()) <= 3)) {
      shouldDeliver = true;
      frequency = 'Monthly';
    } else if (patient.recurring_bimonthly && (!lastDate || Math.abs(dateObj.getDate() - lastDate.getDate()) <= 3)) {
      shouldDeliver = true;
      frequency = 'Bi-Monthly';
    } else if (patient.recurring && !lastDate) {
      shouldDeliver = true;
      frequency = 'Recurring';
    }

    if (shouldDeliver && recentlyDeliveredPatientIds.has(patient.id)) shouldDeliver = false;
    if (shouldDeliver && lastDate && lastDate >= dateObj) shouldDeliver = false;
    if (!shouldDeliver) return null;

    return {
      patient_id: patient.id,
      patient_name: patient.full_name,
      store_id: patient.store_id,
      reason: `${frequency} delivery`,
      frequency,
      last_delivery_date: patient.last_delivery_date || null,
      cod_total_amount_required: 0,
      prescription_number: '',
      extra_time: 0
    };
  }).filter(Boolean);
}