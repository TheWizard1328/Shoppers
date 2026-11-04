import React, { useState } from 'react';
import { HeartPulse, LogOut, Package, ChevronDown, ChevronUp, X } from 'lucide-react';
import PatientDeliveryCard from './PatientDeliveryCard';
import { buildDeliveryCardProps } from './deliveryCardHelpers';
import { PatientSessionManager } from './PatientSessionManager';
import { formatAppVersion } from '@/version';
import { isPatientViewOverlayActive, requestExitPatientView } from './patientViewExit';

export default function PatientSidebar({ puidGroups, patient, deliveries, pickupStops, stores, isOpen, onClose, embedded = false, liveRemainingStops = null }) {
  const [showAll, setShowAll] = useState(false);
  // App-Owner preview only: the exit control lives here instead of a floating
  // top-right button that covered other portal controls (owner report Nov 3 2026).
  const [canExitPreview] = useState(isPatientViewOverlayActive);

  const storeMap = {};
  (stores || []).forEach((s) => { storeMap[s.id] = s.name; });

  // Sort deliveries newest first
  const sorted = [...(deliveries || [])].sort((a, b) =>
    (b.delivery_date || '').localeCompare(a.delivery_date || '')
  );

  const displayed = showAll ? sorted : sorted.slice(0, 10);

  const handleLogout = () => {
    if (window.confirm('Are you sure you want to sign out?')) {
      PatientSessionManager.logout();
    }
  };

  return (
    <>
      {/* Overlay on mobile */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/40 z-[999] md:hidden"
          onClick={onClose}
        />
      )}

      <div
        /* ABSOLUTE, not fixed (owner fix Nov 2 2026). The panel now fills the
           PORTAL BOX (root is relative, inset-y-0) instead of the raw viewport.
           Fixed positioning ignored the App-Owner "Exit Patient View" overlay's
           safe-area padding wrapper, so the panel started above the padded box
           (a strip of empty space at the top) while its bottom ran under the
           device navigation bar. Filling the box puts it flush at the top and
           stops it exactly where the box does.
           z-[100001]: above the tracking badge (z-1000) and above the overlay's
           Exit Patient View button (z-100000) — owner request. */
        className={`absolute inset-y-0 left-0 w-72 max-h-full bg-slate-50 dark:bg-slate-800 border-r border-slate-200 dark:border-slate-700 flex flex-col z-[100001] transform transition-transform duration-300 ${
          isOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'
        }`}
      >
        {/* Header */}
        <div
          className="p-4 border-b border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 flex-shrink-0"
          /* Embedded (App-Owner overlay): the overlay wrapper already pads the
             safe-area insets, so the sidebar must NOT add them again — that was
             the extra empty strip at the top of the panel. */
          style={{ paddingTop: embedded ? '1rem' : 'calc(1rem + var(--native-safe-top, env(safe-area-inset-top, 0px)))' }}
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-slate-900 flex items-center justify-center flex-shrink-0">
              <HeartPulse className="w-5 h-5 text-white" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs text-slate-400 dark:text-slate-400 font-medium">Patient Portal</p>
              <p className="text-sm font-bold text-slate-900 dark:text-slate-100 truncate">{patient?.full_name || 'Patient'}</p>
            </div>
          </div>
        </div>

        {/* Delivery History */}
        <div className="flex-1 overflow-y-auto p-3">
          <div className="flex items-center gap-2 px-1 mb-3">
            <Package className="w-4 h-4 text-slate-400 dark:text-slate-400" />
            <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
              Delivery History
            </p>
            {sorted.length > 0 && (
              <span className="ml-auto text-xs bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-200 rounded-full px-2 py-0.5 font-medium">
                {sorted.length}
              </span>
            )}
          </div>

          {sorted.length === 0 ? (
            <div className="text-center py-8 px-4">
              <Package className="w-8 h-8 text-slate-300 mx-auto mb-2" />
              <p className="text-sm text-slate-400 dark:text-slate-400">No past deliveries yet.</p>
            </div>
          ) : (
            <div className="space-y-2 relative">
              {displayed.map((delivery) => (
                <PatientDeliveryCard
                  key={delivery.id}
                  {...buildDeliveryCardProps(delivery, { pickupStops, puidGroups, storeMap })}
                  remainingStops={liveRemainingStops?.[delivery.id] ?? null}
                />
              ))}

              {sorted.length > 10 && (
                <button
                  onClick={() => setShowAll((v) => !v)}
                  className="w-full flex items-center justify-center gap-1.5 text-xs font-medium text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300 py-2 mt-1"
                >
                  {showAll ? (
                    <><ChevronUp className="w-3.5 h-3.5" /> Show Less</>
                  ) : (
                    <><ChevronDown className="w-3.5 h-3.5" /> Show {sorted.length - 10} More</>
                  )}
                </button>
              )}


            </div>
          )}
        </div>

        {/* Footer */}
        <div
          className="p-3 border-t border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 flex-shrink-0"
          style={{ paddingBottom: embedded ? '0.75rem' : 'calc(0.75rem + var(--native-safe-bottom, env(safe-area-inset-bottom, 0px)))' }}
        >
          {/* Sign Out + Exit, EVENLY SPACED (owner request Nov 3 2026): the row
              used to be a wide Sign Out, a small Exit pill and the version all
              crammed together, which left the two actions looking unrelated and
              the row unbalanced. The two buttons now share the width 50/50 with
              matching height and text size, and the build number drops to its own
              right-aligned line underneath, so it is still readable without
              squeezing the buttons. */}
          <div className="flex items-center gap-2">
            <button
              onClick={handleLogout}
              className="flex-1 min-w-0 flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg border border-slate-200 dark:border-slate-700 text-sm font-semibold text-slate-600 dark:text-slate-300 hover:bg-red-50 dark:hover:bg-red-950 hover:border-red-200 dark:hover:border-red-900 hover:text-red-600 transition-colors"
            >
              <LogOut className="w-4 h-4 flex-shrink-0" />
              <span className="truncate">Sign Out</span>
            </button>
            {/* EXIT PATIENT VIEW — app-owner only. Same footprint as Sign Out so
                the pair reads as one control group. */}
            {canExitPreview && (
              <button
                onClick={requestExitPatientView}
                className="flex-1 min-w-0 flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-sm font-semibold text-white shadow-sm transition-colors"
                style={{ background: '#1e40af' }}
                onMouseEnter={(e) => { e.currentTarget.style.background = '#1d4ed8'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = '#1e40af'; }}
                title="Exit Patient View"
              >
                <X className="w-4 h-4 flex-shrink-0" />
                <span className="truncate">Exit</span>
              </button>
            )}
          </div>
          <div className="mt-1 text-right">
            <span
              className="text-[11px] font-medium tabular-nums text-slate-400 dark:text-slate-500"
              title="App version"
            >
              {formatAppVersion()}
            </span>
          </div>
        </div>
      </div>
    </>
  );
}