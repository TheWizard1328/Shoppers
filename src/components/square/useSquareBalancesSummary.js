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

// Unlimited .filter({status}) calls silently truncate at the server's default
// page size — fine for a quiet system, but once active (pending/in_transit/
// en_route) deliveries exceed that default, the badge's COD-outstanding scan
// under-counts and the card total shows too HIGH, intermittently, exactly
// matching when the system is busiest (Oct 1 2026 "badge mis-loads" report).
// Every delivery-status scan below now pages fully, same pattern already used
// for the 2000-row history scans in this file.
async function filterAllDeliveries(status) {
  const out = [];
  let skip = 0;
  for (let page = 0; page < 20; page++) {
    // No .catch here — a failed status scan must throw so the caller can
    // RETRY instead of silently reporting zero outstanding CODs.
    const rows = await base44.entities.Delivery.filter({ status }, undefined, 500, skip);
    const list = rows || [];
    out.push(...list);
    if (list.length < 500) break;
    skip += 500;
  }
  return out;
}

async function loadConfig() {
  // No .catch here (Oct 2 2026 boot-race fix) — a failed AppSettings fetch
  // must THROW so the caller's retry-with-backoff runs, instead of silently
  // resolving to "no config" (empty badge) and caching that wrong empty
  // result for the full 60s TTL.
  const rows = await base44.entities.AppSettings.filter({ setting_key: SETTING_KEY });
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
// SINGLE shared COD-outstanding computation (Oct 2 2026). This is the ONE
// source of truth used by BOTH the sidebar badge and the Square Balances page
// (ported verbatim from the page's computeLocalOutstanding — the two had
// drifted into identical-looking but separately-maintained copies, and a
// swallowed fetch failure in the badge's copy silently zeroed the owner's
// CODs-out while the page's copy computed correctly, producing the
// "badge says 565, page says 546.96" mismatch).
// Unlike the old badge copy, fetch helpers here DO NOT swallow errors — a
// failed Store/SquareLocationConfig/Delivery/SquareLedgerEntry call THROWS,
// the caller retries once, and only a second failure degrades to null (which
// loadSummary flags as degraded and self-heals with a delayed forced reload).
export async function computeCodOutstandingDetailed(cfgArg) {
  const [storesRaw, cfgsRaw, codSalesRaw, patientsRaw] = await Promise.all([
    base44.entities.Store.list(),
    base44.entities.SquareLocationConfig.list(),
    base44.entities.SquareLedgerEntry.filter({ sale_class: 'cod_collection' }),
    base44.entities.Patient.list(),
  ]);
  const patientById = new Map();
  (patientsRaw || []).forEach((p) => { if (p?.id) patientById.set(String(p.id), p); if (p?.patient_id) patientById.set(String(p.patient_id), p); });
  const patientNameOf = (pid) => (pid ? (patientById.get(String(pid))?.full_name || null) : null);
  const cfgLoc = new Map();
  (cfgsRaw || []).forEach((c) => { if (c?.id && c?.square_location_id) cfgLoc.set(c.id, c.square_location_id); });
  const storeToLoc = new Map();
  (storesRaw || []).forEach((s) => {
    const loc = s?.square_location_config_id ? cfgLoc.get(s.square_location_config_id) : null;
    if (s?.id && loc) storeToLoc.set(String(s.id), loc);
  });
  const confirmed = new Set(
    (codSalesRaw || []).filter((e) => e?.delivery_id && String(e?.status || '').toUpperCase() === 'COMPLETED').map((e) => String(e.delivery_id))
  );
  const cfg = cfgArg;
  const tu = cfg?.trued_up_at ? new Date(cfg.trued_up_at) : null;
  const cutoffDate = (tu ? new Date(tu.getTime() - 6 * 3600000) : new Date(Date.now() - 6 * 3600000)).toISOString().slice(0, 10);
  const createdFloor = new Date(new Date(cutoffDate + 'T00:00:00Z').getTime() - 3 * 86400000).getTime();
  const isCounted = (d) => String(d?.delivery_date || '') >= cutoffDate;
  const centsOf = (n) => Math.round(Number(n || 0) * 100);
  const byLoc = new Map();
  const aggFor = (locId) => {
    if (!byLoc.has(locId)) byLoc.set(locId, { total: 0, pendingCount: 0, awaitingCount: 0, items: [] });
    return byLoc.get(locId);
  };

  for (const status of ['pending', 'in_transit', 'en_route']) {
    const rows = await filterAllDeliveries(status);
    for (const d of rows || []) {
      const required = Number(d?.cod_total_amount_required || 0);
      if (required <= 0 || !isCounted(d) || d?.cod_confirmed_collected) continue;
      const locId = storeToLoc.get(String(d?.store_id || ''));
      if (!locId) continue;
      const payments = Array.isArray(d?.cod_payments) ? d.cod_payments : [];
      const nonCash = payments.filter((p) => String(p?.type || '').toLowerCase() !== 'cash').reduce((s, p) => s + centsOf(p?.amount), 0);
      const outstanding = Math.max(0, centsOf(required) - nonCash);
      if (outstanding <= 0) continue;
      const agg = aggFor(locId);
      agg.total += outstanding; agg.pendingCount += 1;
      agg.items.push({ delivery_id: d.id, status, amount: outstanding / 100, reason: 'pending_or_in_transit', date: String(d.delivery_date || '').slice(0, 10), patient: patientNameOf(d.patient_id), store_id: d.store_id });
    }
  }

  for (let page = 0; page < 4; page++) {
    const list = await base44.entities.Delivery.list('-created_date', 2000, page * 2000);
    for (const d of list || []) {
      if (d?.status !== 'completed' || d?.cod_confirmed_collected || !isCounted(d)) continue;
      const payments = Array.isArray(d?.cod_payments) ? d.cod_payments : [];
      const cash = payments.filter((p) => String(p?.type || '').toLowerCase() === 'cash').reduce((s, p) => s + centsOf(p?.amount), 0);
      if (cash <= 0 || confirmed.has(String(d.id))) continue;
      const locId = storeToLoc.get(String(d?.store_id || ''));
      if (!locId) continue;
      const agg = aggFor(locId);
      agg.total += cash; agg.awaitingCount += 1;
      agg.items.push({ delivery_id: d.id, status: 'completed', amount: cash / 100, reason: 'cash_awaiting_square', date: String(d.delivery_date || '').slice(0, 10), patient: patientNameOf(d.patient_id), store_id: d.store_id });
    }
    if (list.length < 2000) break;
    if (list.length && new Date(list[list.length - 1]?.created_date || 0).getTime() < createdFloor) break;
  }

  const out = {};
  for (const [locId, agg] of byLoc) {
    out[locId] = { location_id: locId, total: agg.total / 100, pending_count: agg.pendingCount, awaiting_square_count: agg.awaitingCount, items: agg.items.slice(0, 50) };
  }
  return out;
}

// Totals-only view for the badge. Retries once on failure; returns null on a
// second failure so the caller can flag degradation (previously a single
// transient failure returned {} and the badge silently showed card balances
// with ZERO CODs outstanding — the exact Oct 2 owner mismatch).
async function computeCodOutstandingByLoc(cfg) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const detailed = await computeCodOutstandingDetailed(cfg);
      const out = {};
      for (const [locId, agg] of Object.entries(detailed || {})) out[locId] = agg.total;
      return out;
    } catch (e) {
      console.error(`[useSquareBalancesSummary] COD outstanding attempt ${attempt + 1} failed:`, e);
      if (attempt === 0) await new Promise((r) => setTimeout(r, 2000));
    }
  }
  return null;
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
      const rows = await filterAllDeliveries(status);
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

