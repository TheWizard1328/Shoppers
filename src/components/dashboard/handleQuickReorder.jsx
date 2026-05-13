import { base44 } from '@/api/base44Client';
import { format } from 'date-fns';
import { invalidate } from '@/components/utils/dataManager';

export async function handleQuickReorder(reorderUpdates, selectedDate, currentUser, updateDeliveryLocal) {
  // Apply local updates first
  for (const update of reorderUpdates) {
    await updateDeliveryLocal(update.id, { stop_order: update.stop_order });
  }

  // Get ordered delivery IDs from the reordered updates
  const deliveryDate = format(selectedDate, 'yyyy-MM-dd');
  const orderedDeliveryIds = reorderUpdates.map(u => u.id);

  // Delegate polyline generation and ETA recalculation to purgeAndRegeneratePolylines
  await base44.functions.invoke('purgeAndRegeneratePolylines', {
    driverId: currentUser.id,
    deliveryDate,
    orderedDeliveryIds,
    recalculateEtas: true
  });

  // Refresh UI with fresh data
  invalidate('Delivery');
  const freshDeliveries = await base44.entities.Delivery.filter({
    driver_id: currentUser.id,
    delivery_date: deliveryDate
  });
  
  window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
    detail: {
      triggeredBy: 'quickReorder',
      freshDeliveries,
      fullReplacement: false
    }
  }));
}