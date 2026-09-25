/**
 * Driver Accepted Stops notifier.
 *
 * Fires when a driver clicks "Accept All" (or accepts a single stop) — event
 * `driver_accepted`.
 *
 * Resolution order (mirrors dispatcherAssignedStopsNotifier):
 *   1. New Rule Engine (MessageRule entity) — fires if at least one enabled
 *      rule matches. This is the path the "+Stops Accepted+" rule belongs to;
 *      previously the rule existed but NOTHING invoked the engine for
 *      driver_accepted, so the rule silently never fired and only the legacy
 *      NotificationTemplate path ran.
 *   2. Legacy fallback (`notifyDriverAccepted`) which honours the
 *      NotificationTemplate entity config and the hardcoded buildMessage.
 *
 * Only ONE path delivers messages — if the rule engine handled the event,
 * the legacy fallback is skipped.
 *
 * Context notes:
 *   - user_role / user_roles describe the ACTING user (whoever clicked
 *     Accept), so rules with "user_role equals driver" match when the driver
 *     performs the action. When an admin accepts on behalf of a driver, the
 *     actor's role is admin — the credited driver name in the message is
 *     still the ASSIGNED driver.
 *   - driver_id points at the ASSIGNED driver's user_id so
 *     "relation:driver" recipients resolve correctly for on-behalf accepts.
 */
import { base44 } from '@/api/base44Client';
import { toast } from 'sonner';
import { dispatchMessageRules, clearRuleCache } from '@/components/utils/messageRuleEngine';
import { getNotificationLabel } from '@/components/utils/notificationRules';
import {
  notifyDriverAccepted,
  sendDeliveryMessage,
  sendPushForNotification,
  buildSpecialBadges,
} from '../utils/deliveryMessaging';

function buildDeliveryList(deliveries, patientNameMap) {
  let list = '';
  for (const delivery of deliveries || []) {
    const patientName = patientNameMap?.get(delivery?.patient_id) || delivery?.patient_name || 'Unknown';
    // Icons only — the icon and the word duplicate the same information
    // (matches the dispatcher-assigned notification format).
    const badges = buildSpecialBadges(delivery, null, { iconsOnly: true });
    list += `\n• ${patientName}${badges}`;
  }
  return list;
}

function buildContext({ actor, driver, driverId, store, deliveries, pendingCount, patientName, patientNotesJoined = '', patientNameMap = null }) {
  const roles = Array.isArray(actor?.app_roles) ? actor.app_roles
    : (typeof actor?.app_role === 'string' ? [actor.app_role] : []);
  const actingUserId = actor?.user_id || actor?.id || '';
  const resolvedDriverId = driverId || driver?.user_id || '';
  // Accepting one's OWN assigned deliveries is always a driver action, even
  // when that user also holds admin. Admin remains the actor role only when
  // accepting on behalf of a different driver.
  const isOwnDriverAccept = !!(actingUserId && resolvedDriverId && actingUserId === resolvedDriverId && roles.includes('driver'));
  const userRole = isOwnDriverAccept ? 'driver' : (actor?.app_role || (roles.length > 0 ? roles[0] : ''));

  const storeIds = [...new Set((deliveries || []).map((d) => d?.store_id).filter(Boolean))];

  // The real name of whoever clicked Accept (admin, dispatcher, or the driver
  // themselves), exposed to templates as {{adminName}} — same idea as
  // dispatcherAssignedStopsNotifier's adminName. When an admin accepts on
  // behalf of a driver, this is the admin's own AppUser name, not the
  // credited driver's name (that's driverName).
  const adminName = actor?.user_name || actor?.full_name || 'Administrator';
  // actingUserId and resolvedDriverId are used only for self-action
  // suppression and recipient resolution, never for display.

  return {
    eventName: 'Driver Accepted',
    driverName: driver?.user_name || driver?.full_name || 'Driver',
    adminName,
    pendingCount: String(pendingCount != null ? pendingCount : (deliveries || []).length),
    deliveryList: buildDeliveryList(deliveries, patientNameMap),
    patientName: patientName || (patientNameMap?.get(deliveries?.[0]?.patient_id) || deliveries?.[0]?.patient_name || ''),
    // Text-search fields for Rule Builder "Patient Name" / "Patient Notes" /
    // "Driver Notes" conditions — joined across the WHOLE batch so "Contains"
    // matches if ANY delivery/patient in the batch qualifies. Deliveries only
    // carry patient_id — resolve through the fetched Patient records (the
    // old code read a non-existent delivery.patient_name, always empty,
    // which is why notifications rendered "Unknown").
    patient_name: [...new Set((deliveries || []).map((d) =>
      patientNameMap?.get(d?.patient_id) || d?.patient_name).filter(Boolean))].join(' | '),
    patient_notes: patientNotesJoined,
    delivery_notes: [...new Set((deliveries || []).map((d) => d?.delivery_notes).filter(Boolean))].join(' | '),
    store_id: storeIds[0] || store?.id || '',
    store_ids: storeIds,
    driver_id: resolvedDriverId,
    actingUserId,
    suppressSelfNotifications: true,
    delivery_status: 'in_transit',
    user_role: userRole,
    user_roles: roles,
    sender_id: driver?.user_id || driver?.id || '',
    timestamp: new Date().toLocaleString(),
  };
}

