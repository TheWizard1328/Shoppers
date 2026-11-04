/**
 * patientViewExit — shared plumbing for the App-Owner "Exit Patient View".
 *
 * The overlay's own floating button sat in the top-right corner on top of other
 * portal controls (owner report Nov 3 2026), so the exit affordance now lives
 * INSIDE the portal UI instead:
 *   • wide screens  → sidebar footer, between Sign Out and the version number
 *   • phone (drawer closed) → the floating today card, under the delivery date
 *
 * Both call requestExitPatientView(); PatientViewOverlay owns the teardown.
 */
export const PATIENT_VIEW_OVERLAY_FLAG = 'rxdeliver_patient_view_overlay';
export const PATIENT_VIEW_EXIT_EVENT = 'patientViewExitRequested';

export function isPatientViewOverlayActive() {
  try {
    return sessionStorage.getItem(PATIENT_VIEW_OVERLAY_FLAG) === '1';
  } catch (_) {
    return false;
  }
}

export function requestExitPatientView() {
  window.dispatchEvent(new CustomEvent(PATIENT_VIEW_EXIT_EVENT));
}
