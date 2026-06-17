export const getClearedDeliveryFormFields = (prev) => ({
  ...prev,
  patient_id: '',
  patient_name: '',
  patient_phone: '',
  unit_number: '',
  delivery_instructions: '',
  delivery_notes: '',
  prescription_number: '',
  cod_total_amount_required: 0,
  cod_payments: [],
  cod_payment_type: 'No Payment',
  cod_amount: '',
  mailbox_ok: false,
  call_upon_arrival: false,
  ring_bell: false,
  dont_ring_bell: false,
  back_door: false,
  signature_needed: false,
  fridge_item: false,
  oversized: false,
  no_charge: false,
  store_id: '',
  delivery_time_start: '',
  delivery_time_end: '',
  time_window_start: '',
  time_window_end: '',
  barcode_values: [],
  receipt_barcode_values: [],
  recurring: false,
  recurring_daily: false,
  recurring_weekly_mon: false,
  recurring_weekly_tue: false,
  recurring_weekly_wed: false,
  recurring_weekly_thu: false,
  recurring_weekly_fri: false,
  recurring_weekly_sat: false,
  recurring_weekly_sun: false,
  recurring_biweekly: false,
  recurring_weekly_x4: false,
  recurring_monthly: false,
  recurring_bimonthly: false
});

export const getDistanceFromStoreValue = (patient, store) => {
  const existingDistance = patient?.distance_from_store;
  if (existingDistance !== null && existingDistance !== undefined) {
    return existingDistance;
  }

  if (!patient?.latitude || !patient?.longitude || !store?.latitude || !store?.longitude) {
    return existingDistance;
  }

  const R = 6371;
  const dLat = (store.latitude - patient.latitude) * Math.PI / 180;
  const dLon = (store.longitude - patient.longitude) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(patient.latitude * Math.PI / 180) * Math.cos(store.latitude * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

export const resumeDeliveryFormManagers = async () => {
  const [smartRefreshModule, pollerModule, polylineModule, fabModule] = await Promise.all([
    import('../utils/smartRefreshManager'),
    import('../utils/driverLocationPoller'),
    import('../utils/routePolylineManager'),
    import('../utils/fabControlEvents')
  ]);

  smartRefreshModule.smartRefreshManager.resume();
  pollerModule.driverLocationPoller.resume();
  polylineModule.routePolylineManager?.resume?.();
  fabModule.fabControlEvents.resumeFAB();
};