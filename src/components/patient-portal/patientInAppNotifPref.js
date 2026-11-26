/**
 * In-app notification preference for the patient portal (owner request Nov 25
 * 2026). The header bell now cycles three states — both off, system on / in-app
 * off, both on — so the in-app half of that pair needs to be remembered on the
 * device. Default is ON, which keeps the current behaviour for every patient who
 * already had phone alerts working.
 */
const KEY = 'rx_patient_inapp_notifications';
export const INAPP_PREF_EVENT = 'rx-patient-inapp-pref';

export function getInAppNotifications() {
  try {
    return localStorage.getItem(KEY) !== '0';
  } catch {
    return true;
  }
}

export function setInAppNotifications(on) {
  try {
    localStorage.setItem(KEY, on ? '1' : '0');
  } catch { /* private mode: the session still reflects the change */ }
  try {
    window.dispatchEvent(new CustomEvent(INAPP_PREF_EVENT, { detail: { on: !!on } }));
  } catch { /* no window (SSR) */ }
}
