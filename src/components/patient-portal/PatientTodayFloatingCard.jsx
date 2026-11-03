import React from 'react';
import { Sun } from 'lucide-react';
import PatientDeliveryCard from './PatientDeliveryCard';
import { buildDeliveryCardProps } from './deliveryCardHelpers';

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
export default function PatientTodayFloatingCard({ delivery, pickupStops, stores }) {
  if (!delivery) return null;

  const storeMap = {};
  (stores || []).forEach((s) => { storeMap[s.id] = s.name; });

  const cardProps = buildDeliveryCardProps(delivery, { pickupStops, storeMap });
  if (!cardProps) return null;

  return (
    <div
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
      <PatientDeliveryCard {...cardProps} expandInline />
    </div>
  );
}
