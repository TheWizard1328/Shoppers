import { determineDeliveryAMPM, getStoreAssignedTimeSlot } from '../utils/ampmUtils';

const isSoleDriverUser = (currentUser) => {
  const roles = Array.isArray(currentUser?.app_roles) ? currentUser.app_roles : [];
  return roles.includes('driver') && !roles.includes('admin') && !roles.includes('dispatcher');
};

export const resolvePatientDriverAssignment = ({
  patient,
  patientStore,
  deliveryDate,
  drivers,
  allDeliveries,
  getDriverNameForStorage,
  currentUser,
  scheduledDriverMap = {}
}) => {
  if (!patientStore || !deliveryDate || !drivers) {
    return { autoSelectedDriverId: '', autoSelectedDriverName: '', deliveryAMPM: determineDeliveryAMPM(patient) };
  }

  const selectedDate = new Date(`${deliveryDate}T00:00:00`);
  const dayOfWeek = selectedDate.getDay();
  const deliveryAMPM =
    determineDeliveryAMPM(patient) ||
    getStoreAssignedTimeSlot(patientStore, deliveryDate, allDeliveries) ||
    'AM';

  // Priority 1: Driver who already has a store pickup for this store on this date/slot
  const existingPickupDriverId = (() => {
    if (!allDeliveries || !patientStore?.id || !deliveryDate) return null;
    const pickup = allDeliveries.find((d) =>
      d &&
      !d.patient_id &&
      d.store_id === patientStore.id &&
      d.delivery_date === deliveryDate &&
      (d.ampm_deliveries || 'AM') === deliveryAMPM &&
      d.driver_id &&
      !['cancelled', 'failed'].includes(d.status)
    );
    return pickup?.driver_id || null;
  })();

  // Priority 2: DriverScheduleOverride — slot-aware lookup (storeId_PM or storeId_AM), then base storeId
  const slotKey = `${patientStore.id}_${deliveryAMPM}`;
  const fallbackSlotKey = `${patientStore.id}_${deliveryAMPM === 'PM' ? 'AM' : 'PM'}`;
  const overrideDriverId =
    scheduledDriverMap[slotKey] ||
    scheduledDriverMap[fallbackSlotKey] ||
    scheduledDriverMap[patientStore.id] ||
    null;

  let driverId;
  if (isSoleDriverUser(currentUser)) {
    driverId = currentUser.id || currentUser.user_id || '';
  } else if (existingPickupDriverId) {
    driverId = existingPickupDriverId;
  } else if (overrideDriverId) {
    driverId = overrideDriverId;
  } else {
    // Priority 3: Store default driver for the correct AM/PM slot
    const fields = dayOfWeek === 6
      ? { am: 'saturday_am_driver_id', pm: 'saturday_pm_driver_id' }
      : dayOfWeek === 0
        ? { am: 'sunday_am_driver_id', pm: 'sunday_pm_driver_id' }
        : { am: 'weekday_am_driver_id', pm: 'weekday_pm_driver_id' };

    const preferredField = deliveryAMPM === 'PM' ? fields.pm : fields.am;
    const fallbackField = deliveryAMPM === 'PM' ? fields.am : fields.pm;
    driverId = patientStore[preferredField] || patientStore[fallbackField] || '';
  }

  const driver = driverId ? drivers.find((item) => item && item.id === driverId) : null;

  return {
    autoSelectedDriverId: driverId,
    autoSelectedDriverName: driver ? getDriverNameForStorage(driver) : '',
    deliveryAMPM
  };
};

export const buildSelectedPatientFormData = ({
  formData,
  patient,
  deliveryAMPM,
  autoSelectedDriverId,
  autoSelectedDriverName
}) => ({
  ...formData,
  patient_id: patient.id,
  patient_name: patient.full_name,
  patient_phone: patient.phone || '',
  unit_number: patient.unit_number || '',
  time_window_start: patient.time_window_start || patient.time_window_end ? patient.time_window_start || '' : '',
  time_window_end: patient.time_window_start || patient.time_window_end ? patient.time_window_end || '' : '',
  // CRITICAL: Patient time windows override delivery time windows
  delivery_time_start: patient.time_window_start || formData.delivery_time_start || '',
  delivery_time_end: patient.time_window_end || formData.delivery_time_end || '',
  mailbox_ok: patient.mailbox_ok || false,
  call_upon_arrival: patient.call_upon_arrival || false,
  ring_bell: patient.ring_bell || false,
  dont_ring_bell: patient.dont_ring_bell || false,
  back_door: patient.back_door || false,
  signature_needed: patient.signature_needed || false,
  delivery_instructions: patient.notes || '',
  store_id: patient.store_id || '',
  ampm_deliveries: deliveryAMPM,
  driver_id: autoSelectedDriverId,
  driver_name: autoSelectedDriverName,
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
  recurring_bimonthly: patient.recurring_bimonthly || false
});

