import { base44 } from '@/api/base44Client';

let _initInFlight = null;

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

function isPushSupported() {
  return typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window;
}

/**
 * Get the push-capable service worker registration.
 * With push-sw.js removed, map-tile-sw.js is the sole SW and handles push.
 * We wait for it to be ready (up to 5s), then fall back to navigator.serviceWorker.ready.
 */
async function getPushRegistration() {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const registrations = await navigator.serviceWorker.getRegistrations();
    const tileReg = registrations.find(
      r => r.active?.scriptURL?.includes('map-tile-sw.js')
    );
    if (tileReg) return tileReg;
    await new Promise(r => setTimeout(r, 300));
  }
  return navigator.serviceWorker.ready;
}

async function persistSubscription(userId, subscription) {
  const raw = subscription.toJSON();
  const endpoint = raw.endpoint;
  const p256dh = raw.keys?.p256dh;
  const auth = raw.keys?.auth;
  if (!endpoint || !p256dh || !auth) {
    console.error('[pushNotifications] Missing subscription fields:', { endpoint: !!endpoint, p256dh: !!p256dh, auth: !!auth });
    return null;
  }

  // Device identifier — links this subscription to its device-specific
  // notification settings (notifications_enabled is per-device, not global).
  const deviceIdentifier = localStorage.getItem('rxdeliver_device_identifier') || null;

  // Denormalized user_name for easy identification in the PushSubscription table
  let userName = null;
  try {
    const appUsers = await base44.entities.AppUser.filter({ user_id: userId });
    userName = appUsers?.[0]?.user_name || null;
  } catch (_) { /* non-critical */ }

  try {
    const existing = await base44.entities.PushSubscription.filter({ user_id: userId, endpoint });
    if (existing && existing.length > 0) {
      // Backfill device_identifier + user_name on legacy subscriptions
      const patch = {};
      if (deviceIdentifier && !existing[0].device_identifier) patch.device_identifier = deviceIdentifier;
      if (userName && !existing[0].user_name) patch.user_name = userName;
      if (Object.keys(patch).length) {
        await base44.entities.PushSubscription.update(existing[0].id, patch).catch(() => {});
      }
      return existing[0];
    }

    const created = await base44.entities.PushSubscription.create({
      user_id: userId, endpoint, p256dh_key: p256dh, auth_key: auth,
      user_name: userName,
      user_agent: navigator.userAgent,
      device_identifier: deviceIdentifier
    });
    return created;
  } catch (e) {
    console.error('[pushNotifications] Persist failed:', e?.message || e);
    return null;
  }
}

export async function initPushNotifications(userId) {
  if (!userId || !isPushSupported()) return { ok: false, reason: 'unsupported' };
  if (_initInFlight) return _initInFlight;

  _initInFlight = (async () => {
    try {
      if (Notification.permission === 'denied') {
        console.warn('[pushNotifications] Permission denied');
        return { ok: false, reason: 'denied' };
      }

      if (Notification.permission === 'default') {
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
          console.warn('[pushNotifications] Permission not granted:', permission);
          return { ok: false, reason: 'permission_not_granted' };
        }
      }

      if (Notification.permission !== 'granted') {
        return { ok: false, reason: 'not_granted' };
      }

      const registration = await getPushRegistration();
      console.log('[pushNotifications] Using SW:', registration.active?.scriptURL);

      if (!registration?.pushManager) {
        console.error('[pushNotifications] No pushManager on registration');
        return { ok: false, reason: 'no_push_manager' };
      }

      let subscription = await registration.pushManager.getSubscription();

      if (!subscription) {
        const result = await base44.functions.invoke('getVapidPublicKey', {});
        const publicKey = result?.publicKey || result?.data?.publicKey;
        if (!publicKey) {
          console.warn('[pushNotifications] No VAPID public key returned:', result);
          return { ok: false, reason: 'no_vapid_key' };
        }
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey)
        });
        console.log('[pushNotifications] New push subscription created');
      } else {
        console.log('[pushNotifications] Existing subscription found, persisting...');
      }

      const persisted = await persistSubscription(userId, subscription);
      if (!persisted) {
        console.error('[pushNotifications] persistSubscription returned null');
        return { ok: false, reason: 'persist_failed' };
      }
      console.log('[pushNotifications] Subscription persisted for user', userId);
      return { ok: true, subscription: true };
    } catch (error) {
      console.warn('[pushNotifications] Init failed:', error?.message || error);
      return { ok: false, reason: 'error', error: error?.message || String(error) };
    } finally {
      _initInFlight = null;
    }
  })();
  return _initInFlight;
}

/**
 * Force re-subscribe: clears existing subscription and creates a fresh one.
 */
export async function resetPushSubscription(userId) {
  if (!userId || !isPushSupported()) return;
  try {
    const registration = await getPushRegistration();
    const existing = await registration.pushManager.getSubscription();
    if (existing) await existing.unsubscribe();
    _initInFlight = null;
    await initPushNotifications(userId);
  } catch (error) {
    console.warn('[pushNotifications] Reset failed:', error?.message || error);
  }
}