import { base44 } from '@/api/base44Client';
import { format } from 'date-fns';
import { invalidate } from '@/components/utils/dataManager';
import { getOrFetchHereApiKey } from '@/components/utils/hereApiKeyStore';
import { offlineDB } from '@/components/utils/offlineDatabase';

/**
 * Quick Adjust reorder: persists the new stop_order from the drag, then runs
 * optimizeRemainingStops with preserveExistingOrder=true so ETAs are recalculated
 * from the driver's live GPS position using the same logic as the manual FAB.
 * New polylines are regenerated via regenerateType1Polyline after ETAs are set.
 */
export async function handleQuickReorder(reorderUpdates, selectedDate, currentUser, updateDeliveryLocal, { appUsers } = {}) {
  const deliveryDate = format(selectedDate, 'yyyy-MM-dd');

  // 1. Persist the new stop_order values that the user dragged into place
  for (const update of reorderUpdates) {
    await updateDeliveryLocal(update.id, { stop_order: update.stop_order });
  }

  // 2. Recalculate ETAs (preserving the new order) via the same optimizer as the FAB
  const now = new Date();
  const currentLocalTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const hereApiKey = await getOrFetchHereApiKey();

  await base44.functions.invoke('optimizeRemainingStops', {
    driverId: currentUser.id,
    deliveryDate,
    currentLocalTime,
    deviceTime: now.toISOString(),
    hereApiKey,
    preserveExistingOrder: true,
    bypassDriverStatus: true,
    bypassDeduplication: true,
    triggerSource: 'quick_reorder',
  });

  // 3. Regenerate polylines for the new stop sequence
  const driverAppUser = Array.isArray(appUsers)
    ? appUsers.find(au => au?.user_id === currentUser.id || au?.id === currentUser.id)
    : null;
  if (driverAppUser?.current_latitude && driverAppUser?.current_longitude) {
    await base44.functions.invoke('regenerateType1Polyline', {
      driverId: currentUser.id,
      deliveryDate,
      currentLocation: { lat: driverAppUser.current_latitude, lon: driverAppUser.current_longitude },
      orderedDeliveryIds: reorderUpdates.map(u => u.id),
      routeChangeSource: 'quick_reorder',
      force: true,
    }).catch((e) => console.warn('⚠️ [quickReorder] polyline regen failed:', e.message));
  }

  // 4. Refresh UI with fresh data
  invalidate('Delivery');
  const freshDeliveries = await base44.entities.Delivery.filter({
    driver_id: currentUser.id,
    delivery_date: deliveryDate
  });

  if (Array.isArray(freshDeliveries) && freshDeliveries.length > 0) {
    await Promise.all(freshDeliveries.map(d => offlineDB.save(offlineDB.STORES.DELIVERIES, d).catch(() => {})));
  }

  window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
    detail: {
      triggeredBy: 'quickReorder',
      freshDeliveries,
      fullReplacement: false,
    }
  }));
}