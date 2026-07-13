/**
 * Centralized notification rules for in-app messaging
 *
 * The hardcoded rules below are FALLBACKS only.
 * Live configuration is stored in the NotificationTemplate entity
 * and loaded at runtime via loadNotificationTemplates().
 */

/**
 * Parse patient names from return delivery notes.
 * Supports:
 *   "For: Name1, Name2"
 *   "For: Name1\nand: Name2\nand: Name3"
 */
function extractPatientNamesFromReturnNotes(notes) {
  if (!notes) return null;
  const forMatch = notes.match(/For:\s*(.+)/i);
  if (!forMatch) return null;

  const firstNames = forMatch[1].split('\n')[0];
  const andMatches = [...notes.matchAll(/^and:\s*(.+)/gim)].map(m => m[1]);

  const all = [firstNames, ...andMatches]
    .join(',')
    .split(',')
    .map(n => n.trim())
    .filter(n => n.length > 0);

  return all.length > 0 ? all.join(', ') : null;
}

export const NOTIFICATION_EVENTS = {
  DRIVER_ACCEPTED_ALL:    'driver_accepted_all',
  DRIVER_ACCEPTED_ONE:    'driver_accepted_one',
  DISPATCHER_ASSIGNED_ALL:'dispatcher_assigned_all',
  DRIVER_STARTED:         'driver_started',
  DRIVER_COMPLETED:       'driver_completed',
  DRIVER_FAILED:          'driver_failed',
  DRIVER_RETRY:           'driver_retry',
  DRIVER_RETURN:          'driver_return',
  ADMIN_BROADCAST:        'admin_broadcast'
};

/** Hardcoded fallbacks — used only if the entity record is missing */
export const notificationRules = {
  [NOTIFICATION_EVENTS.DRIVER_ACCEPTED_ALL]: {
    enabled: true, inApp: true,
    recipients: ['dispatchers', 'appowner'],
    buildMessage: ({ driverName }) =>
      `${driverName} has accepted all pending deliveries.`
  },
  [NOTIFICATION_EVENTS.DRIVER_ACCEPTED_ONE]: {
    enabled: true, inApp: true,
    recipients: ['dispatchers', 'appowner'],
    buildMessage: ({ driverName, patientName }) =>
      `${driverName} has accepted delivery for ${patientName || 'Unknown Patient'}.`
  },
  [NOTIFICATION_EVENTS.DISPATCHER_ASSIGNED_ALL]: {
    enabled: true, inApp: true,
    recipients: ['driver', 'appowner'],
    buildMessage: ({ storeName, deliveryList }) =>
      `${storeName} has assigned you the following deliveries:${deliveryList}`
  },
  [NOTIFICATION_EVENTS.DRIVER_STARTED]: {
    enabled: true, inApp: true,
    recipients: ['dispatchers', 'appowner'],
    buildMessage: ({ driverName, patientName }) =>
      `${driverName} has moved ${patientName || 'Unknown Patient'} to next delivery.`
  },
  [NOTIFICATION_EVENTS.DRIVER_COMPLETED]: {
    enabled: true, inApp: true,
    recipients: ['dispatchers', 'appowner'],
    buildMessage: ({ driverName, patientName }) =>
      `${driverName} has completed delivery for ${patientName || 'Unknown Patient'}.`
  },
  [NOTIFICATION_EVENTS.DRIVER_FAILED]: {
    enabled: true, inApp: true,
    recipients: ['dispatchers', 'appowner'],
    buildMessage: ({ driverName, patientName }) =>
      `${driverName} failed to complete delivery for ${patientName || 'Unknown Patient'}.`
  },
  [NOTIFICATION_EVENTS.DRIVER_RETRY]: {
    enabled: true, inApp: true,
    recipients: ['dispatchers', 'appowner'],
    buildMessage: ({ driverName, patientName }) =>
      `${driverName} is now retrying delivery for ${patientName || 'Unknown Patient'}.`
  },
  [NOTIFICATION_EVENTS.DRIVER_RETURN]: {
    enabled: true, inApp: true,
    recipients: ['dispatchers', 'appowner'],
    buildMessage: ({ driverName, patientName, deliveryNotes }) => {
      const parsedNames = extractPatientNamesFromReturnNotes(deliveryNotes);
      const effectiveName = parsedNames || patientName || 'Unknown Patient';
      return `${driverName} is En Route to return delivery for ${effectiveName}.`;
    }
  },
  [NOTIFICATION_EVENTS.ADMIN_BROADCAST]: {
    enabled: true, inApp: true,
    recipients: ['dispatchers', 'driver', 'admins'],
    buildMessage: () => `You have a new message from the administrator.`
  }
};

