import React, { useEffect, useRef, useState } from 'react';
import { Sun, X } from 'lucide-react';
import PatientDeliveryCard from './PatientDeliveryCard';
import { buildDeliveryCardProps } from './deliveryCardHelpers';
import { isPatientViewOverlayActive, requestExitPatientView } from './patientViewExit';

/**
 * PatientTodayFloatingCard (owner request Nov 2 2026)
 *
 * On a phone the sidebar is hidden, so today's delivery card would be out of
 * sight. This floats that same card in the TOP LEFT corner of the map, with the
 * identical expand/collapse behaviour (it IS PatientDeliveryCard).
 *
 * Once the delivery date has passed the card is gone: the portal only resolves
 * todayDelivery for TODAY's date, so nothing renders tomorrow.
 */
export default function PatientTodayFloatingCard({ delivery, pickupStops, stores, onCollapsedHeight, remainingStops = null }) {
  // The portal reserves map top padding for this card. Report its COLLAPSED
  // height (the smallest height observed) so expanding the details never pushes
  // the map around — the owner asked for the minimum, unexpanded height.
  const wrapRef = useRef(null);
  const minHeightRef = useRef(0);
  // App-Owner preview only (owner request Nov 3 2026): on a phone the sidebar is
  // hidden, so the exit control rides this card, right under the date.
  const [canExitPreview] = useState(isPatientViewOverlayActive);

  useEffect(() => {
    if (!wrapRef.current || !onCollapsedHeight) return undefined;
    const node = wrapRef.current;
    const report = () => {
      const h = Math.round(node.getBoundingClientRect().height || 0);
      if (!h) return;
      if (!minHeightRef.current || h < minHeightRef.current) {
        minHeightRef.current = h;
        onCollapsedHeight(h);
      }
    };
    report();
    let observer = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(report);
      observer.observe(node);
    }
    window.addEventListener('orientationchange', report);
    return () => {
      observer?.disconnect();
      window.removeEventListener('orientationchange', report);
    };
  }, [onCollapsedHeight]);

  if (!delivery) return null;

  const storeMap = {};
  (stores || []).forEach((s) => { storeMap[s.id] = s.name; });

  const cardProps = buildDeliveryCardProps(delivery, { pickupStops, storeMap });
  if (!cardProps) return null;

  const exitSlot = canExitPreview ? (
    <span
      role="button"
      tabIndex={0}
      onClick={(e) => { e.stopPropagation(); requestExitPatientView(); }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); requestExitPatientView(); }
      }}
      className="inline-flex items-center gap-1 mt-1 px-2 py-0.5 rounded-md text-[10px] font-semibold leading-tight text-white shadow-sm"
      style={{ background: '#1e40af' }}
      title="Exit Patient View"
    >
      <X className="w-2.5 h-2.5" />
      Exit Patient View
    </span>
  ) : null;

  return (
    <div
      ref={wrapRef}
      className="w-[19rem] max-w-[calc(100vw-2.5rem)] overflow-y-auto rounded-xl bg-white/95 dark:bg-slate-900/95 backdrop-blur shadow-lg border border-slate-200 dark:border-slate-700 p-2"
      // Grows with the expanded details, only scrolling once it fills the map
      // area (previously a fixed 55vh cap clipped the expansion).
      style={{ maxHeight: 'calc(100% - 1rem)' }}
    >
      <div className="flex items-center gap-1.5 px-1 pb-1.5">
        <Sun className="w-3.5 h-3.5 text-amber-500" />
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          Today
        </p>
      </div>
      <PatientDeliveryCard {...cardProps} remainingStops={remainingStops} expandInline belowDateSlot={exitSlot} />
    </div>
  );
}
