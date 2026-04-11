import { updateSquareCODIfChanged } from '../utils/squareCODUpdater';

export async function syncDeliveryCodOnUpdate({
  delivery,
  formData,
  stores,
  base44,
  dataToSave
}) {
  if (!delivery?.id) return;

  await updateSquareCODIfChanged({
    delivery,
    initialCodCents: Math.round(Number(delivery.cod_total_amount_required || 0) * 100),
    currentCodCents: Math.round(Number(formData.cod_total_amount_required || 0)),
    formData,
    stores,
    base44,
    dataToSave
  });
}

export function buildUpdatedDeliveryPayload({ dataToSave, formData }) {
  return {
    ...dataToSave,
    cod_total_amount_required: Math.round(Number(formData.cod_total_amount_required || 0)) / 100,
    receipt_barcode_values: Array.isArray(formData.receipt_barcode_values) ? formData.receipt_barcode_values : []
  };
}