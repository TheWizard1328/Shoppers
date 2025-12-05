import { base44 } from '@/api/base44Client';
import { 
  NOTIFICATION_EVENTS, 
  shouldNotify, 
  getNotificationMessage, 
  getRecipients 
} from './notificationRules';

/**
 * Send an in-app message for delivery events
 */
export async function sendDeliveryMessage({
  senderId,
  senderName,
  receiverId,
  receiverName,
  content
}) {
  if (!senderId || !receiverId || !content) {
    console.warn('[deliveryMessaging] Missing required fields:', { senderId, receiverId, content });
    return;
  }

  const conversationId = [senderId, receiverId].sort().join('_');

  try {
    await base44.entities.Message.create({
      sender_id: senderId,
      sender_name: senderName || 'System',
      receiver_id: receiverId,
      receiver_name: receiverName || 'User',
      conversation_id: conversationId,
      content,
      read: false
    });
    console.log(`✉️ [deliveryMessaging] In-app message sent to ${receiverName}`);
  } catch (error) {
    console.error('[deliveryMessaging] Failed to send in-app message:', error);
  }
}

/**
 * Send notification through configured channels (in-app only)
 */
async function sendNotification({
  event,
  messageData,
  senderId,
  senderName,
  receiverId,
  receiverName
}) {
  const content = getNotificationMessage(event, messageData);
  if (!content) return;

  // Send in-app message if enabled
  if (shouldNotify(event, 'inApp')) {
    await sendDeliveryMessage({
      senderId,
      senderName,
      receiverId,
      receiverName,
      content
    });
  }
}

/**
 * Get dispatchers assigned to a store
 */
export function getDispatchersForStore(storeId, appUsers) {
  if (!storeId || !appUsers) return [];
  
  return appUsers.filter(user => {
    if (!user || !user.app_roles) return false;
    if (!user.app_roles.includes('dispatcher')) return false;
    if (user.status !== 'active') return false;
    const storeIds = user.store_ids || [];
    return storeIds.includes(storeId);
  });
}

/**
 * Build special badges string for a delivery
 */
export function buildSpecialBadges(delivery, patient) {
  const badges = [];
  
  const hasCOD = delivery?.cod_total_amount_required > 0;
  const isFirstDelivery = delivery?.first_delivery || 
    patient?.notes?.toLowerCase().includes('first delivery') ||
    delivery?.delivery_instructions?.toLowerCase().includes('first delivery');
  const hasOversized = delivery?.oversized === true;
  const hasFridge = delivery?.fridge_item === true;
  const hasSignature = delivery?.signature_needed === true;

  if (hasCOD) badges.push('💵 COD');
  if (isFirstDelivery) badges.push('🆕 New');
  if (hasOversized) badges.push('📦 Oversized');
  if (hasFridge) badges.push('❄️ Fridge');
  if (hasSignature) badges.push('✍️ Signature');

  return badges.length > 0 ? ` [${badges.join(', ')}]` : '';
}

/**
 * Format time to 12-hour format
 */
function formatTime12Hour(timeString) {
  if (!timeString) return '';
  try {
    const timeParts = timeString.split(':');
    if (timeParts.length < 2) return timeString;
    const hours = parseInt(timeParts[0], 10);
    const minutes = parseInt(timeParts[1], 10);
    if (isNaN(hours) || isNaN(minutes)) return timeString;
    const period = hours >= 12 ? 'PM' : 'AM';
    const displayHours = hours % 12 || 12;
    return `${displayHours}:${String(minutes).padStart(2, '0')} ${period}`;
  } catch {
    return timeString;
  }
}

/**
 * Build ETA string for message
 */
export function buildETAString(delivery) {
  const eta = delivery?.delivery_time_eta || delivery?.delivery_time_start;
  if (!eta) return '';
  return ` (ETA: ${formatTime12Hour(eta)})`;
}

/**
 * Calculate distance between two coordinates in km
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
  if (!lat1 || !lon1 || !lat2 || !lon2) return null;
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Build distance badge from store
 */
export function buildDistanceBadge(patient, store) {
  if (!patient?.latitude || !patient?.longitude || !store?.latitude || !store?.longitude) {
    return '';
  }
  const distance = calculateDistance(
    store.latitude, store.longitude,
    patient.latitude, patient.longitude
  );
  if (distance === null) return '';
  return ` [${distance.toFixed(1)} km]`;
}

/**
 * Get or create a store user for messaging
 * If the store doesn't have a user yet, creates one on-the-fly
 */
