import { base44 } from '@/api/base44Client';
import { isCapacitorNativeApp, getCapacitorPlatform } from '@/components/utils/locationProviders/capacitorRuntime';

// OWNER REPORT (Nov 25 2026): inside the APK the portal said "This browser cannot
// show notifications" because Android WebView has no Push API. The APK ships the
// Capacitor PushNotifications plugin (real FCM), so the portal registers an
// fcm:// subscription against the patient instead.
const PATIENT_FCM_TOKEN_KEY = 'rxdeliver_patient_fcm_token';
export const isNativeAndroid = () => {
  // OWNER REPORT (Nov 25 2026): the APK still fell through to the web path and
  // reported no_push_manager, so Capacitor's own detection is not trusted alone.
  // Any native marker means "this is the APK, use FCM".
  try {
    const cap = typeof window !== 'undefined' ? window.Capacitor : null;
    const platform = String(cap?.getPlatform?.() || cap?.platform || '').toLowerCase();
    if (platform === 'android') return true;
    if (cap?.isNativePlatform?.() === true) return true;
  } catch { /* fall through */ }
  try {
    if (isCapacitorNativeApp() && getCapacitorPlatform() === 'android') return true;
  } catch { /* fall through */ }
  try {
    if (typeof window !== 'undefined' && (window.AndroidNative || window.__RXDELIVER_NATIVE__)) return true;
    if (typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent || '') && /; wv\)/.test(navigator.userAgent || '')) return true;
  } catch { /* fall through */ }
  return false;
};

/** The Capacitor push plugin, via the bundle or the runtime bridge. */
async function getNativePushPlugin() {
  try {
    const mod = await import('@capacitor/push-notifications');
    if (mod?.PushNotifications) return { PushNotifications: mod.PushNotifications };
  } catch { /* fall through to the bridge */ }
  const bridge = typeof window !== 'undefined' ? window?.Capacitor?.Plugins?.PushNotifications : null;
  if (bridge) return { PushNotifications: bridge };
  throw new Error('push_plugin_missing');
}

/**
 * Patient portal push notifications (owner build Nov 2 2026).
 *
 * Patients are NOT Base44 users, so the staff helper in
 * components/utils/pushNotifications.js cannot be used: it needs a user id and
 * an authenticated session. This module talks to the `patientPush` backend
 * function instead, which stores the subscription under `patient:<id>` and
 * returns the VAPID public key the browser needs.
 *
 * Device requirements (no APK needed):
 *   - Android Chrome / desktop Chrome / Edge: push works from the browser.
 *   - iPhone / iPad: iOS 16.4+ and the portal must be added to the Home Screen
 *     (Apple only allows web push for installed web apps).
 */

const DEVICE_ID_KEY = 'rxdeliver_patient_device_id';

