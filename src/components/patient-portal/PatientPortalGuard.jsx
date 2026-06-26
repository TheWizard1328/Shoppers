import { useEffect } from 'react';
import { PatientSessionManager } from './PatientSessionManager';

const OVERLAY_FLAG = 'rxdeliver_patient_view_overlay';

/**
 * Mounts on every patient portal page.
 * Checks session validity every 60 seconds and on mount.
 * If invalid/expired → redirects to /patient-login.
 * Skips redirect entirely when running inside the PatientViewOverlay.
 */
export default function PatientPortalGuard() {
  useEffect(() => {
    // Running inside the in-app overlay — never redirect
    if (sessionStorage.getItem(OVERLAY_FLAG) === '1') return;

    // Check immediately on mount
    if (!PatientSessionManager.isValid()) {
      window.location.href = '/patient-login';
      return;
    }

    // Then check every 60 seconds
    const interval = setInterval(() => {
      if (sessionStorage.getItem(OVERLAY_FLAG) === '1') return;
      if (!PatientSessionManager.isValid()) {
        window.location.href = '/patient-login';
      }
    }, 60_000);

    return () => clearInterval(interval);
  }, []);

  return null;
}