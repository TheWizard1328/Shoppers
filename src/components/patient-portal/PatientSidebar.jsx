import React, { useState } from 'react';
import { HeartPulse, LogOut, Package, ChevronDown, ChevronUp, X } from 'lucide-react';
import PatientDeliveryCard from './PatientDeliveryCard';
import { buildDeliveryCardProps } from './deliveryCardHelpers';
import { PatientSessionManager } from './PatientSessionManager';
import { isPatientViewOverlayActive, requestExitPatientView } from './patientViewExit';

export default function PatientSidebar({ puidGroups, patient, deliveries, pickupStops, stores, isOpen, onClose, embedded = false, liveRemainingStops = null }) {
  const [showAll, setShowAll] = useState(false);
  // App-Owner preview only: the exit control lives here instead of a floating
  // top-right button that covered other portal controls (owner report Nov 3 2026).
  const [canExitPreview] = useState(isPatientViewOverlayActive);

  const storeMap = {};
  (stores || []).forEach((s) => {storeMap[s.id] = s.name;});

  // Sort deliveries newest first
  const sorted = [...(deliveries || [])].sort((a, b) =>
  (b.delivery_date || '').localeCompare(a.delivery_date || '')
  );

  // ── UPCOMING FIRST (owner request Nov 25 2026) ─────────────────────────────
  // "we will show the future delivery cards in the sidebar above the current
  // date delivery card". The list is already newest-first, so upcoming dates
  // landed on top by accident; they are now pulled into their own labelled block
  // so an upcoming stop never reads as history, and today's card sits directly
  // under them.
  const now = new Date();
  const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const upcoming = sorted.filter((d) =>
  String(d?.delivery_date || '').slice(0, 10) > todayKey &&
  !['cancelled', 'failed'].includes(String(d?.status || '').toLowerCase())
  );
  const upcomingIds = new Set(upcoming.map((d) => d.id));
  const history = sorted.filter((d) => !upcomingIds.has(d.id));

  const displayed = showAll ? history : history.slice(0, 10);

  const handleLogout = () => {
    if (window.confirm('Are you sure you want to sign out?')) {
      PatientSessionManager.logout();
    }
  };

  return (
    <>
      {/* Overlay on mobile */}
      {isOpen &&
      <div
        className="fixed inset-0 bg-black/40 z-[999] md:hidden"
        onClick={onClose} />

      }

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
        isOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}`
        }>
        
        {/* Header */}
        <div
          className="p-4 border-b border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 flex-shrink-0"
          /* Embedded (App-Owner overlay): the overlay wrapper already pads the
             safe-area insets, so the sidebar must NOT add them again — that was
             the extra empty strip at the top of the panel. */
          style={{ paddingTop: embedded ? '1rem' : 'calc(1rem + var(--app-inset-top))' }}>
          
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
        <div className="flex-1 overflow-y-auto px-2 py-2">
          {/* UPCOMING BLOCK — future-dated stops, above today's own card. */}
          {upcoming.length > 0 &&
          <>
              <div className="flex items-center gap-2 px-1 mb-2">
                <Package className="w-4 h-4 text-blue-500 dark:text-blue-400" />
                <p className="text-xs font-semibold text-blue-600 dark:text-blue-400 uppercase tracking-wide">
                  Upcoming
                </p>
                <span className="ml-auto text-xs bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300 rounded-full px-2 py-0.5 font-medium">
                  {upcoming.length}
                </span>
              </div>
              <div className="space-y-2 mb-3">
                {upcoming.map((delivery) =>
              <PatientDeliveryCard
                key={delivery.id}
                {...buildDeliveryCardProps(delivery, { pickupStops, puidGroups, storeMap })}
                remainingStops={liveRemainingStops?.[delivery.id] ?? null} />

              )}
              </div>
            </>
          }

          <div className="flex items-center gap-2 px-1 mb-3">
            <Package className="w-4 h-4 text-slate-400 dark:text-slate-400" />
            <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
              Delivery History
            </p>
            {history.length > 0 &&
            <span className="ml-auto text-xs bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-200 rounded-full px-2 py-0.5 font-medium">
                {history.length}
              </span>
            }
          </div>

          {history.length === 0 ?
          <div className="text-center py-8 px-4">
              <Package className="w-8 h-8 text-slate-300 mx-auto mb-2" />
              <p className="text-sm text-slate-400 dark:text-slate-400">{upcoming.length > 0 ? 'No past deliveries yet.' : 'No deliveries yet.'}</p>
            </div> :

          <div className="space-y-2 relative">
              {displayed.map((delivery) =>
            <PatientDeliveryCard
              key={delivery.id}
              {...buildDeliveryCardProps(delivery, { pickupStops, puidGroups, storeMap })}
              remainingStops={liveRemainingStops?.[delivery.id] ?? null} />

            )}

              {history.length > 10 &&
            <button
              onClick={() => setShowAll((v) => !v)}
              className="w-full flex items-center justify-center gap-1.5 text-xs font-medium text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300 py-2 mt-1">
              
                  {showAll ?
              <><ChevronUp className="w-3.5 h-3.5" /> Show Less</> :

              <><ChevronDown className="w-3.5 h-3.5" /> Show {history.length - 10} More</>
              }
                </button>
            }


            </div>
          }
        </div>

        {/* Footer */}
        <div
          className="p-3 border-t border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 flex-shrink-0"
          style={{ paddingBottom: embedded ? '0.75rem' : 'calc(0.75rem + var(--app-inset-bottom))' }}>
          
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
              className="flex-1 min-w-0 flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg border border-slate-200 dark:border-slate-700 text-sm font-semibold text-slate-600 dark:text-slate-300 hover:bg-red-50 dark:hover:bg-red-950 hover:border-red-200 dark:hover:border-red-900 hover:text-red-600 transition-colors">
              
              <LogOut className="w-4 h-4 flex-shrink-0" />
              <span className="truncate">Sign Out</span>
            </button>
            {/* EXIT PATIENT VIEW — app-owner only. Same footprint as Sign Out so
                 the pair reads as one control group. */}
            {canExitPreview &&
            <button
              onClick={requestExitPatientView}
              className="flex-1 min-w-0 flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-sm font-semibold text-white shadow-sm transition-colors"
              style={{ background: '#1e40af' }}
              onMouseEnter={(e) => {e.currentTarget.style.background = '#1d4ed8';}}
              onMouseLeave={(e) => {e.currentTarget.style.background = '#1e40af';}}
              title="Exit Patient View">
              
                <X className="w-4 h-4 flex-shrink-0" />
                <span className="truncate">Exit</span>
              </button>
            }
          </div>
          {/* Version line REMOVED (owner request Nov 23 2026): "remove the version
              number from the side bar". The portal header already shows it as the
              third row, so the footer is just the two action buttons now. */}
        </div>
      </div>
    </>);

}