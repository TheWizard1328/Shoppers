// ── DriverDailyActivity fetch cache (Sep 10, 2026) ───────────────────────────
// The dashboard stats hook (useLocalPerformanceStats) re-runs on EVERY WebSocket
// event — each driver GPS tick gives filteredDeliveries/appUsers a new array
// identity, re-running the effect. It used to re-fetch DriverDailyActivity from
// the server on every one of those runs: with 5-10 active drivers pinging GPS,
// owner/admin devices were firing 3+ unthrottled fetches per minute — a main
// amplifier of the Sep 9-10 per-user 429 rate-limit storms.
// Segments change rarely (duty toggles, breaks, route-finish auto-off-duty —
// all visible as driver_status changes, which callers use to invalidate), so a
// short TTL keeps the stats card fresh while cutting fetches by ~99%.
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();   // key: `${driverId}:${date}` -> { record, fetchedAt }
const inflight = new Map(); // key -> promise (dedups concurrent effect runs)

/**
 * Fetch a driver's DriverDailyActivity record for a date, from a module-level
 * TTL cache when fresh. Dedups concurrent callers. Failures are NOT cached and
 * re-throw so existing catch/fallback paths behave as before.
 */
export async function fetchDriverDailyActivityCached(driverId, activityDate, { force = false } = {}) {
  if (!driverId || !activityDate) return null;
  const key = `${driverId}:${activityDate}`;
  if (force) {
    // OWNER REPORT (Oct 28 2026): the IDB-first read below meant a device could
    // render a MONTHS-stale activity record forever (tablet showed 2h while the
    // server had 8h20 for the same driver). A forced call skips memory + IDB and
    // pulls the authoritative server record once, then writes through so every
    // later read is fresh.
    cache.delete(key);
  } else {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) return hit.record;
  }
  if (inflight.has(key)) return inflight.get(key);
  const req = (async () => {
    // IDB-FIRST (owner directive Oct 25 2026): boot must not burn entity_list
    // reads on the stats cards. Serve the IDB mirror instantly; the memory
    // TTL then revalidates against the server and the WS-driven invalidation
    // calls keep it fresh. Server fetches write through to IDB so every boot
    // after the first renders offline.
    if (!force) try {
      const { offlineDB } = await import('./offlineDatabase');
      const rows = await offlineDB.getAll(offlineDB.STORES.DRIVER_DAILY_ACTIVITY);
      const idbRecord = (rows || []).find(
        (r) => r?.driver_id === driverId && r?.activity_date === activityDate
      ) || null;
      if (idbRecord) {
        cache.set(key, { record: idbRecord, fetchedAt: Date.now() });
        return idbRecord;
      }
    } catch (_) { /* IDB degraded — fall through to the server path */ }
    try {
      const { base44 } = await import('@/api/base44Client');
      const recs = await base44.entities.DriverDailyActivity.filter({
        driver_id: driverId,
        activity_date: activityDate
      });
      const record = recs?.[0] || null;
      cache.set(key, { record, fetchedAt: Date.now() });
      // Write-through: the next boot renders this record straight from IDB
      if (record?.id) {
        try {
          const { offlineDB } = await import('./offlineDatabase');
          offlineDB.save(offlineDB.STORES.DRIVER_DAILY_ACTIVITY, record).catch(() => {});
        } catch (_) {}
      }
      return record;
    } catch (err) {
      cache.delete(key); // never cache failures
      throw err;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, req);
  return req;
}

/**
 * Drop cached entries. Omit both args to clear everything; pass driverId only
 * to clear all dates for that driver.
 */
export function invalidateDriverDailyActivityCache(driverId, activityDate) {
  if (driverId && activityDate) {
    cache.delete(`${driverId}:${activityDate}`);
  } else if (driverId) {
    for (const k of Array.from(cache.keys())) {
      if (k.startsWith(`${driverId}:`)) cache.delete(k);
    }
  } else {
    cache.clear();
  }
}