// ── Runtime state loaded from NotificationTemplate entity ─────────────────────
// Keyed by event_name. Each entry mirrors the entity fields.
let _liveTemplates = {};  // { [event_name]: NotificationTemplate record }
let _activeSubscription = null; // held here so it's never GC'd

/**
 * Load all NotificationTemplate records from the entity and cache them.
 * Call this once at app startup (e.g. in useLayoutInit).
 */
export async function loadNotificationTemplates(base44Client) {
  try {
    const records = await base44Client.entities.NotificationTemplate.list();
    _liveTemplates = {};
    (records || []).forEach(r => {
      if (r?.event_name) _liveTemplates[r.event_name] = r;
    });
  } catch (e) {
    console.warn('[NotificationRules] Failed to load templates from entity, using fallbacks:', e?.message);
  }
}

/**
 * Re-apply a single updated record (call after saving in MessageRulesManager).
 */
export function applyTemplateUpdate(record) {
  if (record?.event_name) {
    _liveTemplates[record.event_name] = record;
  }
}

/**
 * Subscribe to real-time NotificationTemplate entity changes via WebSocket.
 * Holds the subscription in module scope so it's never garbage-collected.
 * Safe to call multiple times — tears down the previous subscription first.
 */
export function subscribeToTemplateUpdates(base44Client) {
  // Tear down any existing subscription before creating a new one
  if (_activeSubscription) {
    try { _activeSubscription(); } catch {}
    _activeSubscription = null;
  }
  try {
    _activeSubscription = base44Client.entities.NotificationTemplate.subscribe((event) => {
      if (!event?.data?.event_name) return;
      if (event.type === 'delete') {
        delete _liveTemplates[event.data.event_name];
      } else {
        _liveTemplates[event.data.event_name] = event.data;
      }
    });
  } catch (e) {
    console.warn('[NotificationRules] Real-time subscription failed:', e?.message);
  }
}

/** Returns the merged effective rule for an event */
function getEffective(event) {
  const base = notificationRules[event] || {};
  const live = _liveTemplates[event];
  if (!live) return base;
  return {
    ...base,
    enabled:    live.enabled        ?? base.enabled,
    inApp:      live.in_app_enabled ?? base.inApp,
    recipients: live.recipients     || base.recipients,
  };
}

/**
 * Check if a notification should be sent for an event (inApp channel only now — push is device-controlled)
 */
export function shouldNotify(event, channel = 'inApp') {
  const rule = getEffective(event);
  if (!rule.enabled) return false;
  return rule.inApp !== false;
}

/**
 * Get the message for an event.
 * Uses the entity's message_template when present, falls back to hardcoded buildMessage.
 */
export function getNotificationMessage(event, data) {
  const live = _liveTemplates[event];
  const template = live?.message_template;

  if (template) {
    return template
      .replace(/\{\{driverName\}\}/g,   data.driverName   || '')
      .replace(/\{\{patientName\}\}/g,  data.patientName  || '')
      .replace(/\{\{storeName\}\}/g,    data.storeName    || '')
      .replace(/\{\{deliveryList\}\}/g, data.deliveryList || '')
      .replace(/\{\{pendingCount\}\}/g, data.pendingCount != null ? String(data.pendingCount) : '');
  }

  const rule = notificationRules[event];
  if (!rule?.buildMessage) return null;
  return rule.buildMessage(data);
}

/**
 * Get recipients type for an event
 */
export function getRecipients(event) {
  return getEffective(event)?.recipients || null;
}

/**
 * Get the display label for an event (live entity label, falls back to formatted event key).
 */
export function getNotificationLabel(event) {
  if (_liveTemplates[event]?.label) return _liveTemplates[event].label;
  if (!event) return null;
  // Format e.g. "driver_completed" → "Driver Completed"
  return event.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// Legacy compat — kept so existing callers of loadNotificationOverrides don't crash
export function loadNotificationOverrides() {}