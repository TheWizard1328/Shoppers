import { base44 } from '@/api/base44Client';
import { deleteCODWithTimeout } from './squareCODHandler';

const hasDebitOrCreditPayment = (delivery) => {
  const payments = Array.isArray(delivery?.cod_payments) ? delivery.cod_payments : [];
  if (payments.some((payment) => ['Debit', 'Credit'].includes(payment?.type) && Number(payment?.amount || 0) > 0)) {
    return true;
  }
  return ['Debit', 'Credit'].includes(delivery?.cod_payment_type);
};

export async function cleanupSquareCodCatalogForDate(deliveryDate) {
  if (!deliveryDate) return;

  try {
    const deliveries = await base44.entities.Delivery.filter({ delivery_date: deliveryDate });
    const deliveriesToCleanup = (deliveries || []).filter((delivery) => {
      if (!delivery) return false;
      if (delivery.status !== 'completed') return false;
      if (Number(delivery.cod_total_amount_required || 0) <= 0) return false;
      return hasDebitOrCreditPayment(delivery);
    });

    if (deliveriesToCleanup.length === 0) return;

    await Promise.all(
      deliveriesToCleanup.map((delivery) =>
        deleteCODWithTimeout(delivery.id, 'Removed after debit/credit COD completion audit')
      )
    );
  } catch (error) {
    console.warn('⚠️ [Square] COD catalog cleanup failed:', error?.message || error);
  }
}