export function getPatientDeviceId() {
  try {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
      id = `pat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
  } catch {
    return '';
  }
}

export function isIosDevice() {
  try {
    const ua = navigator.userAgent || '';
    return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1);
  } catch {
    return false;
  }
}

export function isStandalonePwa() {
  try {
    return window.matchMedia?.('(display-mode: standalone)')?.matches
      || window.navigator.standalone === true;
  } catch {
    return false;
  }
}

export function pushSupported() {
  if (isNativeAndroid()) return true;
  return typeof window !== 'undefined'
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window;
}

async function getRegistration() {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    const regs = await navigator.serviceWorker.getRegistrations();
    const tile = regs.find((r) => r.active?.scriptURL?.includes('map-tile-sw.js'));
    if (tile) return tile;
    await new Promise((r) => setTimeout(r, 250));
  }
  // NOTHING REGISTERED: the app deliberately unregisters service workers on the
  // preview/editor host, so a patient who taps "Turn on notifications" there had
  // no worker at all (that is the no_push_manager error). A tap is an explicit
  // request, so register the combined tile+push worker here. It caches tiles and
  // handles push only — it never caches the app shell.
  let registered = null;
  try {
    registered = await navigator.serviceWorker.register('/map-tile-sw.js').catch(() => null);
  } catch { registered = null; }
  if (registered?.pushManager) return registered;

  // NEVER wait forever: `navigator.serviceWorker.ready` does not resolve at all
  // when no worker controls the page, which left the portal stuck on
  // "Checking this device..." on iOS. Give it a hard ceiling.
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise((resolve) => setTimeout(() => resolve(null), 6000)),
  ]).catch(() => null);
}

const urlBase64ToUint8Array = (base64String) => {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
};

/** 'unsupported' | 'blocked' | 'off' | 'on' | 'needs-install' */
export async function getPatientPushState() {
  if (isNativeAndroid()) {
    try {
      const { PushNotifications } = await getNativePushPlugin();
      const status = await PushNotifications.checkPermissions();
      if (status?.receive === 'denied') return 'blocked';
      const token = localStorage.getItem(PATIENT_FCM_TOKEN_KEY);
      if (status?.receive === 'granted' && token) return 'on';
      return 'off';
    } catch {
      return 'off';
    }
  }
  if (!pushSupported()) {
    return isIosDevice() && !isStandalonePwa() ? 'needs-install' : 'unsupported';
  }
  if (isIosDevice() && !isStandalonePwa()) return 'needs-install';
  if (Notification.permission === 'denied') return 'blocked';
  try {
    const reg = await getRegistration();
    const sub = await reg?.pushManager?.getSubscription();
    if (sub && Notification.permission === 'granted') return 'on';
  } catch {
    /* fall through */
  }
  return 'off';
}

/** Ask permission, subscribe this device and register it against the patient. */
export async function enablePatientPush(patient) {
  if (!patient?.id) return { ok: false, reason: 'no_patient' };

  // ── APK (Capacitor + FCM) ────────────────────────────────────────────────
  if (isNativeAndroid()) {
    try {
      const { PushNotifications } = await getNativePushPlugin();
      if (perm?.receive !== 'granted') perm = await PushNotifications.requestPermissions();
      if (perm?.receive !== 'granted') return { ok: false, reason: 'permission' };

      const token = await new Promise((resolve) => {
        let settled = false;
        const done = (value) => { if (!settled) { settled = true; resolve(value); } };
        try {
          PushNotifications.addListener('registration', (t) => done(t?.value || '')).catch(() => {});
          PushNotifications.addListener('registrationError', () => done('')).catch(() => {});
          PushNotifications.register().catch(() => done(''));
        } catch { done(''); }
        setTimeout(() => done(''), 15000);
      });
      if (!token) return { ok: false, reason: 'no_token' };

      const res = await base44.functions.invoke('patientPush', {
        action: 'register',
        patient_id: patient.id,
        subscription: { endpoint: `fcm://${token}`, keys: { p256dh: '', auth: '' } },
        device_identifier: getPatientDeviceId(),
        user_agent: navigator.userAgent || '',
      });
      const ok = res?.data?.ok === true || res?.ok === true;
      if (ok) {
        try { localStorage.setItem(PATIENT_FCM_TOKEN_KEY, token); } catch { /* private mode */ }
      }
      return { ok, reason: ok ? null : (res?.data?.error || 'register_failed') };
    } catch (error) {
      return { ok: false, reason: error?.message || 'error' };
    }
  }

  if (!pushSupported()) {
    // iPhone/iPad: only a Safari Home Screen app can receive web push. Chrome on
    // iOS cannot, and a plain Safari tab cannot either.
    if (isIosDevice()) return { ok: false, reason: isStandalonePwa() ? 'ios_unsupported_browser' : 'needs_install' };
    return { ok: false, reason: 'unsupported' };
  }
  if (isIosDevice() && !isStandalonePwa()) return { ok: false, reason: 'needs_install' };

  try {
    if (Notification.permission === 'default') {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') return { ok: false, reason: 'permission' };
    }
    if (Notification.permission !== 'granted') return { ok: false, reason: 'permission' };

    const reg = await getRegistration();
    if (!reg?.pushManager) return { ok: false, reason: 'no_push_manager' };

    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const keyRes = await base44.functions.invoke('patientPush', { action: 'vapid' });
      const publicKey = keyRes?.data?.publicKey || keyRes?.publicKey;
      if (!publicKey) return { ok: false, reason: 'no_vapid_key' };
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
    }

    const res = await base44.functions.invoke('patientPush', {
      action: 'register',
      patient_id: patient.id,
      subscription: { endpoint: sub.endpoint, keys: { p256dh: sub.toJSON().keys.p256dh, auth: sub.toJSON().keys.auth } },
      device_identifier: getPatientDeviceId(),
      user_agent: navigator.userAgent || '',
    });
    const ok = res?.data?.ok === true || res?.ok === true;
    return { ok, reason: ok ? null : (res?.data?.error || 'register_failed') };
  } catch (error) {
    return { ok: false, reason: error?.message || 'error' };
  }
}

/** Remove this device's subscription for the patient. */
export async function disablePatientPush(patient) {
  if (!patient?.id) return { ok: false };
  if (isNativeAndroid()) {
    try {
      const token = localStorage.getItem(PATIENT_FCM_TOKEN_KEY);
      if (token) {
        await base44.functions.invoke('patientPush', {
          action: 'unregister',
          patient_id: patient.id,
          subscription: { endpoint: `fcm://${token}` },
        }).catch(() => {});
      }
      localStorage.removeItem(PATIENT_FCM_TOKEN_KEY);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }
  try {
    const reg = await getRegistration();
    const sub = await reg?.pushManager?.getSubscription();
    if (sub) {
      await base44.functions.invoke('patientPush', {
        action: 'unregister',
        patient_id: patient.id,
        subscription: { endpoint: sub.endpoint },
      }).catch(() => {});
      await sub.unsubscribe().catch(() => {});
    }
    return { ok: true };
  } catch {
    return { ok: false };
  }
}
