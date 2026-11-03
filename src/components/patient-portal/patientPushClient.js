import { base44 } from '@/api/base44Client';

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
  return navigator.serviceWorker.ready;
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
  if (!pushSupported()) return { ok: false, reason: 'unsupported' };
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
