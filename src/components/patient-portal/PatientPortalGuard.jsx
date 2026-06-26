import { useEffect } from 'react';
import { PatientSessionManager } from './PatientSessionManager';

/**
 * Mounts on every patient portal page.
 * Checks session validity every 60 seconds and on mount.
 * If invalid/expired → redirects to /patient-login.
 */
export default function PatientPortalGuard() {
  useEffect(() => {
    // Check immediately on mount
    if (!PatientSessionManager.isValid()) {
      window.location.href = '/patient-login';
      return;
    }

    // Then check every 60 seconds
    const interval = setInterval(() => {
      if (!PatientSessionManager.isValid()) {
        window.location.href = '/patient-login';
      }
    }, 60_000);

    return () => clearInterval(interval);
  }, []);

  return null;
}