// A record/event touches a COD if it carries a COD amount, payments or a
// collection flag, a cod_* field was edited, or (for deletes, where we may not
// have the record) we conservatively allow it through.
function recordHasCod(d) {
  return !!d && (Number(d.cod_total_amount_required) > 0
    || (Array.isArray(d.cod_payments) && d.cod_payments.length > 0)
    || !!d.cod_confirmed_collected);
}
function isCodRelevantEvent(ev) {
  if (!ev) return false;
  const changed = ev.changedFields || ev.changed_fields || [];
  if (changed.some((f) => String(f).startsWith('cod_'))) return true;
  if (ev.type === 'delete') return ev.data ? recordHasCod(ev.data) : true;
  return recordHasCod(ev.data);
}

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
    return { cached: true, data: summaryCache.data, degraded: false };
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
    const [codOutstandingRaw, weekly, dailyRemaining] = await Promise.all([
      config ? computeCodOutstandingByLoc(config) : Promise.resolve({}),
      computeWeeklyCached(),
      computeDailyCodRemainingByStore(),
    ]);
    // null = both attempts failed (e.g. transient entity rate limit). Cache the
    // degraded result so the badge still shows something, but flag it so the
    // hook schedules a self-heal forced reload.
    const degraded = codOutstandingRaw === null;
    const codOutstanding = degraded ? {} : codOutstandingRaw;
    const data = {
      byLocId: config ? computeByLocId({ config, sales, codOutstanding, weeklyAvgByLoc: weeklyAvgByLocFromStores(stl, weekly) }) : new Map(),
      storeToLoc: stl,
      weeklyByStore: weekly,
      storeNames: names,
      dailyRemainingByStore: dailyRemaining,
    };
    summaryCache.at = Date.now();
    summaryCache.data = data;
    return { cached: false, data, degraded };
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

  const healTimerRef = useRef(null);
  // RETRY (Oct 2 2026): loadSummary()/loadConfig() can throw outright (not
  // just return a degraded result) — e.g. during the boot-loader race where
  // this hook's mount effect fires before the SDK's auth token is actually
  // attached, so the very first Store/SquareLocationConfig/etc. list() calls
  // reject. Previously that throw propagated out of this async function with
  // nothing catching it (an unhandled rejection) — `ready` never became true
  // and, since updates are event-driven only, the badge/page stayed stuck
  // showing nothing until a manual full reload. Now a hard failure retries
  // with backoff (2s, 4s, 8s) same as the softer "degraded" self-heal below.
  const reload = useCallback(async (force = false, attempt = 0) => {
    const seq = ++reloadSeq.current;
    let data, degraded;
    try {
      ({ data, degraded } = await loadSummary(force));
    } catch (e) {
      console.warn(`[useSquareBalancesSummary] reload attempt ${attempt + 1} failed:`, e?.message || e);
      if (seq !== reloadSeq.current) return;
      if (attempt < 3) {
        setTimeout(() => reload(true, attempt + 1), 2000 * Math.pow(2, attempt));
      }
      return;
    }
    if (seq !== reloadSeq.current) return;
    apply(data);
    // A degraded run (COD-outstanding fetch failed twice) freezes the badge
    // with wrong totals because updates are event-driven — nothing else will
    // fix it. Schedule ONE 30s forced reload to self-heal.
    if (degraded) {
      if (healTimerRef.current) clearTimeout(healTimerRef.current);
      healTimerRef.current = setTimeout(() => { healTimerRef.current = null; reload(true); }, 30000);
    }
  }, [apply]);

  // ── Event-driven ONLY updates (owner spec, Oct 1 2026) ────────────────────
  // The badge refreshes ONLY when a user changes a COD delivery (create/edit/
  // delete/collect/status) or performs a True-Up. No periodic re-checking, no
  // timers, no refresh on non-COD activity (GPS, route ops, plain deliveries).
  useEffect(() => {
    if (!enabled) return undefined;
    // DEFERRED INITIAL LOAD (Oct 2 2026, owner request): previously the first
    // reload() fired immediately on mount — right when the boot loader clears
    // and the app's first big entity-read wave (deliveries, patients, stores,
    // IDB hydration) is saturating the SDK. The badge's config/store/delivery
    // fetches joined that storm and lost on cold starts, leaving totals blank.
    // Now the first load waits 4s for the boot wave to pass; retries with
    // backoff (in reload) and the event subscriptions below cover everything
    // after. COD/True-Up events can still trigger an earlier load via the
    // debounced timers — that is correct behavior, not a boot-race problem.
    const bootDelay = setTimeout(() => reload(), 4000);
    const unsubs = [];
    let cfgTimer = null, codTimer = null;
    // True-Up writes AppSettings — the one non-delivery event that directly
    // changes the card starting balances, so it refreshes the badge too.
    try {
      unsubs.push(base44.entities.AppSettings.subscribe((ev) => {
        if (ev?.data?.setting_key !== SETTING_KEY) return;
        clearTimeout(cfgTimer);
        cfgTimer = setTimeout(() => reload(true), 2500);
      }));
    } catch {}
    const scheduleCodReload = () => {
      clearTimeout(codTimer);
      codTimer = setTimeout(() => reload(true), 2500);
    };
    // Remote WS delivery events — refresh only when the changed record is
    // COD-relevant (has a COD amount/payments/confirmation, a cod_* field was
    // just edited, or a record with a COD was deleted).
    try {
      unsubs.push(base44.entities.Delivery.subscribe((ev) => {
        if (!isCodRelevantEvent(ev)) return;
        scheduleCodReload();
      }));
    } catch {}
    // Same-device user actions — WS echoes are suppressed after local writes,
    // so the app's own window event is the local signal. When the event
    // carries the changed records, filter by COD relevance; when it doesn't,
    // trigger conservatively (these only fire on explicit user actions).
    const onDeliveriesUpdated = (e) => {
      const records = e?.detail?.freshDeliveries;
      if (Array.isArray(records) && records.length && !records.some(isCodRelevantEvent)) return;
      scheduleCodReload();
    };
    window.addEventListener('deliveriesUpdated', onDeliveriesUpdated);
    return () => {
      clearTimeout(bootDelay); clearTimeout(cfgTimer); clearTimeout(codTimer);
      unsubs.forEach((u) => { try { u?.(); } catch {} });
      window.removeEventListener('deliveriesUpdated', onDeliveriesUpdated);
    };
  }, [enabled, reload]);

  return { ready, byLocId, storeToLoc, weeklyByStore, storeNames, dailyRemainingByStore };
}
