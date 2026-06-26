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
      className="fixed inset-0 z-[99999] bg-slate-100 overflow-hidden"
      style={{ isolation: 'isolate' }}
    >
      {/* Exit button — forced light styling so it's always visible regardless of dark mode */}
      <button
        onClick={handleExit}
        className="absolute top-3 right-3 z-[100000] flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg shadow-lg transition-colors"
        style={{ background: '#1e40af', color: '#ffffff' }}
        onMouseEnter={e => e.currentTarget.style.background = '#1d4ed8'}
        onMouseLeave={e => e.currentTarget.style.background = '#1e40af'}
        title="Exit Patient View"
      >
        <X className="w-3.5 h-3.5" />
        Exit Patient View
      </button>

      <PatientPortal />
    </div>
  );
}