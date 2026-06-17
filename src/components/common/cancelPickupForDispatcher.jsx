import { base44 } from '@/api/base44Client';
import { offlineDB } from '@/components/utils/offlineDatabase';
import { sendDeliveryMessage } from '@/components/utils/deliveryMessaging';
import { toast } from 'sonner';

/**
 * Cancel a store pickup card for dispatchers.
 * 1) Deletes from online + offline DB
 * 2) Broadcasts the deletion
 * 3) Sends an in-app message to the assigned driver
 * 4) Activates the reoptimize route FAB
 */
export async function cancelPickupForDispatcher({ delivery, store, appUsers, currentUser }) {
  if (!delivery?.id) return;

  const storeName = store?.name || 'The store';
  const driverId = delivery.driver_id;
  const deliveryDate = delivery.delivery_date;

  // 1) Delete from online DB
  await base44.entities.Delivery.delete(delivery.id);

  // 2) Delete from offline DB (best effort)
  try {
    await offlineDB.delete(offlineDB.STORES.DELIVERIES, delivery.id);
  } catch (_) {}

  // 3) Broadcast deletion so all components update
  window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
    detail: {
      triggeredBy: 'cancelPickup',
      driverId,
      deliveryDate,
      deletedDeliveryId: delivery.id,
    }
  }));

  // 4) Send in-app message to assigned driver
  if (driverId && appUsers) {
    const driverAppUser = appUsers.find((u) => u?.user_id === driverId);
    const driverName = driverAppUser?.user_name || 'Driver';
    const senderId = currentUser?.id || 'system';
    const senderName = currentUser?.user_name || currentUser?.full_name || 'Dispatcher';

    await sendDeliveryMessage({
      senderId,
      senderName,
      receiverId: driverId,
      receiverName: driverName,
      content: `🚫 ${storeName} has cancelled for today. There are no deliveries.`,
    }).catch(() => {});

    // Show on-screen toast for everyone currently viewing this route
    toast(`🚫 ${storeName} has cancelled for today. There are no deliveries.`, { duration: 8000 });
  }

  // 5) Trigger polyline refresh for the driver's route
  if (driverId && deliveryDate) {
    base44.functions.invoke('purgeAndRegeneratePolylines', { driverId, deliveryDate }).catch(() => {});
  }
}