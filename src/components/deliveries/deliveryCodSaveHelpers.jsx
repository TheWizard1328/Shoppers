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

  return {
    ...dataToSave,
    cod_total_amount_required: codRequired ? Math.round(Number(formData.cod_total_amount_required || 0)) / 100 : 0,
    cod_payments: codRequired ? dataToSave.cod_payments : [],
    cod_payment_type: codRequired ? dataToSave.cod_payment_type : 'No Payment',
    cod_amount: codRequired ? dataToSave.cod_amount : '',
    receipt_barcode_values: Array.isArray(formData.receipt_barcode_values) ? formData.receipt_barcode_values : []
  };
}