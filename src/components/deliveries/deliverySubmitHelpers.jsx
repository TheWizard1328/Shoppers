export const prepareDeliverySaveData = ({ formData, delivery, isCompletionStatus, completionTime, currentTravelMode = 'driving' }) => {
  const now = new Date();
  const currentLocalTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const isHistoricalDelivery = Boolean(
    delivery?.delivery_date && delivery.delivery_date < new Date().toISOString().split('T')[0]
  );
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
    const originalTime = delivery?.actual_delivery_time
      ? delivery.actual_delivery_time.substring(11, 16)
      : null;
    const timeChanged = !originalTime || completionTime !== originalTime;

    if (isHistoricalDelivery && delivery?.actual_delivery_time && !timeChanged) {
      dataToSave.actual_delivery_time = delivery.actual_delivery_time;
    } else if (timeChanged) {
      dataToSave.actual_delivery_time = `${formData.delivery_date}T${completionTime}:00`;
    } else {
      dataToSave.actual_delivery_time = delivery.actual_delivery_time;
    }
  }

  const transitionsToPending = dataToSave.status === 'pending' && delivery?.status !== 'pending';
  const isNewDeliveryCreation = !delivery?.id;
  if (formData.finished_leg_transport_mode || delivery?.finished_leg_transport_mode || isNewDeliveryCreation || transitionsToPending) {
    dataToSave.finished_leg_transport_mode = formData.finished_leg_transport_mode || delivery?.finished_leg_transport_mode || 'driving';
  }

  if (isCompletionStatus) {
    const originalArrivalTime = delivery?.arrival_time ? delivery.arrival_time.substring(11, 16) : '';
    const arrivalTimeValue = formData.arrival_time !== undefined
      ? formData.arrival_time
      : originalArrivalTime;
    const arrivalTimeChanged = arrivalTimeValue !== originalArrivalTime;

    if (isHistoricalDelivery && delivery?.arrival_time && !arrivalTimeChanged) {
      dataToSave.arrival_time = delivery.arrival_time;
    } else if (arrivalTimeValue) {
      dataToSave.arrival_time = `${formData.delivery_date}T${arrivalTimeValue}:00`;
    } else if (delivery?.arrival_time) {
      dataToSave.arrival_time = '';
    }
  }

  if (!delivery?.id && !dataToSave.patient_id) {
    dataToSave.status = 'en_route';
  }

  const isInterstoreStop = !dataToSave.patient_id && !!dataToSave.store_id;
  const transitionedToInTransit = dataToSave.status === 'in_transit' && delivery?.status !== 'in_transit';
  if (isInterstoreStop && transitionedToInTransit) {
    dataToSave.delivery_time_start = currentLocalTime;
    dataToSave.delivery_time_end = '';
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
  const timeWindowChanged = !!(
    delivery && (
      (dataToSave.delivery_time_start || '') !== (delivery.delivery_time_start || '') ||
      (dataToSave.delivery_time_end || '') !== (delivery.delivery_time_end || '')
    )
  );
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
    timeWindowChanged,
    statusChangedToInTransit,
    statusChangedToCompletion,
    actualDeliveryTimeChanged,
    codWasRemoved
  };
};