/**
 * cyclingLocationCache
 *
 * One shared, TTL-cached CyclingLocation.list() per session.
 *
 * WHY (owner report Nov 15 2026): RouteActionButtons re-listed the whole
 * CyclingLocation entity on every dashboard mount, and CyclingMarkerStopCard
 * kept its OWN module-level copy — so each app refresh fired the read again
 * (those were the `CyclingLocation · GET` entries in the RATE LIMIT tooltip)
 * even though the data is a small, rarely-changing location library.
 */

import { base44 } from '@/api/base44Client';

const TTL_MS = 5 * 60 * 1000;

let cache = null;
let cachedAt = 0;
let inflight = null;

export const getCyclingLocationsCached = async () => {
  if (cache && Date.now() - cachedAt < TTL_MS) return cache;
  if (inflight) return inflight;
  inflight = base44.entities.CyclingLocation.list()
    .then((rows) => {
      cache = rows || [];
      cachedAt = Date.now();
      return cache;
    })
    .catch(() => cache || [])
    .finally(() => { inflight = null; });
  return inflight;
};

/** Keep the shared cache current after a create/update from the form. */
export const invalidateCyclingLocationCache = () => {
  cache = null;
  cachedAt = 0;
};