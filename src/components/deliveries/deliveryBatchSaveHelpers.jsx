export const COMPLETION_STATUSES = ['completed', 'failed', 'cancelled', 'returned'];

export const filterValidStagedDeliveries = (stagedDeliveries, allDeliveries) => {
  return (stagedDeliveries || []).filter(Boolean);
};

export const splitStagedDeliveriesForBatch = (validStagedDeliveries) => {
  const newDeliveries = validStagedDeliveries.filter((staged) => !staged.id);
  const existingDeliveries = validStagedDeliveries.filter((staged) => {
    if (!staged.id) return false;
    if (COMPLETION_STATUSES.includes(staged.status)) return false;
    return true;
  });

  return { newDeliveries, existingDeliveries };
};

export const applyParentPickupStoreToNewDeliveries = (newDeliveries, allDeliveries) => {
  return newDeliveries.map((delivery) => {
    if (!delivery?.patient_id || !delivery?.puid) return delivery;
    const parentPickup = allDeliveries?.find((item) => item && !item.patient_id && item.stop_id === delivery.puid);
    return parentPickup?.store_id
      ? { ...delivery, store_id: parentPickup.store_id, ampm_deliveries: parentPickup.ampm_deliveries || delivery.ampm_deliveries }
      : delivery;
  });
};

export const calculateSequentialTRAssignments = ({ newItems, existingItems, stores, allDeliveries, deliveryDate }) => {
  const groups = {};
  const assignments = new Map();

  [...newItems, ...existingItems].forEach((delivery) => {
    if (!delivery?.patient_id) return;
    const groupKey = `${delivery.store_id}_${delivery.driver_id}_${delivery.ampm_deliveries || 'AM'}`;

    if (!groups[groupKey]) {
      const store = stores?.find((item) => item && item.id === delivery.store_id);
      const pickup = allDeliveries?.find((item) => item && !item.patient_id && item.store_id === delivery.store_id && item.delivery_date === deliveryDate && item.driver_id === delivery.driver_id && (item.ampm_deliveries || 'AM') === (delivery.ampm_deliveries || 'AM'));
      let pickupTR = store?.base_tracking_number || 0;
      const parsedTR = parseInt(pickup?.tracking_number, 10);
      if (!Number.isNaN(parsedTR)) pickupTR = parsedTR;
      groups[groupKey] = { pickupTR, deliveries: [] };
    }

    groups[groupKey].deliveries.push(delivery);
  });

  Object.values(groups).forEach((group) => {
    [...group.deliveries]
      .sort((a, b) => (a.patient_name || '').localeCompare(b.patient_name || ''))
      .forEach((delivery, index) => {
        assignments.set(delivery.id || delivery._tempId, String(group.pickupTR + index + 1));
      });
  });

  return assignments;
};

export const attachTrackingNumbers = ({ newDeliveries, existingDeliveries, stores, allDeliveries, deliveryDate }) => {
  const deliveriesWithCorrectStores = applyParentPickupStoreToNewDeliveries(newDeliveries, allDeliveries);
  const trAssignments = calculateSequentialTRAssignments({
    newItems: deliveriesWithCorrectStores,
    existingItems: existingDeliveries.filter((delivery) => delivery?.status === 'Staged'),
    stores,
    allDeliveries,
    deliveryDate
  });

  return {
    deliveriesWithTRs: deliveriesWithCorrectStores.map((delivery) => ({
      ...delivery,
      tracking_number: trAssignments.get(delivery.id || delivery._tempId) ?? delivery.tracking_number
    })),
    existingDeliveriesWithTRs: existingDeliveries.map((delivery) => delivery?.status === 'Staged'
      ? { ...delivery, tracking_number: trAssignments.get(delivery.id || delivery._tempId) ?? delivery.tracking_number }
      : delivery)
  };
};

export const getStagedActivationStatus = (delivery) => {
  if (delivery.status !== 'Staged') return delivery.status;

  let newStatus = !delivery.patient_id ? 'en_route' : 'pending';
  if (delivery.patient_id) {
    const patientName = (delivery.patient_name || '').toLowerCase();
    const deliveryNotes = (delivery.delivery_notes || '').toLowerCase();
    const patientNotes = (delivery.delivery_instructions || '').toLowerCase();
    const deliveryAddress = (delivery.delivery_address || '').toLowerCase();
    const isInterStore = patientName.includes('interstore') || deliveryNotes.includes('interstore') || patientNotes.includes('interstore') || deliveryAddress.includes('(isp)') || deliveryAddress.includes('(isd)');
    if (isInterStore) newStatus = 'in_transit';
  }

  return newStatus;
};

export const buildExistingDeliveryBatchUpdate = (delivery) => {
  const finalStatus = getStagedActivationStatus(delivery);

  return {
    status: finalStatus,
    delivery_notes: delivery.delivery_notes || '',
    prescription_number: delivery.prescription_number || '',
    cod_total_amount_required: delivery.cod_total_amount_required || 0,
    delivery_instructions: delivery.delivery_instructions || '',
    tracking_number: delivery.tracking_number || '99',
    isNextDelivery: delivery.isNextDelivery && !['completed', 'failed', 'cancelled', 'returned', 'pending'].includes(finalStatus),
    signature_needed: delivery.signature_needed || false,
    fridge_item: delivery.fridge_item || false,
    oversized: delivery.oversized || false,
    barcode_values: Array.isArray(delivery.barcode_values) ? delivery.barcode_values : [],
    receipt_barcode_values: Array.isArray(delivery.receipt_barcode_values) ? delivery.receipt_barcode_values : [],
    no_charge: delivery.no_charge || false,
    extra_time: delivery.extra_time || 0,
    paid_km_override: delivery.paid_km_override ?? null,
    store_id: delivery.store_id || '',
    ampm_deliveries: delivery.ampm_deliveries || null,
    puid: delivery.puid || ''
  };
};

export const getDeliveryReadyForSave = (delivery) => {
  if (delivery.status !== 'Staged') return delivery;

  const { patient_name, patient_phone, unit_number, store_phone, delivery_stop_id, mailbox_ok, call_upon_arrival, ring_bell, dont_ring_bell, back_door, _wasEdited, ...deliveryPayload } = delivery;
  return { ...deliveryPayload, status: getStagedActivationStatus(delivery) };
};

export const getDeliveriesReadyForDB = (newDeliveries, deliveriesWithTRs) => {
  if (newDeliveries.length === 0) return [];
  return deliveriesWithTRs.map(getDeliveryReadyForSave);
};