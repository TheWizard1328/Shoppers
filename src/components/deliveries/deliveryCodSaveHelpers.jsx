import { updateSquareCODIfChanged } from '../utils/squareCODUpdater';

export async function syncDeliveryCodOnUpdate({
  delivery,
  formData,
  stores,
  base44,
  dataToSave
}) {
  if (!delivery?.id) return;

  const codRequired = Number(formData.cod_total_amount_required || 0) > 0;

  await updateSquareCODIfChanged({
    delivery,
    initialCodCents: Math.round(Number(delivery.cod_total_amount_required || 0) * 100),
    currentCodCents: codRequired ? Math.round(Number(formData.cod_total_amount_required || 0)) : 0,
    formData,
    stores,
    base44,
    dataToSave
  });
}

export function buildUpdatedDeliveryPayload({ dataToSave, formData }) {
  const codRequired = Number(formData.cod_total_amount_required || 0) > 0;

  const payload = {
    ...dataToSave,
    cod_total_amount_required: codRequired ? Math.round(Number(formData.cod_total_amount_required || 0)) / 100 : 0,
    cod_payments: codRequired ? dataToSave.cod_payments : [],
    cod_payment_type: codRequired ? dataToSave.cod_payment_type : 'No Payment',
    cod_amount: codRequired ? dataToSave.cod_amount : '',
    receipt_barcode_values: Array.isArray(formData.receipt_barcode_values) ? formData.receipt_barcode_values : []
  };

  // Preserve cycling marker fields on update
  if (formData.is_cycling_marker !== undefined) payload.is_cycling_marker = formData.is_cycling_marker;
  if (formData.cycling_latitude !== undefined) payload.cycling_latitude = formData.cycling_latitude;
  if (formData.cycling_longitude !== undefined) payload.cycling_longitude = formData.cycling_longitude;

  return payload;
}