/**
 * Notify that a driver accepted stop(s).
 *
 * @param {object} params
 *   actor          – AppUser of whoever clicked the button (role conditions key off this)
 *   driver         – AppUser credited as accepting (the assigned driver)
 *   store          – the pickup store object (or null)
 *   appUsers       – full AppUser list (legacy fallback recipient resolution)
 *   deliveries     – the accepted delivery records (for deliveryList + delivery_ids)
 *   pendingCount   – count override (defaults to deliveries.length)
 *   patientName    – single-accept patient name (legacy fallback)
 */
export async function notifyDriverAcceptedStops({
  actor,
  driver,
  store,
  appUsers,
  deliveries = [],
  pendingCount = null,
  patientName = null,
}) {
  const count = pendingCount != null ? pendingCount : (deliveries || []).length;
  if (!count || count <= 0) return;

  const driverId = driver?.user_id || driver?.id || '';
  const driverName = driver?.user_name || driver?.full_name || 'Driver';
  const deliveryIds = (deliveries || []).map((d) => d?.id).filter(Boolean);

  // Resolve the receiving AppUser's display name (a store dispatcher account
  // like "Hamptons", the App Owner, or the driver themselves) — the old
  // hardcoded 'User' literal is what showed instead of the store name.
  const receiverNameCache = new Map();
  const resolveReceiverName = async (userId) => {
    if (receiverNameCache.has(userId)) return receiverNameCache.get(userId);
    let name = (appUsers || []).find((u) => (u?.user_id || u?.id) === userId)?.user_name;
    if (!name) {
      try {
        const matches = await base44.entities.AppUser.filter({ user_id: userId });
        name = matches?.[0]?.user_name;
      } catch (e) {
        console.warn('[DriverAcceptedStops] receiver name lookup failed:', e?.message || e);
      }
    }
    name = name || 'User';
    receiverNameCache.set(userId, name);
    return name;
  };

  const sendInApp = async (userId, message, eventName, rule) => {
    const label = rule?.rule_label || getNotificationLabel(eventName);
    const content = label ? `[${label}]\n${message}` : message;
    await sendDeliveryMessage({
      senderId: driverId,
      senderName: driverName,
      receiverId: userId,
      receiverName: await resolveReceiverName(userId),
      content,
    });
  };

  const sendPush = async (userId, message, eventName, rule) => {
    const ruleActions = (rule?.actions && rule.actions.length > 0) ? rule.actions :
      (deliveryIds.length > 0 ? [{ action: 'acknowledge', title: 'Acknowledge' }] : undefined);
    await sendPushForNotification({
      receiverId: userId,
      senderName: driverName,
      content: message,
      event: eventName,
      titleOverride: rule?.rule_label,
      actions: ruleActions,
      delivery_ids: deliveryIds.length > 0 ? deliveryIds : undefined,
      requireInteraction: true,
    });
  };

  // Self-contained Patient lookup: unlike dispatcherAssignedStopsNotifier
  // (which receives `patients` from the caller's already-loaded state),
  // neither Accept All nor Accept Single thread patient records through to
  // this notifier — fetch just the notes for the patients in THIS batch.
  const patientIds = [...new Set((deliveries || []).map((d) => d?.patient_id).filter(Boolean))];
  let patientNotesJoined = '';
  const patientNameMap = new Map();
  if (patientIds.length > 0) {
    try {
      const patientRecords = await base44.entities.Patient.filter({ id: { $in: patientIds } });
      patientNotesJoined = (patientRecords || []).map((p) => p?.notes).filter(Boolean).join(' | ');
      (patientRecords || []).forEach((p) => {
        if (p?.id && p?.full_name) patientNameMap.set(p.id, p.full_name);
      });
    } catch (e) {
      console.warn('[DriverAcceptedStops] patient notes/name lookup failed:', e?.message || e);
    }
  }

  const context = buildContext({ actor, driver, driverId, store, deliveries, pendingCount: count, patientName, patientNotesJoined, patientNameMap });
  console.warn('[DriverAcceptedStops] context — user_role:', context.user_role, '— driver_id:', context.driver_id, '— store_id:', context.store_id, '— pendingCount:', context.pendingCount);

  // Force a fresh rule load so newly-created / edited rules are picked up immediately
  clearRuleCache();

  let handled = false;
  let ruleEngineError = null;
  try {
    const result = await dispatchMessageRules(
      'driver_accepted',
      context,
      sendInApp,
      sendPush,
      appUsers,
    );
    handled = !!result?.handled;
    console.warn('[DriverAcceptedStops] rule engine result — handled:', handled, '— matchedRules:', result?.matchedRules?.length, '— results:', JSON.stringify(result?.results));

    // TEMPORARY DIAGNOSTIC — Sep 23 2026 "Store Dispatchers not notified on
    // Accept All" investigation. Surfaces the exact inputs/outputs of the
    // driver_accepted dispatch as an on-screen toast (visible without
    // devtools). REMOVE once the root cause is confirmed fixed.
    try {
      const ruleSummary = (result?.matchedRules || []).map((r) => {
        const recips = (result?.results || []).filter((x) => x.ruleId === r.id);
        const sent = recips.filter((x) => !x.skipped).map((x) => x.userId);
        const skipped = recips.filter((x) => x.skipped).map((x) => `${x.userId}(${x.skipped})`);
        return `${r.rule_label}→recipients:[${(r.recipients || []).join(',')}] sent:[${sent.join(',') || 'none'}] skipped:[${skipped.join(',') || 'none'}]`;
      }).join('\n');
      toast.info(
        `[DEBUG driver_accepted] store_id=${context.store_id || '(empty)'}\nuser_role=${context.user_role}\nuser_roles=${(context.user_roles || []).join(',')}\nhandled=${handled}\n${ruleSummary || '(no matched rules)'}`,
        { duration: 20000 }
      );
    } catch { /* toast not mounted — ignore */ }
  } catch (e) {
    ruleEngineError = e;
    console.warn('[DriverAcceptedStops] rule engine failed:', e?.message || e);
  }
  if (handled) return;

  // Fall back to the legacy system (NotificationTemplate entity aware)
  try {
    await notifyDriverAccepted({ driver, store, appUsers, pendingCount: count, patientName });
  } catch (e) {
    console.warn('[DriverAcceptedStops] legacy fallback failed:', e?.message || e, 'ruleEngineError:', ruleEngineError?.message);
  }
}
