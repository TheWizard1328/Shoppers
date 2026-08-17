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
 *   - p256dh_key / auth_key sent as empty strings for FCM (schema types them
 *     as required strings — null/undefined fails validation, empty string is
 *     accepted and ignored by the FCM send path)
 *
 * The backend sendPushNotification function checks the endpoint prefix to
 * route to either web-push (VAPID) or FCM (Firebase Admin SDK v1 API).
 */

let _nativePushInitialized = false;
let _registrationListenerAdded = false;
let _lastRegistrationResult = null;
let _registrationTimeout = null;

/**
 * Check if native FCM push is available (Capacitor native + Android).
 */
export function isNativePushAvailable() {
  return isCapacitorNativeApp() && getCapacitorPlatform() === 'android';
}

/**
 * Get the last registration result for diagnostics.
 */
export function getRegistrationDiagnostics() {
  return _lastRegistrationResult;
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
        console.log('[NativePush] FCM token received:', token.value?.substring(0, 20) + '...');
        _lastRegistrationResult = { ok: true, reason: 'token_received', token: token.value?.substring(0, 30), ts: Date.now() };

        if (_registrationTimeout) { clearTimeout(_registrationTimeout); _registrationTimeout = null; }

        try {
          const persisted = await persistNativeSubscription(userId, token.value);
          if (persisted) {
            console.log('[NativePush] FCM subscription persisted');
            _lastRegistrationResult = { ok: true, reason: 'persisted', token: token.value?.substring(0, 30), ts: Date.now() };
          } else {
            console.error('[NativePush] FCM token received but persistence returned null');
            _lastRegistrationResult = { ok: false, reason: 'persist_returned_null', token: token.value?.substring(0, 30), ts: Date.now() };
          }
        } catch (err) {
          console.error('[NativePush] Failed to persist FCM subscription:', err?.message);
          _lastRegistrationResult = { ok: false, reason: 'persist_failed', error: err?.message || String(err), ts: Date.now() };
        }
      });

      PushNotifications.addListener('registrationError', (err) => {
        console.error('[NativePush] FCM registration failed:', err);
        _lastRegistrationResult = { ok: false, reason: 'registration_error', error: JSON.stringify(err), ts: Date.now() };
        if (_registrationTimeout) { clearTimeout(_registrationTimeout); _registrationTimeout = null; }
      });

      PushNotifications.addListener('pushNotificationReceived', async (notification) => {
        console.log('[NativePush] Notification received in foreground:', JSON.stringify(notification).substring(0, 200));

        // When the app is in the foreground, Capacitor does NOT auto-display
        // FCM messages as system notifications (unlike background/killed state).
        // We must create a LocalNotification so the user actually sees it.
        // Try multiple property paths — Capacitor's plugin structure varies
        // between notification-only, data-only, and combined payloads.
        const notifTitle = notification.title || notification.data?.title || notification.data?.gcm?.notification?.title || 'RxDeliver';
        const notifBody = notification.body || notification.data?.body || notification.data?.gcm?.notification?.body || '';
        const extraData = notification.data || {};

        // Store for debugging — user can check window.__receivedPushNotifs
        if (!window.__receivedPushNotifs) window.__receivedPushNotifs = [];
        window.__receivedPushNotifs.push({ ts: Date.now(), title: notifTitle, body: notifBody, data: extraData });

        try {
          const { LocalNotifications } = await import('@capacitor/local-notifications');
          const notifId = Math.floor(Math.random() * 100000) + 1;
          await LocalNotifications.schedule({
            notifications: [{
              id: notifId,
              title: notifTitle,
              body: notifBody,
              extra: extraData,
            }],
          });
          console.log('[NativePush] Foreground local notification displayed:', notifId, notifTitle);
        } catch (err) {
          console.error('[NativePush] Failed to display foreground notification:', err?.message);
        }
      });

      PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
        console.log('[NativePush] Notification tapped:', action.notification?.data);
        const data = action.notification?.data;
        if (data?.url) {
          window.location.hash = data.url;
        }
      });

      // Handle taps on foreground-created local notifications
      try {
        const { LocalNotifications } = await import('@capacitor/local-notifications');
        LocalNotifications.addListener('localNotificationActionPerformed', (action) => {
          console.log('[NativePush] Local notif tapped:', action.notification?.extra);
          const extra = action.notification?.extra;
          if (extra?.url) {
            window.location.hash = extra.url;
          }
        });
      } catch (_) { /* non-critical */ }
    }

    let permStatus = await PushNotifications.checkPermissions();
    console.log('[NativePush] Permission status:', permStatus.receive);
    if (permStatus.receive === 'prompt') {
      permStatus = await PushNotifications.requestPermissions();
      console.log('[NativePush] After request:', permStatus.receive);
    }

    if (permStatus.receive !== 'granted') {
      console.warn('[NativePush] Permission not granted');
      _lastRegistrationResult = { ok: false, reason: 'permission_denied', ts: Date.now() };
      return { ok: false, reason: 'permission_denied' };
    }

    await PushNotifications.register();
    _nativePushInitialized = true;

    _lastRegistrationResult = { ok: null, reason: 'waiting_for_token', ts: Date.now() };
    if (_registrationTimeout) clearTimeout(_registrationTimeout);
    _registrationTimeout = setTimeout(() => {
      if (_lastRegistrationResult?.reason === 'waiting_for_token') {
        _lastRegistrationResult = { ok: false, reason: 'token_timeout', error: 'FCM did not return a token within 15 seconds', ts: Date.now() };
        console.error('[NativePush] FCM token timeout - registration did not complete within 15s');
      }
    }, 15000);

    console.log('[NativePush] Registration requested - waiting for FCM token...');
    return { ok: true, reason: 'registered' };
  } catch (err) {
    console.error('[NativePush] Init failed:', err?.message || err);
    _lastRegistrationResult = { ok: false, reason: 'init_error', error: err?.message, ts: Date.now() };
    return { ok: false, reason: 'init_error', error: err?.message };
  }
}

