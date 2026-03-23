export const getClearedDraftFields = () => ({
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

export const resetDraftEditorState = ({
  setSelectedPatient,
  setSelectedPatientIds,
  setPatientSearch,
  setError,
  setEditingStagedId,
  setHighlightedPatientIndex,
  setFormData,
  setSelectedPickupOption,
  shouldAutoFocusFields,
  focusRef,
  setNewPatientMode
}) => {
  setSelectedPatient(null);
  setSelectedPatientIds(new Set());
  setPatientSearch('');
  setError(null);
  setEditingStagedId(null);
  setHighlightedPatientIndex(-1);
  if (setNewPatientMode) setNewPatientMode(null);
  setFormData((prev) => ({ ...prev, ...getClearedDraftFields() }));
  setSelectedPickupOption('');
  if (shouldAutoFocusFields) setTimeout(() => focusRef.current?.focus?.(), 100);
};

const hasAttachedStop = (items, stopId) => items.some((item) => item.patient_id && item.puid === stopId);

export const withoutDetachedAutoCreatedPickups = (items) =>
  items.filter((item) => !( !item.patient_id && item._autoCreated && !hasAttachedStop(items, item.stop_id) ));

export const cleanupDetachedAutoCreatedPickups = async ({
  stagedDeliveries,
  deleteDeliveryLocal,
  autoCreatedPickupsRef,
  setStagedDeliveries
}) => {
  try {
    const autoCreatedPickups = stagedDeliveries.filter((item) => !item.patient_id && item._autoCreated);
    for (const pickup of autoCreatedPickups) {
      const attached = stagedDeliveries.some((item) => item.patient_id && item.puid === pickup.stop_id);
      if (!attached && pickup.id) {
        await deleteDeliveryLocal(pickup.id);
        autoCreatedPickupsRef.current.delete(pickup.id);
      }
    }
    if (setStagedDeliveries) {
      setStagedDeliveries((prev) => withoutDetachedAutoCreatedPickups(prev));
    }
  } catch (error) {
  }
};