import { base44 } from '@/api/base44Client';

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
    console.log(`✉️ [deliveryMessaging] Message sent to ${receiverName}`);
  } catch (error) {
    console.error('[deliveryMessaging] Failed to send message:', error);
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
  return ` [📍 ${distance.toFixed(1)} km]`;
}

// ============ MESSAGE BUILDERS ============

/**
 * 1. Driver accepts all pending deliveries
 */
export async function notifyDriverAcceptedAll({
  driver,
  store,
  appUsers
}) {
  const dispatchers = getDispatchersForStore(store?.id, appUsers);
  const driverName = driver?.user_name || driver?.full_name || 'Driver';
  const content = `${driverName} has accepted all pending deliveries.`;

  for (const dispatcher of dispatchers) {
    await sendDeliveryMessage({
      senderId: driver?.id,
      senderName: driverName,
      receiverId: dispatcher.user_id,
      receiverName: dispatcher.user_name,
      content
    });
  }
}

/**
 * 2. Driver accepts single delivery
 */
export async function notifyDriverAcceptedOne({
  driver,
  patientName,
  store,
  appUsers
}) {
  const dispatchers = getDispatchersForStore(store?.id, appUsers);
  const driverName = driver?.user_name || driver?.full_name || 'Driver';
  const content = `${driverName} has accepted delivery for ${patientName || 'Unknown Patient'}.`;

  for (const dispatcher of dispatchers) {
    await sendDeliveryMessage({
      senderId: driver?.id,
      senderName: driverName,
      receiverId: dispatcher.user_id,
      receiverName: dispatcher.user_name,
      content
    });
  }
}

/**
 * 3. Dispatcher assigns all deliveries to driver
 */
export async function notifyDispatcherAssignedAll({
  dispatcher,
  driver,
  store,
  deliveries,
  patients
}) {
  const dispatcherName = dispatcher?.user_name || dispatcher?.full_name || 'Dispatcher';
  const storeName = store?.name || 'Store';
  
  let deliveryList = '';
  for (const delivery of deliveries) {
    const patient = patients?.find(p => p?.id === delivery.patient_id);
    const patientName = patient?.full_name || delivery.patient_name || 'Unknown';
    const badges = buildSpecialBadges(delivery, patient);
    const distance = buildDistanceBadge(patient, store);
    deliveryList += `\n• ${patientName}${badges}${distance}`;
  }

  const content = `${storeName} has assigned you the following deliveries:${deliveryList}`;

  await sendDeliveryMessage({
    senderId: dispatcher?.id,
    senderName: dispatcherName,
    receiverId: driver?.id || driver?.user_id,
    receiverName: driver?.user_name || driver?.full_name,
    content
  });
}

/**
 * 4. Driver starts delivery (moves to next)
 */
export async function notifyDriverStarted({
  driver,
  patientName,
  delivery,
  store,
  appUsers
}) {
  const dispatchers = getDispatchersForStore(store?.id, appUsers);
  const driverName = driver?.user_name || driver?.full_name || 'Driver';
  const eta = buildETAString(delivery);
  const content = `${driverName} has moved ${patientName || 'Unknown Patient'} to next delivery.${eta}`;

  for (const dispatcher of dispatchers) {
    await sendDeliveryMessage({
      senderId: driver?.id,
      senderName: driverName,
      receiverId: dispatcher.user_id,
      receiverName: dispatcher.user_name,
      content
    });
  }
}

/**
 * 5. Driver completes delivery
 */
export async function notifyDriverCompleted({
  driver,
  patientName,
  delivery,
  store,
  appUsers
}) {
  const dispatchers = getDispatchersForStore(store?.id, appUsers);
  const driverName = driver?.user_name || driver?.full_name || 'Driver';
  const eta = buildETAString(delivery);
  const content = `${driverName} has completed delivery for ${patientName || 'Unknown Patient'}.${eta}`;

  for (const dispatcher of dispatchers) {
    await sendDeliveryMessage({
      senderId: driver?.id,
      senderName: driverName,
      receiverId: dispatcher.user_id,
      receiverName: dispatcher.user_name,
      content
    });
  }
}

/**
 * 6. Driver marks delivery as failed
 */
export async function notifyDriverFailed({
  driver,
  patientName,
  delivery,
  store,
  appUsers
}) {
  const dispatchers = getDispatchersForStore(store?.id, appUsers);
  const driverName = driver?.user_name || driver?.full_name || 'Driver';
  const eta = buildETAString(delivery);
  const content = `${driverName} failed to complete delivery for ${patientName || 'Unknown Patient'}.${eta}`;

  for (const dispatcher of dispatchers) {
    await sendDeliveryMessage({
      senderId: driver?.id,
      senderName: driverName,
      receiverId: dispatcher.user_id,
      receiverName: dispatcher.user_name,
      content
    });
  }
}

/**
 * 7. Driver retries delivery
 */
export async function notifyDriverRetry({
  driver,
  patientName,
  delivery,
  store,
  appUsers
}) {
  const dispatchers = getDispatchersForStore(store?.id, appUsers);
  const driverName = driver?.user_name || driver?.full_name || 'Driver';
  const eta = buildETAString(delivery);
  const content = `${driverName} is now retrying delivery for ${patientName || 'Unknown Patient'}.${eta}`;

  for (const dispatcher of dispatchers) {
    await sendDeliveryMessage({
      senderId: driver?.id,
      senderName: driverName,
      receiverId: dispatcher.user_id,
      receiverName: dispatcher.user_name,
      content
    });
  }
}

/**
 * 8. Driver initiates return
 */
export async function notifyDriverReturn({
  driver,
  patientName,
  delivery,
  store,
  appUsers
}) {
  const dispatchers = getDispatchersForStore(store?.id, appUsers);
  const driverName = driver?.user_name || driver?.full_name || 'Driver';
  const eta = buildETAString(delivery);
  const content = `${driverName} is En Route to return delivery for ${patientName || 'Unknown Patient'}.${eta}`;

  for (const dispatcher of dispatchers) {
    await sendDeliveryMessage({
      senderId: driver?.id,
      senderName: driverName,
      receiverId: dispatcher.user_id,
      receiverName: dispatcher.user_name,
      content
    });
  }
}