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
export async function fetchDriverDailyActivityCached(driverId, activityDate) {
  if (!driverId || !activityDate) return null;
  const key = `${driverId}:${activityDate}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) return hit.record;
  if (inflight.has(key)) return inflight.get(key);
  const req = (async () => {
    try {
      const { base44 } = await import('@/api/base44Client');
      const recs = await base44.entities.DriverDailyActivity.filter({
        driver_id: driverId,
        activity_date: activityDate
      });
      const record = recs?.[0] || null;
      cache.set(key, { record, fetchedAt: Date.now() });
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
