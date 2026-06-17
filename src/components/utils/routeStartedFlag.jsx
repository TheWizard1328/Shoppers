/**
 * routeStartedFlag — lightweight helper to compute and persist the RouteStarted flag.
 *
 * "RouteStarted" = at least one delivery with a finished status exists for a given driver/date.
 * Finished statuses: completed, failed, cancelled, returned.
 *
 * Persisted to IndexedDB under SYNC_METADATA so it survives app-backgrounding / OS memory pressure.
 * The IDB key is "RouteStarted::<driverId>::<deliveryDate>".
 */

import { offlineDB } from './offlineDatabase';

const FINISHED_STATUSES = new Set(['completed', 'failed', 'cancelled', 'returned']);

/** Compute the flag from an in-memory deliveries array */
export function computeRouteStarted(deliveries = [], driverId, deliveryDate) {
  if (!driverId || !deliveryDate || !Array.isArray(deliveries)) return false;
  return deliveries.some(
    (d) =>
      d &&
      d.driver_id === driverId &&
      d.delivery_date === deliveryDate &&
      FINISHED_STATUSES.has(d.status)
  );
}

/** Build the IDB scope key for a driver/date pair */
function scopeKey(driverId, deliveryDate) {
  return `${driverId}::${deliveryDate}`;
}

/** Persist the flag to IDB (non-blocking — fire and forget) */
export async function persistRouteStarted(driverId, deliveryDate, value) {
  if (!driverId || !deliveryDate) return;
  try {
    await offlineDB.updateSyncMetadata(
      'RouteStarted',
      null,
      new Date().toISOString(),
      {
        scope_key: scopeKey(driverId, deliveryDate),
        route_started: value,
        driver_id: driverId,
        delivery_date: deliveryDate,
      }
    );
  } catch {
    // Non-critical — in-memory state is the authoritative source
  }
}

/** Read the persisted flag from IDB (returns null if not found) */
export async function readPersistedRouteStarted(driverId, deliveryDate) {
  if (!driverId || !deliveryDate) return null;
  try {
    const meta = await offlineDB.getSyncMetadata('RouteStarted', scopeKey(driverId, deliveryDate));
    if (!meta || typeof meta.route_started !== 'boolean') return null;
    return meta.route_started;
  } catch {
    return null;
  }
}