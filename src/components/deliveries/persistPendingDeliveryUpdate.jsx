import { updateDeliveryLocal, updatePatientLocal } from '../utils/entityMutations';
import { buildPatientUpdatePayload } from '../utils/patientUpdateHelper';

export async function persistPendingDeliveryUpdate({
  selectedStaged,
  formData,
  patient,
  store,
  editingStagedId,
  distanceFromStore
}) {
  if (formData.patient_id) {
    try {
      await updatePatientLocal(formData.patient_id, buildPatientUpdatePayload(formData));
    } catch (error) {
      console.error('Failed to update patient:', error);
    }
  }

  const codAmount = formData.cod_total_amount_required > 0 ? formData.cod_total_amount_required / 100 : 0;
  const immediateUpdateData = {
    patient_id: formData.patient_id || '',
    delivery_date: formData.delivery_date,
    delivery_time_start: formData.delivery_time_start || '',
    delivery_time_end: formData.delivery_time_end || '',
    delivery_time_eta: formData.delivery_time_eta || '',
    time_window_start: formData.time_window_start || patient?.time_window_start || '',
    time_window_end: formData.time_window_end || patient?.time_window_end || '',
    status: formData.status || selectedStaged.status || 'pending',
    driver_name: formData.driver_name || '',
    driver_id: formData.driver_id || '',
    prescription_number: formData.prescription_number || '',
    delivery_instructions: formData.delivery_instructions || '',
    delivery_notes: formData.delivery_notes || '',
    cod_total_amount_required: codAmount,
    cod_payments: formData.cod_payments || selectedStaged.cod_payments || [],
    cod_payment_type: formData.cod_payment_type || 'No Payment',
    cod_amount: formData.cod_amount || '',
    tracking_number: formData.tracking_number || selectedStaged.tracking_number || '',
    stop_id: formData.stop_id || selectedStaged.stop_id || '',
    puid: formData.puid || selectedStaged.puid || '',
    store_id: formData.store_id || '',
    ampm_deliveries: formData.ampm_deliveries || selectedStaged.ampm_deliveries || null,
    signature_needed: formData.signature_needed || false,
    fridge_item: formData.fridge_item || false,
    oversized: formData.oversized || false,
    after_hours_pickup: formData.after_hours_pickup || false,
    no_charge: formData.no_charge || false,
    extra_time: formData.extra_time || 0,
    barcode_values: Array.isArray(formData.barcode_values) ? formData.barcode_values : [],
    receipt_barcode_values: Array.isArray(formData.receipt_barcode_values) ? formData.receipt_barcode_values : [],
    paid_km_override: formData.paid_km_override !== null && formData.paid_km_override !== undefined
      ? parseFloat(formData.paid_km_override.toFixed(2))
      : null
  };

  const updatedDelivery = await updateDeliveryLocal(selectedStaged.id, immediateUpdateData, {
    deferPolylineRefresh: true,
    skipSmartRefresh: true
  });

  return {
    stagedDelivery: {
      ...selectedStaged,
      ...updatedDelivery,
      ...immediateUpdateData,
      _tempId: editingStagedId,
      _wasEdited: false,
      patient_name: formData.patient_name || patient?.full_name || 'N/A (Pickup)',
      store_name: store.name,
      store_abbreviation: store.abbreviation,
      distanceFromStore: distanceFromStore,
      delivery_address: patient?.address || store.address
    },
    deliveryId: selectedStaged.id
  };
}