export const buildDuplicatePatientDraft = ({
  patient,
  patients,
  deliveryDate,
  stores,
  drivers,
  allDeliveries,
  getDriverNameForStorage,
  formData
}) => {
  const fullPatient = patients.find((item) => item && item.id === patient.id) || patient;
  const patientStore = stores.find((store) => store && store.id === fullPatient.store_id);
  const patientWithEmpty = {
    ...fullPatient,
    patient_id: '',
    full_name: '',
    phone: '',
    phone_secondary: '',
    _duplicateSource: true,
    _isNew: true
  };

  const { autoSelectedDriverId, autoSelectedDriverName } = resolvePatientDriverAssignment({
    patient,
    patientStore,
    deliveryDate,
    drivers,
    allDeliveries,
    getDriverNameForStorage,
    currentUser: formData._currentUser || null,
    scheduledDriverMap: formData._scheduledDriverMap || {}
  });

  return {
    patientWithEmpty,
    nextFormData: {
      ...formData,
      patient_id: '',
      patient_name: '',
      patient_phone: patient.phone || '',
      unit_number: patient.unit_number || '',
      time_window_start: patient.time_window_start || '',
      time_window_end: patient.time_window_end || '',
      mailbox_ok: patient.mailbox_ok || false,
      call_upon_arrival: patient.call_upon_arrival || false,
      ring_bell: patient.ring_bell || false,
      dont_ring_bell: patient.dont_ring_bell || false,
      back_door: patient.back_door || false,
      signature_needed: patient.signature_needed || false,
      delivery_instructions: patient.notes || '',
      store_id: patient.store_id || '',
      driver_id: autoSelectedDriverId,
      driver_name: autoSelectedDriverName,
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
      recurring_bimonthly: patient.recurring_bimonthly || false
    },
    duplicateSelectedPatient: { ...patient, _duplicateSource: true }
  };
};

export const buildNewAddressPatientDraft = ({
  patient,
  patients,
  deliveryDate,
  stores,
  drivers,
  allDeliveries,
  getDriverNameForStorage,
  formData,
  shouldAutoFocusFields
}) => {
  const fullPatient = patients.find((item) => item && item.id === patient.id) || patient;
  const patientStore = stores.find((store) => store && store.id === fullPatient.store_id);

  const { autoSelectedDriverId, autoSelectedDriverName } = resolvePatientDriverAssignment({
    patient,
    patientStore,
    deliveryDate,
    drivers,
    allDeliveries,
    getDriverNameForStorage,
    currentUser: formData._currentUser || null,
    scheduledDriverMap: formData._scheduledDriverMap || {}
  });

  return {
    nextFormData: {
      ...formData,
      patient_id: '',
      patient_name: fullPatient.full_name || '',
      patient_phone: fullPatient.phone || '',
      unit_number: '',
      time_window_start: fullPatient.time_window_start || '',
      time_window_end: fullPatient.time_window_end || '',
      mailbox_ok: fullPatient.mailbox_ok || false,
      call_upon_arrival: fullPatient.call_upon_arrival || false,
      ring_bell: fullPatient.ring_bell || false,
      dont_ring_bell: fullPatient.dont_ring_bell || false,
      back_door: fullPatient.back_door || false,
      signature_needed: fullPatient.signature_needed || false,
      delivery_instructions: fullPatient.notes || '',
      store_id: fullPatient.store_id || '',
      driver_id: autoSelectedDriverId,
      driver_name: autoSelectedDriverName,
      recurring: fullPatient.recurring || false,
      recurring_daily: fullPatient.recurring_daily || false,
      recurring_weekly_mon: fullPatient.recurring_weekly_mon || false,
      recurring_weekly_tue: fullPatient.recurring_weekly_tue || false,
      recurring_weekly_wed: fullPatient.recurring_weekly_wed || false,
      recurring_weekly_thu: fullPatient.recurring_weekly_thu || false,
      recurring_weekly_fri: fullPatient.recurring_weekly_fri || false,
      recurring_weekly_sat: fullPatient.recurring_weekly_sat || false,
      recurring_weekly_sun: fullPatient.recurring_weekly_sun || false,
      recurring_biweekly: fullPatient.recurring_biweekly || false,
      recurring_weekly_x4: fullPatient.recurring_weekly_x4 || false,
      recurring_monthly: fullPatient.recurring_monthly || false,
      recurring_bimonthly: fullPatient.recurring_bimonthly || false
    },
    patientWithoutAddress: {
      ...fullPatient,
      patient_id: '',
      address: '',
      unit_number: '',
      latitude: null,
      longitude: null,
      distance_from_store: null,
      _newAddressSource: true,
      _isNew: true,
      _focusAddress: shouldAutoFocusFields
    }
  };
};