async function getStoreUser(store) {
  if (!store || !store.id) {
    console.warn('[deliveryMessaging] Invalid store');
    return null;
  }
  
  try {
    // Search for existing store user by name pattern
    const storeUserName = `${store.name} (Store)`;
    const existingUsers = await base44.entities.AppUser.filter({ 
      user_name: storeUserName 
    });
    
    if (existingUsers && existingUsers.length > 0) {
      return {
        id: existingUsers[0].user_id,
        user_name: existingUsers[0].user_name
      };
    }
    
    // If no store user exists, return store data directly for message creation
    // (we'll use store.id as sender, but won't create an actual AppUser)
    console.log(`[deliveryMessaging] Using store "${store.name}" as message sender`);
    return {
      id: `store_${store.id}`,
      user_name: storeUserName
    };
  } catch (error) {
    console.error('[deliveryMessaging] Error getting store user:', error);
    return null;
  }
}

// ============ NOTIFICATION FUNCTIONS ============
// These use the centralized rules from notificationRules.js

/**
 * 1. Driver accepts all pending deliveries
 * Message FROM store TO driver
 */
export async function notifyDriverAcceptedAll({
  driver,
  store,
  appUsers
}) {
  if (!shouldNotify(NOTIFICATION_EVENTS.DRIVER_ACCEPTED_ALL, 'inApp') && 
      !shouldNotify(NOTIFICATION_EVENTS.DRIVER_ACCEPTED_ALL, 'whatsApp')) return;

  const storeUser = await getStoreUser(store);
  if (!storeUser) return;

  const driverName = driver?.user_name || driver?.full_name || 'Driver';
  const messageData = { driverName };

  // Message FROM store TO driver
  await sendNotification({
    event: NOTIFICATION_EVENTS.DRIVER_ACCEPTED_ALL,
    messageData,
    senderId: storeUser.id,
    senderName: storeUser.user_name,
    receiverId: driver?.id,
    receiverName: driverName
  });
}

/**
 * 2. Driver accepts single delivery
 * Message FROM store TO driver
 */
export async function notifyDriverAcceptedOne({
  driver,
  patientName,
  store,
  appUsers
}) {
  if (!shouldNotify(NOTIFICATION_EVENTS.DRIVER_ACCEPTED_ONE, 'inApp') && 
      !shouldNotify(NOTIFICATION_EVENTS.DRIVER_ACCEPTED_ONE, 'whatsApp')) return;

  const storeUser = await getStoreUser(store);
  if (!storeUser) return;

  const driverName = driver?.user_name || driver?.full_name || 'Driver';
  const messageData = { driverName, patientName };

  // Message FROM store TO driver
  await sendNotification({
    event: NOTIFICATION_EVENTS.DRIVER_ACCEPTED_ONE,
    messageData,
    senderId: storeUser.id,
    senderName: storeUser.user_name,
    receiverId: driver?.id,
    receiverName: driverName
  });
}

/**
 * 3. Dispatcher assigns all deliveries to driver
 * Message FROM store TO driver
 */
export async function notifyDispatcherAssignedAll({
  dispatcher,
  driver,
  store,
  deliveries,
  patients
}) {
  if (!shouldNotify(NOTIFICATION_EVENTS.DISPATCHER_ASSIGNED_ALL, 'inApp') && 
      !shouldNotify(NOTIFICATION_EVENTS.DISPATCHER_ASSIGNED_ALL, 'whatsApp')) return;

  const storeUser = await getStoreUser(store);
  if (!storeUser) return;

  const storeName = store?.name || 'Store';
  
  let deliveryList = '';
  for (const delivery of deliveries) {
    const patient = patients?.find(p => p?.id === delivery.patient_id);
    const patientName = patient?.full_name || delivery.patient_name || 'Unknown';
    const badges = buildSpecialBadges(delivery, patient);
    const distance = buildDistanceBadge(patient, store);
    deliveryList += `\n• ${patientName}${badges}${distance}`;
  }

  const messageData = { storeName, deliveryList };

  // Message FROM store TO driver
  await sendNotification({
    event: NOTIFICATION_EVENTS.DISPATCHER_ASSIGNED_ALL,
    messageData,
    senderId: storeUser.id,
    senderName: storeUser.user_name,
    receiverId: driver?.id || driver?.user_id,
    receiverName: driver?.user_name || driver?.full_name
  });
}

/**
 * 4. Driver starts delivery (moves to next)
 * Message FROM store TO driver
 */
