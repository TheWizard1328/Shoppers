import React from 'react';

/**
 * Distance from store badge (owner spec Nov 6 2026).
 *
 * Sits right-justified on the same row as the Store label in the Add to Route,
 * Edit Delivery and Edit Patient forms, and shows the SELECTED patient's
 * distance from its assigned store. Read-only — the value comes from the
 * patient record's distance_from_store (the number payroll already trusts).
 */
export default function DistanceFromStoreBadge({ distanceKm, className = '', title }) {
  const km = Number(distanceKm);
  if (!Number.isFinite(km) || km <= 0) return null;

  return (
    <span
      title={title || 'Distance from this patient\'s assigned store'}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold border
        bg-sky-100 text-sky-800 border-sky-200
        dark:bg-sky-900/40 dark:text-sky-200 dark:border-sky-800
        select-none whitespace-nowrap ${className}`}>
      {km.toFixed(2)} km
    </span>
  );
}
