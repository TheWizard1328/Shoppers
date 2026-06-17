const RECENT_DELIVERY_LOOKBACK_DAYS = 5; // Check past 5 days for recent deliveries

const userHasRole = (user, role) => {
  if (!user || !role) return false;
  if (Array.isArray(user.app_roles)) return user.app_roles.includes(role);
  if (user.app_role === role) return true;
  return false;
};

const diffDays = (leftDate, rightDate) => {
  return Math.floor((leftDate - rightDate) / (1000 * 60 * 60 * 24));
};

export function getLocalDeliveryPredictions({ currentUser, stores, patients, allDeliveries, selectedDate, scheduledDriverMap }) {
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
    // Drivers see stores where they are the scheduled driver for this date.
    // Priority: scheduledDriverMap (override + fallback already resolved) → static store slot fields.
    const isSaturday = dayOfWeek === 6;
    const isSunday = dayOfWeek === 0;
    const prefix = isSunday ? 'sunday' : isSaturday ? 'saturday' : 'weekday';

    // 1. scheduledDriverMap: storeId -> resolvedDriverId (override-first, already computed in DeliveryForm)
    if (scheduledDriverMap && Object.keys(scheduledDriverMap).length > 0) {
      storeIdsToPredict = Object.entries(scheduledDriverMap)
        .filter(([, driverId]) => driverId === currentUser.id)
        .map(([storeId]) => storeId);
    }

    // 2. Fall back to static store slot fields if map is empty or didn't match
    if (storeIdsToPredict.length === 0) {
      storeIdsToPredict = (stores || []).filter((store) => {
        return store[`${prefix}_am_driver_id`] === currentUser.id ||
          store[`${prefix}_pm_driver_id`] === currentUser.id;
      }).map((store) => store.id);
    }

    // 3. Last resort: driver's assigned store_ids
    if (storeIdsToPredict.length === 0) {
      storeIdsToPredict = currentUser.store_ids || [];
    }
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
        // Check if delivery was within past 5 days (0-5 days ago)
        return daysAgo >= 0 && daysAgo <= RECENT_DELIVERY_LOOKBACK_DAYS;
      })
      .map((delivery) => delivery.patient_id)
  );

  // Find most recent completed delivery date per patient from allDeliveries
  const lastDeliveryDateFromRecords = new Map();
  (allDeliveries || [])
    .filter((delivery) => delivery && delivery.patient_id && delivery.delivery_date && delivery.status === 'completed')
    .forEach((delivery) => {
      const deliveredDate = new Date(`${delivery.delivery_date}T00:00:00`);
      const existingDate = lastDeliveryDateFromRecords.get(delivery.patient_id);
      if (!existingDate || deliveredDate > existingDate) {
        lastDeliveryDateFromRecords.set(delivery.patient_id, deliveredDate);
      }
    });

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
      // Bi-weekly: show if no last delivery, or last delivery was ~14 days ago (±2 days: 12–16)
      const biweeklyOk = !lastDate || (daysSinceLast !== null && daysSinceLast >= 12 && daysSinceLast <= 16);
      if (biweeklyOk) {
        shouldDeliver = true;
        frequency = 'Bi-Weekly';
      }
    } else if (patient.recurring_weekly_x4) {
      // Every 4 weeks (28 days): show if no last delivery, or it's been 25–31 days
      const x4Ok = !lastDate || (daysSinceLast !== null && daysSinceLast >= 25 && daysSinceLast <= 31);
      if (x4Ok) {
        shouldDeliver = true;
        frequency = 'x4 Weeks';
      }
    } else if (patient.recurring_monthly) {
      // Monthly (~30 days): show if no last delivery, or it's been 27–33 days (±3 days)
      const monthlyOk = !lastDate || (daysSinceLast !== null && daysSinceLast >= 27 && daysSinceLast <= 33);
      if (monthlyOk) {
        shouldDeliver = true;
        frequency = 'Monthly';
      }
    } else if (patient.recurring_bimonthly) {
      // Bi-monthly (~60 days): show if no last delivery, or it's been 57–63 days (±3 days)
      const bimonthlyOk = !lastDate || (daysSinceLast !== null && daysSinceLast >= 57 && daysSinceLast <= 63);
      if (bimonthlyOk) {
        shouldDeliver = true;
        frequency = 'Bi-Monthly';
      }
    } else if (patient.recurring && !lastDate) {
      shouldDeliver = true;
      frequency = 'Recurring';
    }

    if (shouldDeliver && recentlyDeliveredPatientIds.has(patient.id)) shouldDeliver = false;
    if (shouldDeliver && lastDate && lastDate > dateObj) shouldDeliver = false;
    
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