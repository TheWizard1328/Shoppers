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

async function getPushRegistration() {
  // Prefer the dedicated push-sw.js registration
  const registrations = await navigator.serviceWorker.getRegistrations();
  const pushReg = registrations.find(r => r.active?.scriptURL?.includes('push-sw.js'));
  if (pushReg) return pushReg;
  // Fallback: wait for any ready SW
  return navigator.serviceWorker.ready;
}

async function persistSubscription(userId, subscription) {
  const raw = subscription.toJSON();
  const endpoint = raw.endpoint;
  const p256dh = raw.keys?.p256dh;
  const auth = raw.keys?.auth;
  if (!endpoint || !p256dh || !auth) return;

  const existing = await base44.entities.PushSubscription.filter({ user_id: userId, endpoint }).catch(() => []);
  if (existing && existing.length > 0) return existing[0];

  return base44.entities.PushSubscription.create({
    user_id: userId, endpoint, p256dh_key: p256dh, auth_key: auth, user_agent: navigator.userAgent
  });
}

export async function initPushNotifications(userId) {
  if (!userId || !isPushSupported()) return;
  if (_initInFlight) return _initInFlight;

  _initInFlight = (async () => {
    try {
      if (Notification.permission === 'denied') return;

      if (Notification.permission === 'default') {
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') return;
      }

      if (Notification.permission !== 'granted') return;

      const registration = await getPushRegistration();
      let subscription = await registration.pushManager.getSubscription();

      if (!subscription) {
        const { publicKey } = await base44.functions.invoke('getVapidPublicKey', {});
        if (!publicKey) {
          console.warn('[pushNotifications] No VAPID public key returned');
          return;
        }
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey)
        });
        console.log('[pushNotifications] New subscription created');
      }

      await persistSubscription(userId, subscription);
      console.log('[pushNotifications] Subscription persisted for user', userId);
    } catch (error) {
      console.warn('[pushNotifications] Init failed:', error?.message || error);
    } finally {
      _initInFlight = null;
    }
  })();
  return _initInFlight;
}

/**
 * Force re-subscribe (clears existing subscription and creates a fresh one).
 * Useful if VAPID keys changed or subscription expired.
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