/**
 * Centralized notification rules for in-app messaging
 * 
 * Each rule defines:
 * - event: The trigger event name
 * - enabled: Whether this notification is active
 * - inApp: Whether to send in-app message
 * - recipients: Who receives the notification ('dispatchers', 'driver', 'both')
 * - messageBuilder: Function to build the message content
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

  // Grab the first line after "For:"
  const firstNames = forMatch[1].split('\n')[0];

  // Gather any "and:" lines
  const andMatches = [...notes.matchAll(/^and:\s*(.+)/gim)].map(m => m[1]);

  const all = [firstNames, ...andMatches]
    .join(',')
    .split(',')
    .map(n => n.trim())
    .filter(n => n.length > 0);

  return all.length > 0 ? all.join(', ') : null;
}

export const NOTIFICATION_EVENTS = {
  DRIVER_ACCEPTED_ALL: 'driver_accepted_all',
  DRIVER_ACCEPTED_ONE: 'driver_accepted_one',
  DISPATCHER_ASSIGNED_ALL: 'dispatcher_assigned_all',
  DRIVER_STARTED: 'driver_started',
  DRIVER_COMPLETED: 'driver_completed',
  DRIVER_FAILED: 'driver_failed',
  DRIVER_RETRY: 'driver_retry',
  DRIVER_RETURN: 'driver_return'
};

/**
 * Notification rules configuration
 * Edit this object to enable/disable notifications for specific events
 */
export const notificationRules = {
  [NOTIFICATION_EVENTS.DRIVER_ACCEPTED_ALL]: {
    enabled: true,
    inApp: true,
    recipients: ['dispatchers', 'appowner'],
    buildMessage: ({ driverName }) => 
      `${driverName} has accepted all pending deliveries.`
  },

  [NOTIFICATION_EVENTS.DRIVER_ACCEPTED_ONE]: {
    enabled: true,
    inApp: true,
    recipients: ['dispatchers', 'appowner'],
    buildMessage: ({ driverName, patientName }) => 
      `${driverName} has accepted delivery for ${patientName || 'Unknown Patient'}.`
  },

  [NOTIFICATION_EVENTS.DISPATCHER_ASSIGNED_ALL]: {
    enabled: true,
    inApp: true,
    recipients: ['driver', 'appowner'],
    buildMessage: ({ storeName, deliveryList }) => 
      `${storeName} has assigned you the following deliveries:${deliveryList}`
  },

  [NOTIFICATION_EVENTS.DRIVER_STARTED]: {
    enabled: true,
    inApp: true,
    recipients: ['dispatchers', 'appowner'],
    buildMessage: ({ driverName, patientName }) => 
      `${driverName} has moved ${patientName || 'Unknown Patient'} to next delivery.`
  },

  [NOTIFICATION_EVENTS.DRIVER_COMPLETED]: {
    enabled: true,
    inApp: true,
    recipients: ['dispatchers', 'appowner'],
    buildMessage: ({ driverName, patientName }) => 
      `${driverName} has completed delivery for ${patientName || 'Unknown Patient'}.`
  },

  [NOTIFICATION_EVENTS.DRIVER_FAILED]: {
    enabled: true,
    inApp: true,
    recipients: ['dispatchers', 'appowner'],
    buildMessage: ({ driverName, patientName }) => 
      `${driverName} failed to complete delivery for ${patientName || 'Unknown Patient'}.`
  },

  [NOTIFICATION_EVENTS.DRIVER_RETRY]: {
    enabled: true,
    inApp: true,
    recipients: ['dispatchers', 'appowner'],
    buildMessage: ({ driverName, patientName }) => 
      `${driverName} is now retrying delivery for ${patientName || 'Unknown Patient'}.`
  },

  [NOTIFICATION_EVENTS.DRIVER_RETURN]: {
    enabled: true,
    inApp: true,
    recipients: ['dispatchers', 'appowner'],
    buildMessage: ({ driverName, patientName, deliveryNotes }) => {
      const parsedNames = extractPatientNamesFromReturnNotes(deliveryNotes);
      const effectiveName = parsedNames || patientName || 'Unknown Patient';
      return `${driverName} is En Route to return delivery for ${effectiveName}.`;
    }
  }
};

// ── Runtime overrides loaded from AppSettings (push_notification_rules) ──────
let _overrides = {};

export function loadNotificationOverrides(overridesMap) {
  _overrides = overridesMap || {};
}

function getEffective(event) {
  const base = notificationRules[event] || {};
  const override = _overrides[event] || {};
  return { ...base, ...override };
}

/**
 * Check if a notification should be sent for an event and channel ('inApp' | 'push')
 */
export function shouldNotify(event, channel = 'inApp') {
  const rule = getEffective(event);
  if (!rule.enabled) return false;
  if (channel === 'push') return rule.push === true;
  return rule.inApp !== false;
}

/**
 * Get the message for an event and channel ('inApp' | 'push').
 * Uses the admin-configured per-channel template when present, falls back to hardcoded buildMessage.
 */
export function getNotificationMessage(event, data, channel = 'inApp') {
  const override = _overrides[event];
  // Pick the channel-specific template, then fall back to the shared legacy messageTemplate
  const template = channel === 'push'
    ? (override?.pushTemplate || override?.messageTemplate)
    : (override?.inAppTemplate || override?.messageTemplate);

  if (template) {
    return template
      .replace(/\{\{driverName\}\}/g, data.driverName || '')
      .replace(/\{\{patientName\}\}/g, data.patientName || '')
      .replace(/\{\{storeName\}\}/g, data.storeName || '')
      .replace(/\{\{deliveryList\}\}/g, data.deliveryList || '');
  }
  const rule = notificationRules[event];
  if (!rule?.buildMessage) return null;
  return rule.buildMessage(data);
}

/**
 * Get recipients type for an event
 */
export function getRecipients(event) {
  const rule = getEffective(event);
  return rule?.recipients || null;
}