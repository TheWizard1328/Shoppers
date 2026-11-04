/**
 * PatientViewOverlay
 * Renders the PatientPortal as a full-viewport overlay inside the current page.
 * AppOwner-only. Activated via activatePatientViewOverlay(patient).
 * Exiting happens from inside the portal: the sidebar footer (between Sign Out
 * and the version number) on wide screens, and the floating today card under the
 * delivery date on a phone. Both dispatch PATIENT_VIEW_EXIT_EVENT, handled here.
 */
import React, { useState, useEffect } from 'react';
import { PatientSessionManager } from './PatientSessionManager';
import PatientPortal from '@/pages/PatientPortal';
import {
  PATIENT_VIEW_OVERLAY_FLAG as OVERLAY_FLAG,
  PATIENT_VIEW_EXIT_EVENT,
  isPatientViewOverlayActive,
} from './patientViewExit';

export function activatePatientViewOverlay(patient) {
  PatientSessionManager.login(patient);
  sessionStorage.setItem(OVERLAY_FLAG, '1');
  window.dispatchEvent(new CustomEvent('patientViewOverlayChanged'));
}

export { isPatientViewOverlayActive };

export default function PatientViewOverlay() {
  const [active, setActive] = useState(isPatientViewOverlayActive);

  useEffect(() => {
    const handler = () => setActive(isPatientViewOverlayActive());
    window.addEventListener('patientViewOverlayChanged', handler);
    return () => window.removeEventListener('patientViewOverlayChanged', handler);
  }, []);

  // Exit requests come from INSIDE the portal (sidebar footer on wide screens,
  // the floating today card on a phone) instead of a floating top-right button
  // that covered other controls (owner report Nov 3 2026).
  useEffect(() => {
    const handler = () => {
      sessionStorage.removeItem(OVERLAY_FLAG);
      sessionStorage.removeItem('rxdeliver_patient_session');
      setActive(false);
    };
    window.addEventListener(PATIENT_VIEW_EXIT_EVENT, handler);
    return () => window.removeEventListener(PATIENT_VIEW_EXIT_EVENT, handler);
  }, []);

  if (!active) return null;

  return (
    <div
      className="fixed inset-0 z-[99999] bg-slate-100 dark:bg-slate-800 overflow-hidden"
      style={{
        isolation: 'isolate',
        // Safe-area insets (APK edge-to-edge): the overlay spans the full viewport,
        // including under the status bar and navigation bar. Pad the wrapper itself
        // so the embedded portal (which skips its own insets in embedded mode) starts
        // below the status bar and ends above the nav bar. Same variables MainActivity
        // injects on :root; env() fallback covers browsers/PWA where they're absent.
        paddingTop: 'var(--native-safe-top, env(safe-area-inset-top, 0px))',
        paddingBottom: 'var(--native-safe-bottom, env(safe-area-inset-bottom, 0px))',
        paddingLeft: 'var(--native-safe-left, env(safe-area-inset-left, 0px))',
        paddingRight: 'var(--native-safe-right, env(safe-area-inset-right, 0px))'
      }}
    >
      {/* Full-height container: the wrapper is padded by the safe-area insets, so the
          portal must fill the REMAINING box (h-full), not the raw viewport (h-screen).
          PatientPortal skips its own inset paddings in embedded mode to avoid doubling. */}
      <div className="h-full">
        <PatientPortal embedded />
      </div>
    </div>
  );
}