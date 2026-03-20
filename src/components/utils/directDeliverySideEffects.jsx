import { base44 } from '@/api/base44Client';

const hasCardCodPayment = (delivery) => (
  (Array.isArray(delivery?.cod_payments) && delivery.cod_payments.some((payment) =>
    ['Debit', 'Credit'].includes(payment?.type) && Number(payment?.amount || 0) > 0
  )) || ['Debit', 'Credit'].includes(delivery?.cod_payment_type)
);

export const triggerSquareCodCreate = ({ deliveryId, patientName, storeAbbreviation, codAmount, deliveryDate, storeId }) => {
  if (!deliveryId || Number(codAmount || 0) <= 0) return;
  setTimeout(() => {
    base44.functions.invoke('squareCreateCodItem', {
      deliveryId,
      patientName,
      storeAbbreviation,
      codAmount,
      deliveryDate,
      storeId
    }).catch((error) => console.warn('⚠️ [DeliverySideEffects] Square create skipped:', error?.message || error));
  }, 0);
};

export const triggerSquareCodDelete = ({ deliveryId, nextStatus, delivery, reason }) => {
  const deleteReason = reason || nextStatus;
  const shouldDelete = deleteReason === 'cod_removed' || (
    Number(delivery?.cod_total_amount_required || 0) > 0 && (
      nextStatus === 'failed' ||
      (nextStatus === 'completed' && hasCardCodPayment(delivery))
    )
  );

  if (!deliveryId || !shouldDelete) return;
  setTimeout(() => {
    base44.functions.invoke('squareDeleteCodItem', {
      deliveryId,
      reason: deleteReason
    }).catch((error) => console.warn('⚠️ [DeliverySideEffects] Square delete skipped:', error?.message || error));
  }, 0);
};

export const triggerPatientLastDeliverySync = ({ delivery, previousStatus }) => {
  if (!delivery?.patient_id || !['completed', 'failed'].includes(delivery?.status)) return;
  setTimeout(() => {
    base44.functions.invoke('syncPatientLastDeliveryDate', {
      data: delivery,
      old_data: { status: previousStatus },
      event: { type: 'update', entity_name: 'Delivery' }
    }).catch((error) => console.warn('⚠️ [DeliverySideEffects] last delivery sync skipped:', error?.message || error));
  }, 0);
};

export const triggerPickupCompletionSync = ({ delivery, previousStatus }) => {
  if (!delivery?.puid || !['completed', 'failed'].includes(delivery?.status)) return;
  setTimeout(() => {
    base44.functions.invoke('ensurePickupCompletion', {
      data: delivery,
      old_data: { status: previousStatus },
      event: { type: 'update', entity_name: 'Delivery' }
    }).catch((error) => console.warn('⚠️ [DeliverySideEffects] pickup completion sync skipped:', error?.message || error));
  }, 0);
};

export const runTerminalDeliverySideEffects = ({ delivery, previousStatus, nextStatus, overrides = {} }) => {
  const nextDelivery = { ...delivery, ...overrides, status: nextStatus };
  triggerPatientLastDeliverySync({ delivery: nextDelivery, previousStatus });
  triggerPickupCompletionSync({ delivery: nextDelivery, previousStatus });
  triggerSquareCodDelete({ deliveryId: nextDelivery.id, nextStatus, delivery: nextDelivery });
};