/**
 * pushNotifications.js — Web Push subscription flow for RxDeliver
 *
 * Handles:
 *  - Requesting Notification permission
 *  - Subscribing via the existing map-tile-sw.js service worker (push/notificationclick
 *    listeners live there — see public/map-tile-sw.js)
 *  - Persisting the subscription to the PushSubscription entity, keyed by the
 *    auth User id (currentUser.id) — the SAME id used for Message.sender_id/receiver_id,
 *    so notification triggers can push straight to it without any id translation.
 *  - Re-subscribing if the browser invalidates/rotates the push subscription
 *
 * NOTE: currentUser.id here is the base44 AUTH user id (see driverUtils.createMergedUser,
 * which sets `id: authUser.id`). This is NOT the same as AppUser.id (the AppUser record's
 * own id, used e.g. for Delivery.driver_id) — callers assigning a push to a *driver*
 * (identified by AppUser.id) must resolve that AppUser's `user_id` field first.
 */

import { base44 } from '@/api/base44Client';

let _initInFlight = null;

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

function isPushSupported() {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/**
 * Save (or update) the PushSubscription record for this user + endpoint.
 * De-dupes on (user_id, endpoint) so re-subscribing doesn't create duplicate rows.
 */
async function persistSubscription(userId, subscription) {
  const raw = subscription.toJSON();
  const endpoint = raw.endpoint;
  const p256dh = raw.keys?.p256dh;
  const auth = raw.keys?.auth;
  if (!endpoint || !p256dh || !auth) return;

  const existing = await base44.entities.PushSubscription.filter({ user_id: userId, endpoint }).catch(() => []);

  if (existing && existing.length > 0) {
    // Already registered — nothing to do (keys don't change for a stable endpoint)
    return existing[0];
  }

  return base44.entities.PushSubscription.create({
    user_id: userId,
    endpoint,
    p256dh_key: p256dh,
    auth_key: auth,
    user_agent: navigator.userAgent
  });
}

/**
 * Request permission (if not already granted/denied) and subscribe this device
 * to Web Push, persisting the subscription for `userId` (the auth user id).
 *
 * Safe to call multiple times — no-ops if unsupported, already subscribed, or
 * permission was previously denied.
 */
export async function initPushNotifications(userId) {
  if (!userId || !isPushSupported()) return;

  // Avoid duplicate concurrent init calls (e.g. Layout re-render churn)
  if (_initInFlight) return _initInFlight;

  _initInFlight = (async () => {
    try {
      if (Notification.permission === 'denied') return;

      if (Notification.permission === 'default') {
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') return;
      }

      if (Notification.permission !== 'granted') return;

      const registration = await navigator.serviceWorker.ready;

      let subscription = await registration.pushManager.getSubscription();

      if (!subscription) {
        const { publicKey } = await base44.functions.invoke('getVapidPublicKey', {});
        if (!publicKey) {
          console.warn('[pushNotifications] No VAPID public key returned — cannot subscribe');
          return;
        }
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey)
        });
      }

      await persistSubscription(userId, subscription);
    } catch (error) {
      console.warn('[pushNotifications] Init failed:', error?.message || error);
    } finally {
      _initInFlight = null;
    }
  })();

  return _initInFlight;
}

/**
 * Call when a subscription is known/suspected to be stale (e.g. after a
 * 'pushsubscriptionchange' event, which some browsers fire on rotation).
 * Re-subscribes and persists the new subscription.
 */
export async function resubscribePushNotifications(userId) {
  if (!userId || !isPushSupported()) return;
  try {
    const registration = await navigator.serviceWorker.ready;
    const existing = await registration.pushManager.getSubscription();
    if (existing) {
      await existing.unsubscribe().catch(() => {});
    }
    _initInFlight = null;
    await initPushNotifications(userId);
  } catch (error) {
    console.warn('[pushNotifications] Resubscribe failed:', error?.message || error);
  }
}
