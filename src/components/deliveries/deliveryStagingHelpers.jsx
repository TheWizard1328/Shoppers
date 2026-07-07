export const resolveDistanceFromStore = ({ patient, store, calculateDistance }) => {
  let distanceFromStore = patient?.distance_from_store;

  if (distanceFromStore === null || distanceFromStore === undefined) {
    if (patient && patient.latitude && patient.longitude && store?.latitude && store?.longitude) {
      distanceFromStore = calculateDistance(store.latitude, store.longitude, patient.latitude, patient.longitude);
    }
  }

  return distanceFromStore;
};

export const buildPickupStagedDelivery = ({ formData, codAmount, store, timeSlot, existingStopIds = [] }) => {
  const ids = existingStopIds.filter(Boolean);
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let sid = '';
  let tries = 0;

  do {
    sid = '';
    for (let i = 0; i < 3; i += 1) sid += chars.charAt(Math.floor(Math.random() * chars.length));
    tries += 1;
  } while (ids.includes(sid) && tries < 10000);

  return {
    ...formData,
    patient_id: '',
    patient_name: 'Pickup',
    patient_phone: '',
    unit_number: '',
    cod_total_amount_required: codAmount,
    delivery_date: formData.delivery_date,
    delivery_id: `DID-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
    driver_id: formData.driver_id,
    driver_name: formData.driver_name,
    store_id: store.id,
    store_name: store.name,
    store_abbreviation: store.abbreviation,
    store_phone: store.phone || '',
    stop_id: sid,
    puid: sid,
    ampm_deliveries: timeSlot,
    status: 'en_route',
    delivery_address: store.address,
    latitude: store.latitude,
    longitude: store.longitude,
    extra_time: formData.extra_time || 15,
    transport_mode: formData.transport_mode || 'driving',
    _tempId: Date.now() + Math.random()
  };
};

export const buildPatientStagedDelivery = ({
  formData,
  patient,
  store,
  codAmount,
  puid,
  timeSlot,
  distanceFromStore,
  isNewPatient,
  includeFirstDelivery = true
}) => ({
  ...formData,
  time_window_start: formData.time_window_start || patient?.time_window_start || '',
  time_window_end: formData.time_window_end || patient?.time_window_end || '',
  // CRITICAL: Patient time windows override delivery time windows
  delivery_time_start: patient?.time_window_start || formData.delivery_time_start || '',
  delivery_time_end: patient?.time_window_end || formData.delivery_time_end || '',
  cod_total_amount_required: codAmount,
  puid: puid || '',
  ampm_deliveries: timeSlot,
  // ISP/ISD patient deliveries are always in_transit when created.
  // Preserve any status the user explicitly set (not the default 'Staged');
  // only fall back to 'Staged' when formData.status is still at its default value.
  status: (formData._interstore_source_id || formData._interstore_dest_id)
    ? 'in_transit'
    : (formData.status && formData.status !== 'Staged')
      ? formData.status
      : 'Staged',
  _tempId: Date.now() + Math.random(),
  patient_name: formData.patient_name || patient?.full_name || 'N/A (Pickup)',
  store_name: store.name,
  store_abbreviation: store.abbreviation,
  distanceFromStore,
  delivery_address: patient?.address || store.address,
  transport_mode: formData.transport_mode || 'driving',
  ...(includeFirstDelivery ? { first_delivery: isNewPatient || !patient?.last_delivery_date } : {})
});