import { isCapacitorNativeApp, getCapacitorPlatform } from './locationProviders/capacitorRuntime';
import { base44 } from '@/api/base44Client';

/**
 * Native FCM Push Notifications (Capacitor Android)
 *
 * The standard Web Push API (Notification / PushManager / ServiceWorker) does
 * NOT work inside Android's native WebView. On the APK, we use Capacitor's
 * PushNotifications plugin instead, which gets a real FCM (Firebase Cloud
 * Messaging) token from the OS and receives pushes as native system
 * notifications — visible even when the app is killed.
 *
 * The FCM token is stored in the same PushSubscription entity as web push
 * subscriptions, but with:
 *   - endpoint = "fcm://{token}"  (so the backend can distinguish FCM vs Web Push)
 *   - p256dh_key / auth_key = null (not used for FCM)
 *
 * The backend sendPushNotification function checks the endpoint prefix to
 * route to either web-push (VAPID) or FCM (Firebase Admin SDK).
 */

let _nativePushInitialized = false;
let _registrationListenerAdded = false;

/**
 * Check if native FCM push is available (Capacitor native + Android).
 */
export function isNativePushAvailable() {
  return isCapacitorNativeApp() && getCapacitorPlatform() === 'android';
}

/**
 * Initialize native push notifications.
 * Must be called after user login — the FCM token is registered with the
 * user's ID so the backend can route messages to them.
 *
 * Returns { ok, token } or { ok: false, reason }.
 */
export async function initNativePushNotifications(userId) {
  if (!userId) return { ok: false, reason: 'no_user_id' };
  if (!isNativePushAvailable()) return { ok: false, reason: 'not_native' };
  if (_nativePushInitialized) return { ok: true, reason: 'already_initialized' };

  try {
    const { PushNotifications } = await import('@capacitor/push-notifications');

    // Add registration listener ONCE (survives across permission requests)
    if (!_registrationListenerAdded) {
      _registrationListenerAdded = true;

      PushNotifications.addListener('registration', async (token) => {
        console.log('🔔 [NativePush] FCM token received:', token.value?.substring(0, 20) + '…');
        try {
          await persistNativeSubscription(userId, token.value);
        } catch (err) {
          console.error('[NativePush] Failed to persist FCM subscription:', err?.message);
        }
      });

      PushNotifications.addListener('registrationError', (err) => {
        console.error('[NativePush] FCM registration failed:', err);
      });

      // Handle notification tap when app is in foreground or background
      PushNotifications.addListener('pushNotificationReceived', (notification) => {
        console.log('[NativePush] Notification received in foreground:', notification.title);
      });

      // Handle notification tap (app opened from notification)
      PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
        console.log('[NativePush] Notification tapped:', action.notification?.data);
        const data = action.notification?.data;
        if (data?.url) {
          // Navigate within the SPA
          window.location.hash = data.url;
        }
      });
    }

    // Request permission
    let permStatus = await PushNotifications.checkPermissions();
    if (permStatus.receive === 'prompt') {
      permStatus = await PushNotifications.requestPermissions();
    }

    if (permStatus.receive !== 'granted') {
      console.warn('[NativePush] Permission not granted');
      return { ok: false, reason: 'permission_denied' };
    }

    // Register with FCM — this triggers the 'registration' listener
    await PushNotifications.register();
    _nativePushInitialized = true;

    console.log('[NativePush] Registration requested — waiting for FCM token…');
    return { ok: true, reason: 'registered' };
  } catch (err) {
    console.error('[NativePush] Init failed:', err?.message || err);
    return { ok: false, reason: 'init_error', error: err?.message };
  }
}

/**
 * Persist the FCM token to the PushSubscription entity.
 * Uses endpoint format "fcm://{token}" so the backend can distinguish from web push.
 */
async function persistNativeSubscription(userId, fcmToken) {
  if (!userId || !fcmToken) return null;

  const endpoint = `fcm://${fcmToken}`;
  const deviceIdentifier = localStorage.getItem('rxdeliver_device_identifier') || null;

  // Get user_name for the PushSubscription record
  let userName = null;
  try {
    const appUsers = await base44.entities.AppUser.filter({ user_id: userId });
    userName = appUsers?.[0]?.user_name || null;
  } catch (_) { /* non-critical */ }

  try {
    // Check if this FCM token already exists
    const existing = await base44.entities.PushSubscription.filter({ user_id: userId, endpoint });
    if (existing && existing.length > 0) {
      // Update last_used_at and backfill fields
      const patch = { last_used_at: new Date().toISOString() };
      if (deviceIdentifier && !existing[0].device_identifier) patch.device_identifier = deviceIdentifier;
      if (userName && !existing[0].user_name) patch.user_name = userName;
      await base44.entities.PushSubscription.update(existing[0].id, patch).catch(() => {});
      console.log('[NativePush] Updated existing FCM subscription');
      return existing[0];
    }

    // Create new subscription
    const created = await base44.entities.PushSubscription.create({
      user_id: userId,
      endpoint,
      p256dh_key: null,  // Not used for FCM
      auth_key: null,    // Not used for FCM
      user_name: userName,
      user_agent: navigator.userAgent,
      device_identifier: deviceIdentifier,
      last_used_at: new Date().toISOString(),
    });
    console.log('[NativePush] Created new FCM subscription');
    return created;
  } catch (err) {
    console.error('[NativePush] Persist failed:', err?.message || err);
    return null;
  }
}

/**
 * Remove native push registration (used on logout).
 */
export async function removeNativePushNotifications() {
  if (!isNativePushAvailable()) return;
  try {
    const { PushNotifications } = await import('@capacitor/push-notifications');
    await PushNotifications.removeAllDeliveredNotifications();
    _nativePushInitialized = false;
    console.log('[NativePush] Unregistered');
  } catch (_) { /* non-critical */ }
}

/**
 * Check native push permission status.
 */
export async function checkNativePushPermission() {
  if (!isNativePushAvailable()) return 'unsupported';
  try {
    const { PushNotifications } = await import('@capacitor/push-notifications');
    const status = await PushNotifications.checkPermissions();
    return status.receive; // 'granted', 'denied', 'prompt'
  } catch (_) {
    return 'unsupported';
  }
}
