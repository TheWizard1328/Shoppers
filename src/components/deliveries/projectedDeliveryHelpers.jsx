import { determineDeliveryAMPM } from '../utils/ampmUtils';

export const resolveProjectedDeliveryDriver = ({ store, patient, deliveryDate, drivers, getDriverNameForStorage, scheduledDriverMap = {} }) => {
  let autoSelectedDriverId = '';
  let autoSelectedDriverName = '';

  const selectedDate = deliveryDate ? new Date(deliveryDate + 'T00:00:00') : new Date();
  const dayOfWeek = selectedDate.getDay();
  const deliveryAMPM = determineDeliveryAMPM(patient);

  // 1. Check scheduledDriverMap (override → store default, already resolved) for this store
  // Try slot-specific keys first (storeId_AM / storeId_PM), then base storeId
  const slotKey = deliveryAMPM === 'PM' ? `${store?.id}_PM` : `${store?.id}_AM`;
  const overrideDriverId = scheduledDriverMap[slotKey] || scheduledDriverMap[store?.id];
  if (overrideDriverId) {
    const driver = drivers.find((item) => item && (item.id === overrideDriverId || item.user_id === overrideDriverId));
    if (driver) {
      return { autoSelectedDriverId: driver.id, autoSelectedDriverName: getDriverNameForStorage(driver), deliveryAMPM };
    }
  }

  // 2. Fall back to store default slot driver
  let amDriverIdField = '';
  let pmDriverIdField = '';

  if (dayOfWeek === 6) {
    amDriverIdField = 'saturday_am_driver_id';
    pmDriverIdField = 'saturday_pm_driver_id';
  } else if (dayOfWeek === 0) {
    amDriverIdField = 'sunday_am_driver_id';
    pmDriverIdField = 'sunday_pm_driver_id';
  } else {
    amDriverIdField = 'weekday_am_driver_id';
    pmDriverIdField = 'weekday_pm_driver_id';
  }

  const preferredDriverIdField = deliveryAMPM === 'PM' ? pmDriverIdField : amDriverIdField;
  const fallbackDriverIdField = deliveryAMPM === 'PM' ? amDriverIdField : pmDriverIdField;

  let driverId = store[preferredDriverIdField];
  if (!driverId) {
    driverId = store[fallbackDriverIdField];
  }

  if (driverId) {
    const driver = drivers.find((item) => item && item.id === driverId);
    if (driver) {
      autoSelectedDriverId = driverId;
      autoSelectedDriverName = getDriverNameForStorage(driver);
    }
  }

  return { autoSelectedDriverId, autoSelectedDriverName, deliveryAMPM };
};

export const buildProjectedStagedItem = ({
  projected,
  patient,
  store,
  formData,
  timeSlot,
  autoSelectedDriverId,
  autoSelectedDriverName,
  distanceFromStore
}) => ({
  patient_id: projected.patient_id,
  patient_name: projected.patient_name,
  patient_phone: patient.phone || '',
  unit_number: patient.unit_number || '',
  delivery_date: formData.delivery_date,
  delivery_time_start: patient.delivery_time_start || '',
  delivery_time_end: patient.delivery_time_end || (patient.delivery_time_start ? '' : ''),
  time_window_start: patient.time_window_start || '',
  time_window_end: patient.time_window_end || (patient.time_window_start ? '' : ''),
  puid: '',
  ampm_deliveries: timeSlot,
  status: 'Staged',
  driver_id: autoSelectedDriverId,
  driver_name: autoSelectedDriverName,
  prescription_number: projected.prescription_number || '',
  delivery_instructions: patient.notes || '',
  delivery_notes: '',
  cod_total_amount_required: projected.cod_total_amount_required || 0,
  cod_payments: [],
  cod_payment_type: 'No Payment',
  tracking_number: '',
  delivery_stop_id: '',
  stop_id: '',
  store_id: projected.store_id,
  store_name: store.name,
  store_abbreviation: store.abbreviation,
  store_phone: store.phone || '',
  mailbox_ok: patient.mailbox_ok || false,
  call_upon_arrival: patient.call_upon_arrival || false,
  ring_bell: patient.ring_bell || false,
  dont_ring_bell: patient.dont_ring_bell || false,
  back_door: patient.back_door || false,
  signature_needed: patient.signature_needed || false,
  fridge_item: patient.fridge_item || false,
  oversized: patient.oversized || false,
  after_hours_pickup: false,
  no_charge: false,
  extra_time: projected.extra_time || 0,
  recurring: patient.recurring || false,
  recurring_daily: patient.recurring_daily || false,
  recurring_weekly_mon: patient.recurring_weekly_mon || false,
  recurring_weekly_tue: patient.recurring_weekly_tue || false,
  recurring_weekly_wed: patient.recurring_weekly_wed || false,
  recurring_weekly_thu: patient.recurring_weekly_thu || false,
  recurring_weekly_fri: patient.recurring_weekly_fri || false,
  recurring_weekly_sat: patient.recurring_weekly_sat || false,
  recurring_weekly_sun: patient.recurring_weekly_sun || false,
  recurring_biweekly: patient.recurring_biweekly || false,
  recurring_weekly_x4: patient.recurring_weekly_x4 || false,
  recurring_monthly: patient.recurring_monthly || false,
  recurring_bimonthly: patient.recurring_bimonthly || false,
  _tempId: Date.now() + Math.random(),
  _wasProjected: true,
  _originalProjected: projected,
  distanceFromStore,
  delivery_address: patient.address || '',
  isNextDelivery: false,
  paid_km_override: distanceFromStore !== null && distanceFromStore !== undefined ? parseFloat(distanceFromStore.toFixed(2)) : null
});