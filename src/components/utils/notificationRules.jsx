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
    buildMessage: ({ driverName, patientName }) => 
      `${driverName} is En Route to return delivery for ${patientName || 'Unknown Patient'}.`
  }
};

/**
 * Check if a notification should be sent for an event
 */
export function shouldNotify(event, channel = 'inApp') {
  const rule = notificationRules[event];
  if (!rule || !rule.enabled) return false;
  return rule.inApp;
}

/**
 * Get the message for an event
 */
export function getNotificationMessage(event, data) {
  const rule = notificationRules[event];
  if (!rule || !rule.buildMessage) return null;
  return rule.buildMessage(data);
}

/**
 * Get recipients type for an event
 */
export function getRecipients(event) {
  const rule = notificationRules[event];
  return rule?.recipients || null;
}