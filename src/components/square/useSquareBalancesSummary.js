import { useCallback, useEffect, useRef, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { edmontonWallString } from '@/components/utils/albertaTime';

/**
 * useSquareBalancesSummary — lightweight per-card balance estimates for the
 * sidebar badge (and any non-owner surface). Mirrors the math in
 * SquareBalancesView (card_start + sales − fee − folder 2% − loan% − CODs out)
 * but fetches only what a badge needs. Subscribes to the same live sources so
 * the badge tracks the page: AppSettings (true-up), SquareLedgerEntry (sales)
 * and Delivery (CODs out), all debounced.
 */

const SETTING_KEY = 'square_balances';

async function loadConfig() {
  const rows = await base44.entities.AppSettings.filter({ setting_key: SETTING_KEY }).catch(() => []);
  const rec = (rows || [])[0];
  return rec?.setting_value?.locations?.length ? rec.setting_value : null;
}

async function loadCardSales(cfg) {
  if (!cfg?.trued_up_at) return [];
  const out = [];
  let skip = 0;
  for (let page = 0; page < 40; page++) {
    const rows = await base44.entities.SquareLedgerEntry.filter(
      { entry_kind: 'sale', tender_type: 'CARD', status: 'COMPLETED', occurred_at: { $gte: cfg.trued_up_at } },
      undefined, 500, skip
    ).catch(() => []);
    const list = rows || [];
    out.push(...list);
    if (list.length < 500) break;
    skip += 500;
  }
  return out;
}

export async function buildStoreNameMap() {
  const rows = await base44.entities.Store.list().catch(() => []);
  const m = new Map();
  (rows || []).forEach((s) => { if (s?.id) m.set(String(s.id), s?.name || String(s.id)); });
  return m;
}

export async function buildStoreToLocMap() {
  const [storesRaw, cfgsRaw] = await Promise.all([
    base44.entities.Store.list().catch(() => []),
    base44.entities.SquareLocationConfig.list().catch(() => []),
  ]);
  const cfgLoc = new Map();
  (cfgsRaw || []).forEach((c) => { if (c?.id && c?.square_location_id) cfgLoc.set(c.id, c.square_location_id); });
  const storeToLoc = new Map();
  (storesRaw || []).forEach((s) => {
    const loc = s?.square_location_config_id ? cfgLoc.get(s.square_location_config_id) : null;
    if (s?.id && loc) storeToLoc.set(String(s.id), loc);
  });
  return storeToLoc;
}

// Same COD-outstanding rules as SquareBalancesView: pending/in-transit CODs minus
// non-cash payments, plus completed cash CODs not yet rung at Square.
async function computeCodOutstandingByLoc(cfg, storeToLoc) {
  try {
    const codSalesRaw = await base44.entities.SquareLedgerEntry.filter({ sale_class: 'cod_collection' }).catch(() => []);
    const confirmed = new Set(
      (codSalesRaw || []).filter((e) => e?.delivery_id && String(e?.status || '').toUpperCase() === 'COMPLETED').map((e) => String(e.delivery_id))
    );
    const tu = cfg?.trued_up_at ? new Date(cfg.trued_up_at) : null;
    const cutoffDate = (tu ? new Date(tu.getTime() - 6 * 3600000) : new Date(Date.now() - 6 * 3600000)).toISOString().slice(0, 10);
    const isCounted = (d) => String(d?.delivery_date || '') >= cutoffDate;
    const centsOf = (n) => Math.round(Number(n || 0) * 100);
    const byLoc = new Map();

    for (const status of ['pending', 'in_transit', 'en_route']) {
      const rows = await base44.entities.Delivery.filter({ status }).catch(() => []);
      for (const d of rows || []) {
        const required = Number(d?.cod_total_amount_required || 0);
        if (required <= 0 || !isCounted(d) || d?.cod_confirmed_collected) continue;
        const locId = storeToLoc.get(String(d?.store_id || ''));
        if (!locId) continue;
        const payments = Array.isArray(d?.cod_payments) ? d.cod_payments : [];
        const nonCash = payments.filter((p) => String(p?.type || '').toLowerCase() !== 'cash').reduce((s, p) => s + centsOf(p?.amount), 0);
        const outstanding = Math.max(0, centsOf(required) - nonCash);
        if (outstanding <= 0) continue;
        byLoc.set(locId, (byLoc.get(locId) || 0) + outstanding);
      }
    }

    for (let page = 0; page < 4; page++) {
      const rows = await base44.entities.Delivery.list('-created_date', 2000, page * 2000).catch(() => []);
      const list = rows || [];
      for (const d of list) {
        if (d?.status !== 'completed' || d?.cod_confirmed_collected || !isCounted(d)) continue;
        const payments = Array.isArray(d?.cod_payments) ? d.cod_payments : [];
        const cash = payments.filter((p) => String(p?.type || '').toLowerCase() === 'cash').reduce((s, p) => s + centsOf(p?.amount), 0);
        if (cash <= 0 || confirmed.has(String(d.id))) continue;
        const locId = storeToLoc.get(String(d?.store_id || ''));
        if (!locId) continue;
        byLoc.set(locId, (byLoc.get(locId) || 0) + cash);
      }
      if (list.length < 2000) break;
      const createdFloor = new Date(new Date(cutoffDate + 'T00:00:00Z').getTime() - 3 * 86400000).getTime();
      if (list.length && new Date(list[list.length - 1]?.created_date || 0).getTime() < createdFloor) break;
    }

    const out = {};
    for (const [locId, cents] of byLoc) out[locId] = cents / 100;
    return out;
  } catch (e) {
    console.error('[useSquareBalancesSummary] COD outstanding failed:', e);
    return {};
  }
}

/**
 * Required-COD totals per STORE over the last 7 days EXCLUDING today
 * (non-cancelled deliveries, cod_total_amount_required > 0). The 7-day window
 * gives a stable "typical day" figure — today is excluded so the average is
 * never skewed by a day that hasn't finished yet.
 * Returns Map(storeId → total $ over the window).
 */
export async function computeWeeklyCodTotalsByStore() {
  try {
    const today = edmontonWallString(new Date()).slice(0, 10);
    const from = new Date(new Date(today + 'T00:00:00Z').getTime() - 7 * 86400000).toISOString().slice(0, 10);
    const createdFloor = new Date(new Date(today + 'T00:00:00Z').getTime() - 10 * 86400000).getTime();
    const byStore = new Map();
    for (let page = 0; page < 6; page++) {
      const rows = await base44.entities.Delivery.list('-created_date', 2000, page * 2000).catch(() => []);
      const list = rows || [];
      for (const d of list) {
        const dd = String(d?.delivery_date || '');
        if (dd < from || dd >= today) continue;
        if (d?.status === 'cancelled') continue;
        const required = Number(d?.cod_total_amount_required || 0);
        if (required <= 0 || !d?.store_id) continue;
        byStore.set(String(d.store_id), (byStore.get(String(d.store_id)) || 0) + required);
      }
      if (list.length < 2000) break;
      if (list.length && new Date(list[list.length - 1]?.created_date || 0).getTime() < createdFloor) break;
    }
    return byStore;
  } catch (e) {
    console.error('[useSquareBalancesSummary] weekly COD totals failed:', e);
    return new Map();
  }
}

// Today's remaining CODs per STORE: count + total still to collect (pending/
// in-transit/en-route dated today, minus non-cash payments, not confirmed collected).
export async function computeDailyCodRemainingByStore() {
  try {
    const today = edmontonWallString(new Date()).slice(0, 10);
    const centsOf = (n) => Math.round(Number(n || 0) * 100);
    const byStore = new Map();
    for (const status of ['pending', 'in_transit', 'en_route']) {
      const rows = await base44.entities.Delivery.filter({ status }).catch(() => []);
      for (const d of rows || []) {
        if (String(d?.delivery_date || '') !== today) continue;
        const required = Number(d?.cod_total_amount_required || 0);
        if (required <= 0 || d?.cod_confirmed_collected) continue;
        const payments = Array.isArray(d?.cod_payments) ? d.cod_payments : [];
        const nonCash = payments.filter((p) => String(p?.type || '').toLowerCase() !== 'cash').reduce((s, p) => s + centsOf(p?.amount), 0);
        const out = Math.max(0, centsOf(required) - nonCash);
        if (out <= 0) continue;
        const key = String(d?.store_id || '');
        const rec = byStore.get(key) || { count: 0, total: 0 };
        rec.count += 1;
        rec.total += out / 100;
        byStore.set(key, rec);
      }
    }
    return byStore;
  } catch (e) {
    console.error('[useSquareBalancesSummary] daily remaining failed:', e);
    return new Map();
  }
}

export const COD_WINDOW_DAYS = 7;

/** Roll store totals up to per-location daily averages: Σ(store totals on card) / 7. */
export function weeklyAvgByLocFromStores(storeToLoc, weeklyByStore) {
  const totals = new Map();
  for (const [storeId, locId] of storeToLoc.entries()) {
    const t = Number(weeklyByStore?.get(String(storeId)) || 0);
    if (!t) continue;
    totals.set(locId, (totals.get(locId) || 0) + t);
  }
  const avg = {};
  for (const [locId, t] of totals.entries()) avg[locId] = t / COD_WINDOW_DAYS;
  return avg;
}

// Color level: green when the balance is more than $20 ABOVE the 7-day average
// daily CODs to collect, red when more than $20 BELOW, yellow inside the ±$20 band.
export const BALANCE_BAND = 20;
export function getBalanceLevel(balance, codAvg) {
  const diff = (Number(balance) || 0) - (Number(codAvg) || 0);
  if (diff > BALANCE_BAND) return 'green';
  if (diff >= -BALANCE_BAND) return 'yellow';
  return 'red';
}
export const BALANCE_LEVELS = {
  green: { border: '#10b981', tint: 'rgba(16, 185, 129, 0.07)', chipBg: '#d1fae5', chipText: '#065f46' },
  yellow: { border: '#f59e0b', tint: 'rgba(245, 158, 11, 0.08)', chipBg: '#fef3c7', chipText: '#92400e' },
  red: { border: '#ef4444', tint: 'rgba(239, 68, 68, 0.07)', chipBg: '#fee2e2', chipText: '#991b1b' },
};

function computeByLocId({ config, sales, codOutstanding, weeklyAvgByLoc }) {
  const folderRate = Number(config.folder_rate ?? 0.02);
  const byLocId = new Map();
  for (const loc of (config.locations || [])) {
    let credits = 0, loan = 0;
    for (const s of sales) {
      if (s.location_id !== loc.location_id) continue;
      const amount = Number(s.amount_cents || 0) / 100;
      const fee = Number(s.fee_cents || 0) / 100;
      loan += amount * Number(loc.loan_rate || 0);
      credits += amount - fee - amount * Number(loc.loan_rate || 0) - amount * folderRate;
    }
    const codOut = Number(codOutstanding?.[loc.location_id] || 0);
    const cardEstimate = Math.round((Number(loc.card_start || 0) + credits - codOut) * 100) / 100;
    const codAvg = Math.round(Number(weeklyAvgByLoc?.[loc.location_id] || 0) * 100) / 100;
    byLocId.set(loc.location_id, {
      name: loc.name || loc.location_id,
      cardEstimate,
      loanRemaining: Math.round(Math.max(0, Number(loc.loan_start || 0) - loan) * 100) / 100,
      codAvg,
      level: getBalanceLevel(cardEstimate, codAvg),
    });
  }
  return byLocId;
}

// ── Performance guards ─────────────────────────────────────────────────────
// The sidebar mounts this hook on EVERY page (dashboard included), and one
// full reload lists up to ~20k Delivery rows. During active driving the
// Delivery WS stream fires constantly, which re-triggered the full fetch
// every 15-20s and froze card swipes (owner report, Oct 1 2026).
//  - SUMMARY_CACHE_TTL: a cached full result satisfies any non-forced reload
//    (mounts + delivery-driven refreshes). Money events (true-up, Square
//    ledger) bypass the cache with force=true.
//  - WEEKLY_CACHE_TTL: the 7-day average only changes once a day — cache it
//    for 10 minutes so the heaviest scan (6 pages × 2000 rows) stops
//    re-running on every refresh.
const SUMMARY_CACHE_TTL = 60_000;
const WEEKLY_CACHE_TTL = 10 * 60_000;
const summaryCache = { at: 0, data: null };
const weeklyCache = { at: 0, value: null };
let inflight = null;

async function computeWeeklyCached() {
  if (weeklyCache.value && Date.now() - weeklyCache.at < WEEKLY_CACHE_TTL) return weeklyCache.value;
  const value = await computeWeeklyCodTotalsByStore();
  weeklyCache.at = Date.now();
  weeklyCache.value = value;
  return value;
}

async function loadSummary(force) {
  const now = Date.now();
  if (!force && summaryCache.data && now - summaryCache.at < SUMMARY_CACHE_TTL) {
    return { cached: true, data: summaryCache.data };
  }
  // Coalesce concurrent requests (mount + a WS debounce firing together)
  if (inflight) return inflight;
  inflight = (async () => {
    const config = await loadConfig();
    const [sales, stl, names] = await Promise.all([
      config ? loadCardSales(config).catch(() => []) : Promise.resolve([]),
      buildStoreToLocMap().catch(() => new Map()),
      buildStoreNameMap().catch(() => new Map()),
    ]);
    const [codOutstanding, weekly, dailyRemaining] = await Promise.all([
      config ? computeCodOutstandingByLoc(config, stl) : Promise.resolve({}),
      computeWeeklyCached(),
      computeDailyCodRemainingByStore(),
    ]);
    const data = {
      byLocId: config ? computeByLocId({ config, sales, codOutstanding, weeklyAvgByLoc: weeklyAvgByLocFromStores(stl, weekly) }) : new Map(),
      storeToLoc: stl,
      weeklyByStore: weekly,
      storeNames: names,
      dailyRemainingByStore: dailyRemaining,
    };
    summaryCache.at = Date.now();
    summaryCache.data = data;
    return { cached: false, data };
  })().finally(() => { inflight = null; });
  return inflight;
}

export function useSquareBalancesSummary(enabled = true) {
  const [ready, setReady] = useState(false);
  const [byLocId, setByLocId] = useState(new Map());
  const [storeToLoc, setStoreToLoc] = useState(new Map());
  const [weeklyByStore, setWeeklyByStore] = useState(new Map());
  const [storeNames, setStoreNames] = useState(new Map());
  const [dailyRemainingByStore, setDailyRemainingByStore] = useState(new Map());
  const reloadSeq = useRef(0);

  const apply = useCallback((data) => {
    setByLocId(data.byLocId);
    setStoreToLoc(data.storeToLoc);
    setWeeklyByStore(data.weeklyByStore);
    setStoreNames(data.storeNames);
    setDailyRemainingByStore(data.dailyRemainingByStore);
    setReady(true);
  }, []);

  const reload = useCallback(async (force = false) => {
    const seq = ++reloadSeq.current;
    const { data } = await loadSummary(force);
    if (seq !== reloadSeq.current) return;
    apply(data);
  }, [apply]);

  useEffect(() => {
    if (!enabled) return undefined;
    reload();
    const unsubs = [];
    let cfgTimer = null, ledgerTimer = null, deliveryTimer = null;
    // Money events force past the cache (badge must move on true-up / Square sale).
    try {
      unsubs.push(base44.entities.AppSettings.subscribe(() => { clearTimeout(cfgTimer); cfgTimer = setTimeout(() => reload(true), 2500); }));
    } catch {}
    try {
      unsubs.push(base44.entities.SquareLedgerEntry.subscribe(() => { clearTimeout(ledgerTimer); ledgerTimer = setTimeout(() => reload(true), 6000); }));
    } catch {}
    // Delivery churn during driving hits the 60s cache — cheap no-ops instead
    // of 20k-row rescans every 15-20s.
    try {
      unsubs.push(base44.entities.Delivery.subscribe(() => { clearTimeout(deliveryTimer); deliveryTimer = setTimeout(() => reload(false), 30000); }));
    } catch {}
    const onDeliveriesUpdated = () => { clearTimeout(deliveryTimer); deliveryTimer = setTimeout(() => reload(false), 30000); };
    window.addEventListener('deliveriesUpdated', onDeliveriesUpdated);
    return () => {
      clearTimeout(cfgTimer); clearTimeout(ledgerTimer); clearTimeout(deliveryTimer);
      unsubs.forEach((u) => { try { u?.(); } catch {} });
      window.removeEventListener('deliveriesUpdated', onDeliveriesUpdated);
    };
  }, [enabled, reload]);

  return { ready, byLocId, storeToLoc, weeklyByStore, storeNames, dailyRemainingByStore };
}