export async function notifyDriverStarted({
  driver,
  patientName,
  delivery,
  store,
  appUsers
}) {
  if (!shouldNotify(NOTIFICATION_EVENTS.DRIVER_STARTED, 'inApp') && 
      !shouldNotify(NOTIFICATION_EVENTS.DRIVER_STARTED, 'whatsApp')) return;

  const storeUser = await getStoreUser(store);
  if (!storeUser) return;

  const driverName = driver?.user_name || driver?.full_name || 'Driver';
  const eta = buildETAString(delivery);
  const messageData = { driverName, patientName, eta };

  // Message FROM store TO driver
  await sendNotification({
    event: NOTIFICATION_EVENTS.DRIVER_STARTED,
    messageData,
    senderId: storeUser.id,
    senderName: storeUser.user_name,
    receiverId: driver?.id,
    receiverName: driverName
  });
}

/**
 * 5. Driver completes delivery
 * Message FROM store TO driver
 */
export async function notifyDriverCompleted({
  driver,
  patientName,
  delivery,
  store,
  appUsers
}) {
  if (!shouldNotify(NOTIFICATION_EVENTS.DRIVER_COMPLETED, 'inApp') && 
      !shouldNotify(NOTIFICATION_EVENTS.DRIVER_COMPLETED, 'whatsApp')) return;

  const storeUser = await getStoreUser(store);
  if (!storeUser) return;

  const driverName = driver?.user_name || driver?.full_name || 'Driver';
  const eta = buildETAString(delivery);
  const messageData = { driverName, patientName, eta };

  // Message FROM store TO driver
  await sendNotification({
    event: NOTIFICATION_EVENTS.DRIVER_COMPLETED,
    messageData,
    senderId: storeUser.id,
    senderName: storeUser.user_name,
    receiverId: driver?.id,
    receiverName: driverName
  });
}

/**
 * 6. Driver marks delivery as failed
 * Message FROM store TO driver
 */
export async function notifyDriverFailed({
  driver,
  patientName,
  delivery,
  store,
  appUsers
}) {
  if (!shouldNotify(NOTIFICATION_EVENTS.DRIVER_FAILED, 'inApp') && 
      !shouldNotify(NOTIFICATION_EVENTS.DRIVER_FAILED, 'whatsApp')) return;

  const storeUser = await getStoreUser(store);
  if (!storeUser) return;

  const driverName = driver?.user_name || driver?.full_name || 'Driver';
  const eta = buildETAString(delivery);
  const messageData = { driverName, patientName, eta };

  // Message FROM store TO driver
  await sendNotification({
    event: NOTIFICATION_EVENTS.DRIVER_FAILED,
    messageData,
    senderId: storeUser.id,
    senderName: storeUser.user_name,
    receiverId: driver?.id,
    receiverName: driverName
  });
}

/**
 * 7. Driver retries delivery
 * Message FROM store TO driver
 */
export async function notifyDriverRetry({
  driver,
  patientName,
  delivery,
  store,
  appUsers
}) {
  if (!shouldNotify(NOTIFICATION_EVENTS.DRIVER_RETRY, 'inApp') && 
      !shouldNotify(NOTIFICATION_EVENTS.DRIVER_RETRY, 'whatsApp')) return;

  const storeUser = await getStoreUser(store);
  if (!storeUser) return;

  const driverName = driver?.user_name || driver?.full_name || 'Driver';
  const eta = buildETAString(delivery);
  const messageData = { driverName, patientName, eta };

  // Message FROM store TO driver
  await sendNotification({
    event: NOTIFICATION_EVENTS.DRIVER_RETRY,
    messageData,
    senderId: storeUser.id,
    senderName: storeUser.user_name,
    receiverId: driver?.id,
    receiverName: driverName
  });
}

/**
 * 8. Driver initiates return
 * Message FROM store TO driver
 */
export async function notifyDriverReturn({
  driver,
  patientName,
  delivery,
  store,
  appUsers
}) {
  if (!shouldNotify(NOTIFICATION_EVENTS.DRIVER_RETURN, 'inApp') && 
      !shouldNotify(NOTIFICATION_EVENTS.DRIVER_RETURN, 'whatsApp')) return;

  const storeUser = await getStoreUser(store);
  if (!storeUser) return;

  const driverName = driver?.user_name || driver?.full_name || 'Driver';
  const eta = buildETAString(delivery);
  const messageData = { driverName, patientName, eta };

  // Message FROM store TO driver
  await sendNotification({
    event: NOTIFICATION_EVENTS.DRIVER_RETURN,
    messageData,
    senderId: storeUser.id,
    senderName: storeUser.user_name,
    receiverId: driver?.id,
    receiverName: driverName
  });
}