/**
 * trackingNotification.js — Persistent notification for driver tracking status
 *
 * Shows a persistent notification when the driver goes on_duty to help keep the
 * PWA alive in the background on Android. The notification:
 *   - Uses requireInteraction: true (won't auto-dismiss)
 *   - Is silent (no sound — it's a status indicator, not an alert)
 *   - Shows remaining stops + next stop name when available
 *   - Has a "Go Off Duty" action button
 *   - Is removed when the driver goes off_duty
 *
 * This is NOT a push notification — it's a local notification shown via the
 * service worker's showNotification API, triggered by postMessage from the client.
 */

/**
 * Check if persistent notifications are supported.
 * Requires: service worker + Notification API + granted permission.
 * On iOS, service worker notifications are not supported.
 */
export function isTrackingNotificationSupported() {
  return typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'Notification' in window &&
    Notification.permission === 'granted';
}

/**
 * Get the active service worker registration (map-tile-sw.js).
 */
async function getSWRegistration() {
  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    const tileReg = registrations.find(r => r.active?.scriptURL?.includes('map-tile-sw.js'));
    if (tileReg) return tileReg;
    return await navigator.serviceWorker.ready;
  } catch (_) {
    return null;
  }
}

/**
 * Show or update the persistent tracking notification.
 * @param {Object} data
 * @param {string} data.status - 'on_duty' or 'on_break'
 * @param {string} [data.driverName] - Driver's display name
 * @param {number} [data.stopCount] - Remaining stops
 * @param {string} [data.nextStop] - Next stop name/address
 * @param {boolean} [data.canStopTracking] - Whether to show "Go Off Duty" button
 */
export async function showTrackingNotification(data = {}) {
  if (!isTrackingNotificationSupported()) {
    console.warn('[trackingNotification] Not supported or permission not granted');
    return;
  }

  const reg = await getSWRegistration();
  if (!reg) {
    console.warn('[trackingNotification] No SW registration found');
    return;
  }

  try {
    reg.active?.postMessage({
      type: 'SHOW_TRACKING_NOTIFICATION',
      ...data,
    });
  } catch (err) {
    console.warn('[trackingNotification] Failed to show:', err?.message);
  }
}

/**
 * Update the tracking notification with new stop count / next stop.
 */
export async function updateTrackingNotification(data = {}) {
  if (!isTrackingNotificationSupported()) return;
  const reg = await getSWRegistration();
  if (!reg) return;

  try {
    reg.active?.postMessage({
      type: 'UPDATE_TRACKING_NOTIFICATION',
      ...data,
    });
  } catch (err) {
    console.warn('[trackingNotification] Failed to update:', err?.message);
  }
}

/**
 * Hide/remove the persistent tracking notification.
 */
export async function hideTrackingNotification() {
  if (!isTrackingNotificationSupported()) return;
  const reg = await getSWRegistration();
  if (!reg) return;

  try {
    reg.active?.postMessage({
      type: 'HIDE_TRACKING_NOTIFICATION',
    });
  } catch (err) {
    console.warn('[trackingNotification] Failed to hide:', err?.message);
  }
}

/**
 * Listen for the "stop_tracking_from_notification" action from the service worker.
 * This fires when the user taps "Go Off Duty" on the persistent notification.
 * @param {Function} callback - Called when the user taps "Go Off Duty"
 * @returns {Function} cleanup function to remove the listener
 */
export function onStopTrackingFromNotification(callback) {
  if (!('serviceWorker' in navigator)) return () => {};

  const handler = (event) => {
    if (event.data?.type === 'stop_tracking_from_notification') {
      callback();
    }
  };

  navigator.serviceWorker.addEventListener('message', handler);
  return () => navigator.serviceWorker.removeEventListener('message', handler);
}
