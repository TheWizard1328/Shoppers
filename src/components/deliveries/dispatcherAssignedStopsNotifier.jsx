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
 *
 * The rule engine context is enriched with BATCH-AGGREGATED delivery-level
 * fields (signature_needed, fridge_item, oversized, first_delivery, no_charge,
 * cod_total_amount_required, store_id list, delivery_status list) so that NEW
 * rules authored in MessageRuleBuilder with conditions on those fields evaluate
 * correctly. Without this aggregation, only the first delivery's value is
 * visible and any rule with a delivery-level condition silently fails to match,
 * defaulting to the legacy system.
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

// ── Context aggregation helpers ─────────────────────────────────────────────

const BOOL_FIELDS = ['signature_needed', 'fridge_item', 'oversized', 'first_delivery', 'no_charge'];

function aggregateBool(deliveries, field) {
  return deliveries.some((d) => !!d?.[field]);
}

function aggregateNumericSum(deliveries, field) {
  return deliveries.reduce((sum, d) => sum + (Number(d?.[field]) || 0), 0);
}

function aggregateList(deliveries, field) {
  const seen = new Set();
  const out = [];
  for (const d of deliveries) {
    const v = d?.[field];
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

function buildBatchAwareContext({
  driver,
  driverId,
  driverName,
  store,
  storeName,
  deliveries,
  dispatcher,
  deliveryList,
}) {
  const storeIds = aggregateList(deliveries, 'store_id');
  // If a single store, keep its id directly on store_id (matches "equals"/"in_list")
  // so existing rules keep working. Provide store_ids list for multi-store batches.
  const primaryStoreId = store?.id || deliveries[0]?.store_id || '';

  // The list of statuses present in the batch (typically just 'pending');
  // delivery_status stays 'pending' for backward compat with existing rules.
  const statuses = aggregateList(deliveries, 'status');

  // Resolve the triggering actor's role. Default to 'dispatcher' since this
  // notifier only fires for non-driver actors, but read the actual role when
  // available so rules keyed to 'admin' (when an admin is performing the
  // assignment) also match.
  let userRole = 'dispatcher';
  let userRolesArray = ['dispatcher'];
  if (Array.isArray(dispatcher?.app_roles) && dispatcher.app_roles.length > 0) {
    userRolesArray = dispatcher.app_roles;
    if (dispatcher.app_roles.includes('dispatcher')) userRole = 'dispatcher';
    else if (dispatcher.app_roles.includes('admin')) userRole = 'admin';
  } else if (typeof dispatcher?.app_role === 'string') {
    userRole = dispatcher.app_role;
    userRolesArray = [dispatcher.app_role];
  }
  // Also include 'driver' in the roles array if the assigning user happens to be
  // a driver self-assigning stops, so `Contains 'driver'` conditions match.
  if (dispatcher?.app_roles?.includes('driver')) {
    if (!userRolesArray.includes('driver')) userRolesArray = [...userRolesArray, 'driver'];
  }

  const context = {
    eventName: 'Dispatcher Assigned Stops',
    driverName,
    storeName,
    deliveryList,
    pendingCount: String(deliveries.length),
    deliveryCount: String(deliveries.length),
    status: 'pending',
    // Aggregate / list fields for batch-aware condition evaluation
    store_id: primaryStoreId,
    store_ids: storeIds,
    driver_id: driverId,
    delivery_status: 'pending',
    delivery_status_list: statuses,
    user_role: userRole,
    user_roles: userRolesArray,
    sender_id: dispatcher?.id || dispatcher?.user_id || '',
    timestamp: new Date().toLocaleString(),
    // Aggregate delivery-level boolean + numeric fields
    patientName: deliveries[0]?.patient_name || '',
  };

  for (const f of BOOL_FIELDS) {
    context[f] = aggregateBool(deliveries, f);
  }
  context.cod_total_amount_required = aggregateNumericSum(deliveries, 'cod_total_amount_required');

  return context;
}

// ── Sender resolution for in-app messages ────────────────────────────────────
async function resolveInAppSender({ store, dispatcher }) {
  // 1. Try the store pseudo-user (preserves legacy behaviour)
  const storeUser = await getStoreUser(store).catch(() => null);
  if (storeUser?.id && storeUser?.user_name) return storeUser;

  // 2. Fall back to the dispatcher themselves so the in-app message is STILL
  //    delivered even when no store pseudo-user exists. The legacy system would
  //    have bailed on a null storeUser entirely, leaving the driver with no
  //    in-app notification.
  const fallbackName = store?.name ? `${store.name} (Dispatcher)` : 'Dispatcher';
  const fallbackId = dispatcher?.id || dispatcher?.user_id || null;
  if (fallbackId) {
    return { id: fallbackId, user_name: dispatcher?.user_name || fallbackName };
  }

  // 3. Last resort — bail; push channel still goes out.
  return null;
}

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

  // Resolve sender lazily (needed for in-app messages)
  let senderPromise = null;
  const getSender = () => {
    if (!senderPromise) senderPromise = resolveInAppSender({ store, dispatcher });
    return senderPromise;
  };

  const sendInApp = async (userId, message, eventName, rule) => {
    const sender = await getSender();
    if (!sender) return; // No usable sender — skip in-app, push still goes out
    const label = rule?.rule_label || getNotificationLabel(eventName);
    const content = label ? `[${label}]\n${message}` : message;
    await sendDeliveryMessage({
      senderId: sender.id,
      senderName: sender.user_name,
      receiverId: userId,
      receiverName: userId === driverId ? driverName : 'User',
      content,
    });
  };

  const sendPush = async (userId, message, eventName, rule) => {
    await sendPushForNotification({
      receiverId: userId,
      senderName: storeName,
      content: message,
      event: eventName,
      titleOverride: rule?.rule_label,
    });
  };

  const context = buildBatchAwareContext({
    driver, driverId, driverName, store, storeName, deliveries, dispatcher, deliveryList,
  });
  console.warn('[DispatcherAssignedStops] context built — driver_id:', context.driver_id, '— driver object:', { user_id: driver?.user_id, id: driver?.id }, '— user_role:', context.user_role, '— store_id:', context.store_id);

  // Force a fresh rule load so newly-created / edited rules are picked up immediately
  clearRuleCache();

  let handled = false;
  let ruleEngineError = null;
  try {
    const result = await dispatchMessageRules(
      'dispatcher_assigned_all',
      context,
      sendInApp,
      sendPush,
    );
    handled = !!result?.handled;
    console.warn('[DispatcherAssignedStops] rule engine result — handled:', handled, '— matchedRules:', result?.matchedRules?.length, '— results:', JSON.stringify(result?.results));
    if (!handled) {
      console.warn('[DispatcherAssignedStops] rule engine returned handled=false — falling back to legacy. context keys:', Object.keys(context), 'result:', result);
    }
  } catch (e) {
    ruleEngineError = e;
    console.warn('[DispatcherAssignedStops] rule engine failed:', e?.message || e);
  }
  if (handled) return;

  // Fall back to the legacy system (NotificationTemplate entity aware)
  try {
    await notifyDispatcherAssignedAll({ dispatcher, driver, store, deliveries, patients });
  } catch (e) {
    console.warn('[DispatcherAssignedStops] legacy fallback failed:', e?.message || e, 'ruleEngineError:', ruleEngineError?.message);
  }
}