/**
 * Force re-register (bypasses the _nativePushInitialized flag).
 */
export async function forceReRegisterNativePush(userId) {
  _nativePushInitialized = false;
  return await initNativePushNotifications(userId);
}

/**
 * Run full push notification diagnostics.
 */
export async function runPushDiagnostics(userId) {
  const report = {
    timestamp: new Date().toISOString(),
    isNative: isNativePushAvailable(),
    platform: null,
    permission: null,
    pluginLoaded: false,
    hasRegisterMethod: false,
    hasCheckPermissionsMethod: false,
    registrationResult: _lastRegistrationResult,
    subscriptions: { total: 0, fcm: 0, web: 0 },
    errors: [],
  };

  try {
    report.platform = getCapacitorPlatform();
  } catch (e) {
    report.errors.push('Platform check: ' + e.message);
  }

  try {
    report.permission = await checkNativePushPermission();
  } catch (e) {
    report.permission = 'error';
    report.errors.push('Permission check: ' + e.message);
  }

  try {
    const { PushNotifications } = await import('@capacitor/push-notifications');
    report.pluginLoaded = !!PushNotifications;
    report.hasRegisterMethod = typeof PushNotifications.register === 'function';
    report.hasCheckPermissionsMethod = typeof PushNotifications.checkPermissions === 'function';
  } catch (e) {
    report.errors.push('Plugin load: ' + e.message);
  }

  try {
    const subs = await base44.entities.PushSubscription.filter({ user_id: userId });
    report.subscriptions.total = subs?.length || 0;
    report.subscriptions.fcm = subs?.filter(s => s.endpoint?.startsWith('fcm://')).length || 0;
    report.subscriptions.web = subs?.filter(s => !s.endpoint?.startsWith('fcm://')).length || 0;
  } catch (e) {
    report.errors.push('Subscription check: ' + e.message);
  }

  return report;
}

/**
 * Persist the FCM token to the PushSubscription entity.
 * Uses endpoint format "fcm://{token}" so the backend can distinguish from web push.
 *
 * IMPORTANT: PushSubscription schema types p256dh_key, auth_key, and
 * device_identifier as "string" (not nullable). Sending `null` for any of
 * these fails schema validation. p256dh_key and auth_key are marked as
 * required by the server schema, so we send empty strings for FCM
 * subscriptions (they're only used by the Web Push send path, not FCM).
 * device_identifier is optional and omitted when not available.
 */
async function persistNativeSubscription(userId, fcmToken) {
  if (!userId || !fcmToken) return null;

  const endpoint = `fcm://${fcmToken}`;
  const deviceIdentifier = localStorage.getItem('rxdeliver_device_identifier') || null;

  let userName = null;
  try {
    const appUsers = await base44.entities.AppUser.filter({ user_id: userId });
    userName = appUsers?.[0]?.user_name || null;
  } catch (_) { /* non-critical */ }

  // Check if this FCM token already exists
  const existing = await base44.entities.PushSubscription.filter({ user_id: userId, endpoint });
  if (existing && existing.length > 0) {
    const patch = { last_used_at: new Date().toISOString() };
    if (deviceIdentifier && !existing[0].device_identifier) patch.device_identifier = deviceIdentifier;
    if (userName && !existing[0].user_name) patch.user_name = userName;
    const updated = await base44.entities.PushSubscription.update(existing[0].id, patch);
    console.log('[NativePush] Updated existing FCM subscription');
    return updated || existing[0];
  }

  // Build create payload. p256dh_key / auth_key are Web Push-only concepts
  // but the Base44 schema marks them as required strings. Sending empty
  // strings satisfies validation without breaking FCM (sendPushNotification
  // only uses these fields for Web Push endpoints, not fcm:// endpoints).
  const payload = {
    user_id: userId,
    endpoint,
    user_agent: navigator.userAgent,
    last_used_at: new Date().toISOString(),
    p256dh_key: '',
    auth_key: '',
  };
  if (deviceIdentifier) payload.device_identifier = deviceIdentifier;
  if (userName) payload.user_name = userName;

  const created = await base44.entities.PushSubscription.create(payload);
  console.log('[NativePush] Created new FCM subscription');
  return created;
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
    return status.receive;
  } catch (_) {
    return 'unsupported';
  }
}
