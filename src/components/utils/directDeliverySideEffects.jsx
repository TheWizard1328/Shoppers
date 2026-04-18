import { base44 } from '@/api/base44Client';
import { shouldRefreshEtasForCompletionDrift, markEtaRefreshRun } from './etaRefreshRules';

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

export const triggerSquareCodUpsert = ({ deliveryId, patientName, storeAbbreviation, codAmount, deliveryDate, storeId }) => {
  if (!deliveryId || Number(codAmount || 0) <= 0) return;
  setTimeout(() => {
    base44.functions.invoke('squareCreateCodItem', {
      deliveryId,
      patientName,
      storeAbbreviation,
      codAmount,
      deliveryDate,
      storeId
    }).catch((error) => console.warn('⚠️ [DeliverySideEffects] Square upsert skipped:', error?.message || error));
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
  const deliveryDate = nextDelivery.delivery_date;
  const driverId = nextDelivery.driver_id;

  // If no arrival_time recorded, synthesize one as 1 minute before actual_delivery_time
  if (!nextDelivery.arrival_time && nextDelivery.actual_delivery_time) {
    try {
      const actualTime = new Date(nextDelivery.actual_delivery_time);
      if (!isNaN(actualTime.getTime())) {
        const syntheticArrival = new Date(actualTime.getTime() - 60000);
        const pad = (n) => String(n).padStart(2, '0');
        // Store as local time string matching the same format as actual_delivery_time (YYYY-MM-DDTHH:MM:SS)
        nextDelivery.arrival_time = `${syntheticArrival.getFullYear()}-${pad(syntheticArrival.getMonth() + 1)}-${pad(syntheticArrival.getDate())}T${pad(syntheticArrival.getHours())}:${pad(syntheticArrival.getMinutes())}:${pad(syntheticArrival.getSeconds())}`;
        setTimeout(() => {
          base44.entities.Delivery.update(nextDelivery.id, { arrival_time: nextDelivery.arrival_time })
            .catch((err) => console.warn('⚠️ [SideEffects] Failed to save synthetic arrival_time:', err?.message || err));
        }, 0);
      }
    } catch (_) {}
  }

  triggerPatientLastDeliverySync({ delivery: nextDelivery, previousStatus });
  triggerPickupCompletionSync({ delivery: nextDelivery, previousStatus });
  triggerSquareCodDelete({ deliveryId: nextDelivery.id, nextStatus, delivery: nextDelivery });

  if (
    nextStatus === 'completed' &&
    driverId &&
    deliveryDate &&
    shouldRefreshEtasForCompletionDrift({
      driverId,
      deliveryDate,
      actualDeliveryTime: nextDelivery.actual_delivery_time,
      now: new Date()
    })
  ) {
    const now = new Date();
    const currentLocalTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    setTimeout(() => {
      base44.functions.invoke('calculateRealTimeETA', {
        driverId,
        deliveryDate,
        currentLocalTime
      }).then(() => {
        markEtaRefreshRun({ driverId, deliveryDate, now: Date.now() });
      }).catch(() => null);
    }, 0);
  }
};