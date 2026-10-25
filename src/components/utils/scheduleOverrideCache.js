// ── DriverScheduleOverride offline-first cache (owner directive Oct 25 2026) ──
// BOOT MUST NOT BURN entity_list READS: the dashboard stats panel reads the
// booked-off overrides on EVERY mount, straight from the server — during the
// wizardworxx.com migration the owner stacked editor-preview boots and device
// boots on one account bucket (140 entity_list/min) and these boot reads were
// part of the 429 storm. Pattern now: IDB first (instant render) → ONE
// throttled background server refresh per budget → live updates via the
// entity WebSocket subscription, mirrored back into IDB.
import { offlineDB } from './offlineDatabase';

const BG_REFRESH_MIN_MS = 10 * 60 * 1000; // background revalidation budget
const BOOKED_OFF = '__booked_off__';

let lastRefreshedAt = 0;
let bgRefreshInflight = false;
const listeners = new Set();

const readFromIdb = async () => {
  try {
    const rows = await offlineDB.getAll(offlineDB.STORES.DRIVER_SCHEDULE_OVERRIDES);
    return (rows || []).filter((r) => r?.driver_id === BOOKED_OFF);
  } catch (_) { return []; }
};

/**
 * IDB-first fetch of the booked-off override rows. Returns whatever the IDB
 * mirror holds IMMEDIATELY (possibly []) and, when stale, starts ONE
 * background server refresh — its result is written through to IDB and
 * pushed to onBookedOffOverridesRefreshed listeners. Callers render the
 * returned rows instantly and let the listener update state when the fresh
 * rows land.
 */
export async function fetchBookedOffOverridesCached({ force = false } = {}) {
  const cachedRows = await readFromIdb();
  const needsRefresh = force || !cachedRows.length || (Date.now() - lastRefreshedAt > BG_REFRESH_MIN_MS);
  if (needsRefresh && !bgRefreshInflight) {
    bgRefreshInflight = true;
    import('@/api/base44Client').then(async ({ base44 }) => {
      try {
        const rows = await base44.entities.DriverScheduleOverride.filter({ driver_id: BOOKED_OFF });
        lastRefreshedAt = Date.now();
        if (Array.isArray(rows) && rows.length) {
          await offlineDB.bulkSave(offlineDB.STORES.DRIVER_SCHEDULE_OVERRIDES, rows).catch(() => {});
        }
        listeners.forEach((cb) => { try { cb(rows || []); } catch (_) {} });
      } catch (_) {
        // rate limited / offline — IDB rows stay on screen; next mount retries
      } finally {
        bgRefreshInflight = false;
      }
    }).catch(() => { bgRefreshInflight = false; });
  }
  return cachedRows;
}

/** Subscribe to background-refresh results (fresh server rows landed). */
export function onBookedOffOverridesRefreshed(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Mirror a WS create/update event record into the IDB store (best effort). */
export async function mirrorScheduleOverrideEvent(rec) {
  try {
    if (!rec?.id) return;
    await offlineDB.save(offlineDB.STORES.DRIVER_SCHEDULE_OVERRIDES, rec);
  } catch (_) {}
}

/** Mirror a WS delete event into the IDB store (best effort). */
export async function mirrorScheduleOverrideDelete(id) {
  try {
    if (!id) return;
    await offlineDB.deleteRecord(offlineDB.STORES.DRIVER_SCHEDULE_OVERRIDES, id);
  } catch (_) {}
}
