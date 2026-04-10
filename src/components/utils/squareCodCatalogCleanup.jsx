import { base44 } from '@/api/base44Client';
import { deleteCODWithTimeout } from './squareCODHandler';

export async function cleanupSquareCodCatalogForDate(deliveryDate) {
  if (!deliveryDate) return;

  try {
    const deliveries = await base44.entities.Delivery.filter({ delivery_date: deliveryDate });
    const deliveriesToCleanup = (deliveries || []).filter((delivery) => {
      if (!delivery) return false;
      if (delivery.status !== 'completed') return false;
      return Number(delivery.cod_total_amount_required || 0) > 0;
    });

    if (deliveriesToCleanup.length === 0) return;

    await Promise.all(
      deliveriesToCleanup.map((delivery) =>
        deleteCODWithTimeout(delivery.id, 'Removed after completed COD delivery cleanup')
      )
    );
  } catch (error) {
    console.warn('⚠️ [Square] COD catalog cleanup failed:', error?.message || error);
  }
}