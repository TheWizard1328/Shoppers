/**
 * PatientViewOverlay
 * Renders the PatientPortal as a full-viewport overlay inside the current page.
 * AppOwner-only. Activated via activatePatientViewOverlay(patient).
 * An "Exit Patient View" button dismisses it without navigating away.
 */
import React, { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import { PatientSessionManager } from './PatientSessionManager';
import PatientPortal from '@/pages/PatientPortal';

const OVERLAY_FLAG = 'rxdeliver_patient_view_overlay';

export function activatePatientViewOverlay(patient) {
  PatientSessionManager.login(patient);
  sessionStorage.setItem(OVERLAY_FLAG, '1');
  window.dispatchEvent(new CustomEvent('patientViewOverlayChanged'));
}

export function isPatientViewOverlayActive() {
  return sessionStorage.getItem(OVERLAY_FLAG) === '1';
}

export default function PatientViewOverlay() {
  const [active, setActive] = useState(isPatientViewOverlayActive);

  useEffect(() => {
    const handler = () => setActive(isPatientViewOverlayActive());
    window.addEventListener('patientViewOverlayChanged', handler);
    return () => window.removeEventListener('patientViewOverlayChanged', handler);
  }, []);

  if (!active) return null;

  const handleExit = () => {
    sessionStorage.removeItem(OVERLAY_FLAG);
    sessionStorage.removeItem('rxdeliver_patient_session');
    setActive(false);
  };

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
      {/* Exit button — forced light styling so it's always visible regardless of dark mode.
          Offset below the status bar via the same native-safe variables. */}
      <button
        onClick={handleExit}
        className="absolute right-3 z-[100000] flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg shadow-lg transition-colors"
        style={{
          background: '#1e40af',
          color: '#ffffff',
          top: 'calc(0.75rem + var(--native-safe-top, env(safe-area-inset-top, 0px)))'
        }}
        onMouseEnter={e => e.currentTarget.style.background = '#1d4ed8'}
        onMouseLeave={e => e.currentTarget.style.background = '#1e40af'}
        title="Exit Patient View"
      >
        <X className="w-3.5 h-3.5" />
        Exit Patient View
      </button>

      {/* Full-height container: the wrapper is padded by the safe-area insets, so the
          portal must fill the REMAINING box (h-full), not the raw viewport (h-screen).
          PatientPortal skips its own inset paddings in embedded mode to avoid doubling. */}
      <div className="h-full">
        <PatientPortal embedded />
      </div>
    </div>
  );
}