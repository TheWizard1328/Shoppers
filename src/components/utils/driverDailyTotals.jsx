// ── Driver daily stop totals for the End-of-Day "Best Day" panel ─────────────
// Owner report (Oct 28 2026): the panel "always makes today the best day
// because it's the only daily total it has stored". The dialog was handed the
// CURRENT day's deliveries only, so the year-to-date comparison had a single
// entry in it.
//
// This module supplies the real history: per-date patient-stop counts for the
// driver's calendar year, from the getDriverDailyTotals backend function (which
// caches its aggregation in the DriverDailyTotals entity). Responses are kept in
// a module memo + localStorage so opening the dialog repeatedly costs nothing,
// and the whole thing degrades silently to the local deliveries the caller
// already has if the network or the function is unavailable.

const MEM_TTL_MS = 60 * 60 * 1000; // re-read at most hourly per session/device
const LS_PREFIX = 'rxdeliver_driver_daily_totals_v1_';
const memo = new Map(); // `${driverId}:${year}` -> { days, bestDate, bestStops, fetchedAt, source }
const inflight = new Map();

const lsKey = (driverId, year) => `${LS_PREFIX}${driverId}:${year}`;

const readLocal = (driverId, year) => {
  try {
    const raw = localStorage.getItem(lsKey(driverId, year));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.days)) return null;
    return parsed;
  } catch (_) { return null; }
};

const writeLocal = (driverId, year, payload) => {
  try { localStorage.setItem(lsKey(driverId, year), JSON.stringify(payload)); } catch (_) {}
};

/** Build daily totals from whatever deliveries the caller already has locally. */
export const buildTotalsFromDeliveries = (deliveries, year, driverId) => {
  const yearStr = String(year);
  const counts = new Map();
  (deliveries || []).forEach((d) => {
    if (!d || !d.delivery_date || !String(d.delivery_date).startsWith(yearStr)) return;
    if (!d.patient_id) return; // patient stops only — matches the Total Stops card
    if (driverId && d.driver_id !== driverId) return;
    counts.set(d.delivery_date, (counts.get(d.delivery_date) || 0) + 1);
  });
  return Array.from(counts.entries())
    .map(([date, stops]) => ({ date, stops }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
};

/**
 * Daily stop totals for a driver + year.
 * @returns {Promise<{days: Array<{date: string, stops: number}>, bestDate: string|null, bestStops: number, source: string}>}
 */
export async function getDriverDailyTotals({ driverId, year, localDeliveries = [], forceRefresh = false } = {}) {
  const y = Number(year) || new Date().getFullYear();
  if (!driverId) {
    return { days: buildTotalsFromDeliveries(localDeliveries, y, null), bestDate: null, bestStops: 0, source: 'local_no_driver' };
  }
  const key = `${driverId}:${y}`;

  if (!forceRefresh) {
    const hit = memo.get(key);
    if (hit && Date.now() - hit.fetchedAt < MEM_TTL_MS) return hit;
    const local = readLocal(driverId, y);
    if (local?.days?.length && Date.now() - (local.fetchedAt || 0) < MEM_TTL_MS) {
      memo.set(key, local);
      return local;
    }
  }

  if (inflight.has(key)) return inflight.get(key);

  const req = (async () => {
    try {
      const { base44 } = await import('@/api/base44Client');
      const res = await base44.functions.invoke('getDriverDailyTotals', { driverId, year: y, forceRefresh });
      const data = res?.data || res;
      if (Array.isArray(data?.days)) {
        let bestDate = data.bestDate || null;
        let bestStops = Number(data.bestStops) || 0;
        if (!bestDate) {
          for (const d of data.days) if (d.stops > bestStops) { bestStops = d.stops; bestDate = d.date; }
        }
        const payload = { days: data.days, bestDate, bestStops, fetchedAt: Date.now(), source: data.fromCache ? 'server_cache' : 'server' };
        memo.set(key, payload);
        writeLocal(driverId, y, payload);
        return payload;
      }
      throw new Error('unexpected payload');
    } catch (err) {
      // Fall back to local history (IDB-visible deliveries) — never leave the
      // panel without a comparison, and never invalidate the dialog.
      console.warn('[driverDailyTotals] history fetch failed, using local deliveries:', err?.message || err);
      const days = buildTotalsFromDeliveries(localDeliveries, y, driverId);
      let bestDate = null; let bestStops = 0;
      for (const d of days) if (d.stops > bestStops) { bestStops = d.stops; bestDate = d.date; }
      const payload = { days, bestDate, bestStops, fetchedAt: Date.now(), source: 'local' };
      memo.set(key, payload);
      return payload;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, req);
  return req;
}


/**
 * Best day of the year from [{date, stops}].
 * A "new record" means the delivery date STRICTLY beat every other day — the
 * old dialog used total >= best.stops against a map containing only today, so
 * every finished route was announced as a record.
 */
export const computeBestDay = ({ days = [], deliveryDate = null } = {}) => {
  let bestDate = null;
  let bestStops = 0;
  let priorBestStops = 0;
  for (const d of days) {
    if (!d?.date) continue;
    const stops = Number(d.stops) || 0;
    if (stops > bestStops) { bestStops = stops; bestDate = d.date; }
    if (deliveryDate && d.date === deliveryDate) continue;
    if (stops > priorBestStops) priorBestStops = stops;
  }
  const isNewRecord = !!bestDate && bestDate === deliveryDate && bestStops > priorBestStops;
  return { bestDate, bestStops, priorBestStops, isNewRecord };
};

export const invalidateDriverDailyTotals = (driverId, year) => {
  if (driverId) memo.delete(`${driverId}:${Number(year) || new Date().getFullYear()}`);
  else memo.clear();
};
