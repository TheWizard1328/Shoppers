let managerControllersPromise;

const getManagerControllers = async () => {
  if (!managerControllersPromise) {
    managerControllersPromise = Promise.all([
      import("./smartRefreshManager.js"),
      import("./driverLocationPoller.js"),
      import("./routePolylineManager.js"),
      import("./fabControlEvents.js")
    ]);
  }

  const [
    { smartRefreshManager },
    { driverLocationPoller },
    { routePolylineManager },
    { fabControlEvents }
  ] = await managerControllersPromise;

  return { smartRefreshManager, driverLocationPoller, routePolylineManager, fabControlEvents };
};

export const getClearedDraftFormData = (prev) => ({
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

export const resumeDeliveryFormManagers = async () => {
  const { smartRefreshManager, driverLocationPoller, routePolylineManager, fabControlEvents } = await getManagerControllers();

  smartRefreshManager.resume();
  driverLocationPoller.resume();
  routePolylineManager?.resume?.();
  fabControlEvents.resumeFAB();
};

export const closeDeliveryFormAfterSave = ({ handleClearForm, onCancel }) => {
  handleClearForm();
  onCancel();
};