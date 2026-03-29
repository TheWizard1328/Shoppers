export const prepareDeliverySaveData = ({ formData, delivery, isCompletionStatus, completionTime }) => {
  const {
    patient_name,
    patient_phone,
    unit_number,
    store_phone,
    delivery_stop_id,
    mailbox_ok,
    call_upon_arrival,
    ring_bell,
    dont_ring_bell,
    back_door,
    ...dataToSave
  } = { ...formData };

  if (dataToSave.cod_total_amount_required > 0) {
    dataToSave.cod_total_amount_required = dataToSave.cod_total_amount_required / 100;
  }

  if (isCompletionStatus && completionTime) {
    // Only update actual_delivery_time if:
    // 1. The delivery doesn't already have one (setting it for the first time), OR
    // 2. The user explicitly changed completionTime from what was on the original delivery
    const originalTime = delivery?.actual_delivery_time
      ? delivery.actual_delivery_time.substring(11, 16) // extract HH:mm from "YYYY-MM-DDTHH:mm:ss"
      : null;
    const timeChanged = !originalTime || completionTime !== originalTime;
    if (timeChanged) {
      dataToSave.actual_delivery_time = `${formData.delivery_date}T${completionTime}:00`;
    } else {
      // Preserve the original actual_delivery_time exactly as stored
      dataToSave.actual_delivery_time = delivery.actual_delivery_time;
    }
  }

  if (isCompletionStatus) {
    const arrivalTimeValue = formData.arrival_time !== undefined
      ? formData.arrival_time
      : (delivery?.arrival_time ? delivery.arrival_time.substring(11, 16) : '');

    if (arrivalTimeValue) {
      dataToSave.arrival_time = `${formData.delivery_date}T${arrivalTimeValue}:00`;
    } else if (delivery?.arrival_time) {
      dataToSave.arrival_time = '';
    }
  }

  if (!dataToSave.patient_id) {
    dataToSave.status = 'en_route';
  }

  return dataToSave;
};

export const buildPickupSnapshot = (data) => JSON.stringify({
  delivery_date: data.delivery_date || null,
  delivery_time_start: data.delivery_time_start || null,
  delivery_time_end: data.delivery_time_end || null,
  delivery_time_eta: data.delivery_time_eta || null,
  status: data.status || null,
  driver_name: data.driver_name || null,
  driver_id: data.driver_id || null,
  prescription_number: data.prescription_number || null,
  delivery_instructions: data.delivery_instructions || null,
  delivery_notes: data.delivery_notes || null,
  cod_total_amount_required: Number(data.cod_total_amount_required || 0),
  cod_payments: Array.isArray(data.cod_payments) ? data.cod_payments : [],
  cod_payment_type: data.cod_payment_type || null,
  cod_amount: data.cod_amount || null,
  tracking_number: data.tracking_number || null,
  stop_id: data.stop_id || null,
  puid: data.puid || null,
  store_id: data.store_id || null,
  ampm_deliveries: data.ampm_deliveries || null,
  signature_needed: !!data.signature_needed,
  fridge_item: !!data.fridge_item,
  oversized: !!data.oversized,
  after_hours_pickup: !!data.after_hours_pickup,
  no_charge: !!data.no_charge,
  extra_time: Number(data.extra_time || 0),
  barcode_values: Array.isArray(data.barcode_values) ? data.barcode_values : [],
  receipt_barcode_values: Array.isArray(data.receipt_barcode_values) ? data.receipt_barcode_values : [],
  paid_km_override: data.paid_km_override ?? null,
  actual_delivery_time: data.actual_delivery_time || null
});

export const getDeliverySubmitFlags = ({ delivery, formData, dataToSave }) => {
  const driverChanged = delivery && delivery.driver_id !== formData.driver_id;
  const dateChanged = delivery && delivery.delivery_date !== formData.delivery_date;
  const statusChangedToInTransit = !!(
    delivery &&
    formData.status === 'in_transit' &&
    delivery.status !== 'in_transit'
  );
  const statusChangedToCompletion = !!(
    delivery &&
    ['completed', 'cancelled', 'failed', 'returned'].includes(formData.status) &&
    delivery.status !== formData.status
  );
  const actualDeliveryTimeChanged = !!(
    delivery &&
    ['completed', 'cancelled', 'failed', 'returned'].includes(formData.status) &&
    dataToSave.actual_delivery_time &&
    dataToSave.actual_delivery_time !== (delivery.actual_delivery_time || '')
  );
  const codWasRemoved = !!(
    delivery?.cod_total_amount_required > 0 &&
    (formData.cod_total_amount_required === 0 || !formData.cod_total_amount_required)
  );

  return {
    driverChanged,
    dateChanged,
    statusChangedToInTransit,
    statusChangedToCompletion,
    actualDeliveryTimeChanged,
    codWasRemoved
  };
};