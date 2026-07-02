import { format } from 'date-fns';

export function buildDeliveryFormInitialState({
  initialPatientId,
  patients,
  suggestedDate,
  delivery,
  currentUser,
  stores,
  drivers,
  allDrivers,
  initialDriverId,
  resolveDefaultDriverForNewDelivery,
  userHasRole,
  getDriverNameForStorage,
  scheduledDriverMap = {},
  allDeliveries = []
}) {
  const selectedPatient = initialPatientId && Array.isArray(patients)
    ? patients.find((pt) => pt && pt.id === initialPatientId)
    : null;

  const initialState = {
    patient_id: initialPatientId || '',
    delivery_date: suggestedDate || format(new Date(), 'yyyy-MM-dd'),
    delivery_time_start: '',
    delivery_time_end: '',
    delivery_time_eta: '',
    time_window_start: '',
    time_window_end: '',
    status: 'Staged',
    driver_name: '',
    driver_id: '',
    prescription_number: '',
    delivery_instructions: '',
    delivery_notes: '',
    cod_total_amount_required: 0,
    cod_payments: [],
    cod_payment_type: 'No Payment',
    cod_amount: '',
    tracking_number: '',
    delivery_stop_id: '',
    stop_id: '',
    puid: '',
    paid_km_override: null,
    patient_name: selectedPatient?.full_name || '',
    patient_phone: selectedPatient?.phone || '',
    patient_phone_secondary: selectedPatient?.phone_secondary || '',
    unit_number: selectedPatient?.unit_number || '',
    store_phone: '',
    store_id: selectedPatient?.store_id || '',
    mailbox_ok: false,
    call_upon_arrival: false,
    ring_bell: false,
    dont_ring_bell: false,
    back_door: false,
    signature_needed: false,
    fridge_item: false,
    oversized: false,
    after_hours_pickup: false,
    no_charge: false,
    extra_time: 0,
    transport_mode: 'driving',
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
  };

  if (!delivery && currentUser && stores && drivers) {
    const { driverId, driverName } = resolveDefaultDriverForNewDelivery({
      currentUser,
      stores,
      drivers,
      allDrivers,
      deliveryDate: initialState.delivery_date,
      initialDriverId,
      userHasRole,
      getDriverNameForStorage,
      scheduledDriverMap,
      allDeliveries
    });

    if (driverId && driverName) {
      initialState.driver_id = driverId;
      initialState.driver_name = driverName;
    }
  }

  return initialState;
}