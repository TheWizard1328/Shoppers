/**
 * PatientViewOverlay
 * Renders the PatientPortal as a full-viewport overlay on top of the current page.
 * AppOwner-only. Activated by writing a patient session + setting a flag in sessionStorage.
 * An "Exit Patient View" button in the top-right corner dismisses it.
 */
import React, { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import { PatientSessionManager } from './PatientSessionManager';
import PatientPortal from '@/pages/PatientPortal';

const OVERLAY_FLAG = 'rxdeliver_patient_view_overlay';

export function activatePatientViewOverlay(patient) {
  PatientSessionManager.login(patient);
  sessionStorage.setItem(OVERLAY_FLAG, '1');
  // Dispatch an event so the overlay component re-checks
  window.dispatchEvent(new CustomEvent('patientViewOverlayChanged'));
}

export function deactivatePatientViewOverlay() {
  sessionStorage.removeItem(OVERLAY_FLAG);
  PatientSessionManager.logout = () => {}; // prevent redirect on cleanup
  sessionStorage.removeItem('rxdeliver_patient_session');
  window.dispatchEvent(new CustomEvent('patientViewOverlayChanged'));
  // Restore logout behaviour
  PatientSessionManager.logout = function() {
    sessionStorage.removeItem('rxdeliver_patient_session');
    window.location.href = '/patient-login';
  };
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
      className="fixed inset-0 z-[99999] bg-slate-100 overflow-hidden"
      style={{ isolation: 'isolate' }}
    >
      {/* Exit button — top-right corner */}
      <button
        onClick={handleExit}
        className="absolute top-3 right-3 z-[100000] flex items-center gap-1.5 bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold px-3 py-2 rounded-lg shadow-lg transition-colors"
        title="Exit Patient View"
      >
        <X className="w-3.5 h-3.5" />
        Exit Patient View
      </button>

      {/* Render the full PatientPortal — GuardPortal will pass because session is set */}
      <PatientPortal />
    </div>
  );
}