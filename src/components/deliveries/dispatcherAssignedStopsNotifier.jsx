/**
 * Dispatcher Assigned Stops notifier.
 *
 * Fires when a dispatcher clicks the "Done" button on the Add To Route form and
 * creates/activates pending patient deliveries on a driver's route.
 *
 * Resolution order:
 *   1. New Rule Engine (MessageRule entity) for event `dispatcher_assigned_all`
 *      — fires if at least one enabled rule matches.
 *   2. Legacy fallback (`notifyDispatcherAssignedAll`) which honours the
 *      NotificationTemplate entity config and the hardcoded buildMessage.
 *
 * Only ONE path delivers messages — if the rule engine handled the event,
 * the legacy fallback is skipped.
 */
import { base44 } from '@/api/base44Client';
import { dispatchMessageRules, clearRuleCache } from '@/components/utils/messageRuleEngine';
import { getNotificationLabel } from '@/components/utils/notificationRules';
import {
  notifyDispatcherAssignedAll,
  sendDeliveryMessage,
  sendPushForNotification,
  getStoreUser,
  buildSpecialBadges,
  buildDistanceBadge,
} from '../utils/deliveryMessaging';

export async function notifyDispatcherAssignedStops({
  dispatcher,
  driver,
  store,
  deliveries,
  patients,
}) {
  if (!deliveries || deliveries.length === 0 || !driver) return;

  const storeName = store?.name || 'Store';
  const driverName = driver?.user_name || driver?.full_name || 'Driver';
  const driverId = driver?.user_id || driver?.id;

  // Build the patient delivery list with badges + distance (legacy format)
  let deliveryList = '';
  for (const delivery of deliveries) {
    const patient = patients?.find((p) => p?.id === delivery?.patient_id);
    const patientName = patient?.full_name || delivery?.patient_name || 'Unknown';
    const badges = buildSpecialBadges(delivery, patient);
    const distance = buildDistanceBadge(patient, store);
    deliveryList += `\n• ${patientName}${badges}${distance}`;
  }

  // Resolve store-pseudo-user sender lazily (needed for in-app messages)
  let senderPromise = null;
  const getSender = () => {
    if (!senderPromise) senderPromise = getStoreUser(store);
    return senderPromise;
  };

  const sendInApp = async (userId, message, eventName) => {
    const sender = await getSender();
    if (!sender) return; // No store sender — skip in-app, push still goes out
    const label = getNotificationLabel(eventName);
    const content = label ? `[${label}]\n${message}` : message;
    await sendDeliveryMessage({
      senderId: sender.id,
      senderName: sender.user_name,
      receiverId: userId,
      receiverName: userId === driverId ? driverName : 'User',
      content,
    });
  };

  const sendPush = async (userId, message, eventName) => {
    await sendPushForNotification({
      receiverId: userId,
      senderName: storeName,
      content: message,
      event: eventName,
    });
  };

  const context = {
    eventName: 'Dispatcher Assigned Stops',
    driverName,
    storeName,
    deliveryList,
    pendingCount: String(deliveries.length),
    status: 'pending',
    store_id: store?.id,
    driver_id: driverId,
    delivery_status: 'pending',
    user_role: 'dispatcher',
    timestamp: new Date().toLocaleString(),
  };

  // Force a fresh rule load so newly-created rules are picked up immediately
  clearRuleCache();

  let handled = false;
  try {
    const result = await dispatchMessageRules(
      'dispatcher_assigned_all',
      context,
      sendInApp,
      sendPush,
    );
    handled = !!result?.handled;
  } catch (e) {
    console.warn('[DispatcherAssignedStops] rule engine failed:', e?.message || e);
  }
  if (handled) return;

  // Fall back to the legacy system (NotificationTemplate entity aware)
  try {
    await notifyDispatcherAssignedAll({ dispatcher, driver, store, deliveries, patients });
  } catch (e) {
    console.warn('[DispatcherAssignedStops] legacy fallback failed:', e?.message || e);
  }
}