import { getPickupStopIdForDelivery, getStoreAssignedTimeSlot } from '../utils/ampmUtils';

export const filterPendingDeliveriesForUser = ({ allDeliveries, suggestedDate, currentUser, userHasRole }) => {
  let pendingDeliveries = (allDeliveries || []).filter((delivery) =>
    delivery &&
    delivery.status === 'pending' &&
    delivery.delivery_date === suggestedDate &&
    delivery.patient_id
  );

  const isAdminLike = userHasRole(currentUser, 'admin') || currentUser?.role === 'App Owner';
  if (isAdminLike) {
    return pendingDeliveries;
  }

  if (userHasRole(currentUser, 'dispatcher')) {
    const dispatcherStoreIds = currentUser.store_ids || [];
    pendingDeliveries = pendingDeliveries.filter((delivery) => dispatcherStoreIds.includes(delivery.store_id));
  } else if (userHasRole(currentUser, 'driver')) {
    pendingDeliveries = pendingDeliveries.filter((delivery) => delivery.driver_id === currentUser.id);
  }

  return pendingDeliveries;
};

export const mapPendingDeliveriesToStaged = ({
  pendingDeliveries,
  patients,
  stores,
  allDeliveries,
  calculateDistance
}) => pendingDeliveries.map((delivery, index) => {
  const patient = patients.find((item) => item && item.id === delivery.patient_id);

  let finalStoreId = delivery.store_id;
  let timeSlot = delivery.ampm_deliveries;
  let puid = delivery.puid || '';

  if (puid) {
    const parentPickup = allDeliveries.find((item) => item && !item.patient_id && item.stop_id === puid);
    if (parentPickup) {
      finalStoreId = parentPickup.store_id || delivery.store_id;
      timeSlot = parentPickup.ampm_deliveries || delivery.ampm_deliveries;
    }
  }

  const store = stores.find((item) => item && item.id === finalStoreId);
  if (!patient || !store) return null;

  let distanceFromStore = patient.distance_from_store;
  if (distanceFromStore === null || distanceFromStore === undefined) {
    if (patient?.latitude && patient?.longitude && store?.latitude && store?.longitude) {
      distanceFromStore = calculateDistance(store.latitude, store.longitude, patient.latitude, patient.longitude);
    }
  }

  if (!timeSlot) {
    timeSlot = getStoreAssignedTimeSlot(store, delivery.delivery_date, allDeliveries);
    puid = getPickupStopIdForDelivery(store.id, delivery.delivery_date, timeSlot, allDeliveries);
  }

  return {
    ...delivery,
    _tempId: Date.now() + Math.random() + index,
    _wasEdited: false,
    patient_name: delivery.patient_name || patient?.full_name || 'Unknown',
    patient_phone: delivery.patient_phone || patient?.phone || '',
    unit_number: delivery.unit_number || patient?.unit_number || '',
    store_id: finalStoreId,
    store_name: store?.name || 'Unknown Store',
    store_abbreviation: store?.abbreviation || '',
    distanceFromStore,
    delivery_address: patient?.address || '',
    cod_total_amount_required: delivery.cod_total_amount_required || 0,
    cod_payments: delivery.cod_payments || [],
    ampm_deliveries: timeSlot,
    puid: puid || '',
    paid_km_override: delivery.paid_km_override ?? distanceFromStore ?? null,
    // CRITICAL: Patient time windows always take priority over stored delivery time windows
    delivery_time_start: patient?.time_window_start || delivery.delivery_time_start || '',
    delivery_time_end: patient?.time_window_end || delivery.delivery_time_end || '',
    time_window_start: patient?.time_window_start || delivery.time_window_start || '',
    time_window_end: patient?.time_window_end || delivery.time_window_end || '',
    // CRITICAL: Recurring fields from patient record
    recurring: patient?.recurring || false,
    recurring_daily: patient?.recurring_daily || false,
    recurring_weekly_mon: patient?.recurring_weekly_mon || false,
    recurring_weekly_tue: patient?.recurring_weekly_tue || false,
    recurring_weekly_wed: patient?.recurring_weekly_wed || false,
    recurring_weekly_thu: patient?.recurring_weekly_thu || false,
    recurring_weekly_fri: patient?.recurring_weekly_fri || false,
    recurring_weekly_sat: patient?.recurring_weekly_sat || false,
    recurring_weekly_sun: patient?.recurring_weekly_sun || false,
    recurring_biweekly: patient?.recurring_biweekly || false,
    recurring_weekly_x4: patient?.recurring_weekly_x4 || false,
    recurring_monthly: patient?.recurring_monthly || false,
    recurring_bimonthly: patient?.recurring_bimonthly || false,
  };
}).filter(Boolean);