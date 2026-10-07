import { useCallback, useEffect, useRef, useState } from 'react';
import { getAppSettingRows } from '@/components/utils/appSettingsCache';
import { base44 } from '@/api/base44Client';
import { edmontonWallString } from '@/components/utils/albertaTime';
import { saveSummarySnapshot, getSummarySnapshot, deserializeSummary, saveLedgerWindows, getLedgerWindows } from '@/components/square/squareBalancesOfflineManager';
import { offlineDB } from '@/components/utils/offlineDatabase';

/**
 * useSquareBalancesSummary — lightweight per-card balance estimates for the
 * sidebar badge (and any non-owner surface). Mirrors the math in
 * SquareBalancesView (card_start + sales − fee − folder 2% − loan% − CODs out)
 * but fetches only what a badge needs. Subscribes to the same live sources so
 * the badge tracks the page: AppSettings (true-up), SquareLedgerEntry (sales)
 * and Delivery (CODs out), all debounced.
 */

const SETTING_KEY = 'square_balances';
// Same key the SquareBalancesView toggle writes (Oct 6 2026): entries with
// notTappedAt are "Not Tapped" overrides — their COD never deducts from the card.
const SPEND_MARKS_KEY = 'square_card_spend_marks';

// ── IDB-FIRST READS (owner report, Oct 2 2026: boot rate-limit storm) ────────
// One badge reload used to fire ~25 entity API calls (3 full status scans,
// 4-page + 6-page Delivery.list sweeps, Store/SquareLocationConfig/Patient
// lists ×2, ledger scans). Every COD-relevant WS delivery event forced a full
// reload, and each 429 retry repeated the whole volley — the badge itself was
// a major contributor to the boot rate-limit storm. The app's own realtime
// sync already keeps DELIVERIES / STORES / SQUARE_LOCATION_CONFIGS / PATIENTS
// fresh in IDB (same user-scoped view the API would return), so all delivery
// math now reads IDB instead. Remaining per-reload API calls: config + the
// three Square ledger scans (ledger rows only change via squareLedgerSync).
// TTLs: deliveries 60s (coalesces with the summary cache), reference data 5min.
const IDB_DELIVERIES_TTL = 60_000;
const IDB_REF_TTL = 5 * 60_000;
const idbReadCaches = {
  deliveries: { at: 0, rows: null },
  stores: { at: 0, rows: null },
  locCfgs: { at: 0, rows: null },
  patients: { at: 0, rows: null },
};
const IDB_FRESH_INSTALL_MIN_ROWS = 20;

async function readIdbRows(storeName, cacheKey, ttlMs) {
  const c = idbReadCaches[cacheKey];
  if (c.rows && Date.now() - c.at < ttlMs) return c.rows;
  // No .catch — a failed IDB read must throw so the caller retries (with
  // backoff at the reload level), NOT silently report empty data.
  const rows = await offlineDB.getAll(storeName);
  c.at = Date.now();
  c.rows = rows || [];
  return c.rows;
}

// Deliveries straight from the local mirror the app sync maintains. Returns
// ALL statuses — callers filter client-side. If the local DB clearly hasn't
// been bootstrapped yet (fresh install / pre-sync), fall back to the API so
// the badge is still correct on first runs.
async function getAllDeliveriesIdb() {
  // API fallback backfills fresh installs (no synced data yet) — one volley
  // per cold start; warmed IDB makes every later reload IDB-only.
  const apiFetch = async () => {
    const all = [];
    for (const status of ['pending', 'in_transit', 'en_route', 'completed']) {
      all.push(...await filterAllDeliveries(status));
    }
    return all;
  };
  return idbOrApi(offlineDB.STORES.DELIVERIES, 'deliveries', IDB_DELIVERIES_TTL, apiFetch, IDB_FRESH_INSTALL_MIN_ROWS);
}

function deliveriesWithStatus(rows, status) {
  return (rows || []).filter((d) => d?.status === status);
}

// IDB-first read with an API fallback for fresh installs (IDB not yet
// bootstrapped) and read failures. The API result is cached too so a
// fresh-install badge converges to IDB-less operation until the app's
// own sync populates IDB.
async function idbOrApi(storeName, cacheKey, ttlMs, apiFetch, minRows = 1) {
  let rows = null;
  try {
    rows = await readIdbRows(storeName, cacheKey, ttlMs);
  } catch { rows = null; }
  if (rows && rows.length >= minRows) return rows;
  const apiRows = await apiFetch().catch(() => []);
  if ((apiRows || []).length > (rows?.length || 0)) {
    const c = idbReadCaches[cacheKey];
    c.at = Date.now(); c.rows = apiRows;
    return apiRows;
  }
  return rows || apiRows || [];
}

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
  const rows = await getAppSettingRows(SETTING_KEY);
  const rec = (rows || [])[0];
  return rec?.setting_value?.locations?.length ? rec.setting_value : null;
}

// ── Ledger windows cache (Oct 2 2026, "100% offline-first" owner request) ──
// The summary snapshot renders instantly, but every refresh still re-fetched
// the SAME SquareLedgerEntry windows from the entity API (5-8 calls per run),
// joining the boot rate-limit storm (owner report: red/orange heartbeat dots
// on every app open, 429 reload attempts in console). Ledger rows only change
// via squareLedgerSync, so the fetched windows are cached in IDB and served
// to every subsequent refresh — the badge computes entirely offline unless
// something actually changed money. Invalidation: true-up change
// (trued_up_at mismatch), a 10-minute TTL, or a SquareLedgerEntry WS
// broadcast (invalidateLedgerWindows).
const LEDGER_CACHE_TTL = 10 * 60_000;
const ledgerCache = { data: null, idbRead: false, invalidatedAt: 0 };
let ledgerSaveTimer = null;

async function freshLedgerWindows(cfg, userId) {
  if (!ledgerCache.data && !ledgerCache.idbRead) {
    ledgerCache.idbRead = true;
    const rec = await getLedgerWindows(userId).catch(() => null);
    if (rec?.saved_at) ledgerCache.data = rec;
  }
  const w = ledgerCache.data;
  if (!w?.saved_at) return null;
  if (cfg?.trued_up_at && w.trued_up_at !== cfg.trued_up_at) return null; // true-up moved
  if (ledgerCache.invalidatedAt && new Date(w.saved_at).getTime() < ledgerCache.invalidatedAt) return null;
  if (Date.now() - new Date(w.saved_at).getTime() > LEDGER_CACHE_TTL) return null;
  return w;
}

// FETCH-TRACKING FIX (Oct 6 2026, owner report: card balances way too high —
// Bonnie Doon showed $123.76 when card_start+real net credits only computes to
// ~$71.92). Root cause: ALL loaders (loadCardSales/loadCardPayouts/loadCardTopups)
// share ONE windows record and ONE `saved_at` freshness stamp. loadSales() in
// SquareBalancesView calls loadCardSales() FIRST — a cache miss fetches real
// sales from the API and writeLedgerCache() stamps a fresh saved_at. The VERY
// NEXT call, loadCardPayouts(), then calls freshLedgerWindows() — sees the
// record IS fresh (saved_at just set by the sales write) and returns
// `cached.payouts` — but payouts was NEVER actually fetched yet this session;
// it's still the empty-array default from ledgerCache's initial shape. So
// swept bank-sweeps silently serve as [] forever while credits (sales) are
// real — the card estimate adds real money in but never subtracts the
// matching sweep. Fix: track exactly which fields were populated by a REAL
// fetch (not the initial default) in `fetched`; each loader's cache check
// below now also requires `cached.fetched?.<key>` before trusting the cache
// for THAT field, so an unfetched field always falls through to a real fetch
// instead of silently returning stale/default data.
function writeLedgerCache(patch, userId) {
  const w = ledgerCache.data || { saved_at: null, trued_up_at: null, sales: [], payouts: [], topups: [], cod_sales: [], window_sales: [], window_since: null, evidence_sales: [], evidence_declines: [], evidence_since: null, fetched: {} };
  const fetchedPatch = {};
  for (const k of Object.keys(patch)) {
    if (k === 'trued_up_at' || k === 'window_since' || k === 'evidence_since') continue; // metadata, not a data field
    fetchedPatch[k] = true;
  }
  ledgerCache.data = { ...w, ...patch, fetched: { ...(w.fetched || {}), ...fetchedPatch }, saved_at: new Date().toISOString() };
  if (ledgerSaveTimer) clearTimeout(ledgerSaveTimer);
  // Single debounced flush — all loaders write the SAME IDB record.
  ledgerSaveTimer = setTimeout(() => {
    ledgerSaveTimer = null;
    const snap = { ...ledgerCache.data };
    saveLedgerWindows(snap, userId).catch?.(() => {});
  }, 1500);
}

/** A SquareLedgerEntry WS write arrived (page sync, manual ops) — refetch next time. */
export function invalidateLedgerWindows() {
  ledgerCache.invalidatedAt = Date.now();
  ledgerCache.data = null; // keep idbRead so the stale IDB copy is NOT re-served
}

// ═══════════════════════════════════════════════════════════════════════════
// Card fee sheet + net-collected math (owner spec Oct 7 2026: balances sync
// STRICTLY through delivery data). A FINISHED delivery's recorded cod_payments
// are the single authority for how much money came back onto the Square card:
//   Debit (Interac): amount − ($0.07 + 0.75%) − loan% − folder%
//   Credit:          amount − 2.5% − loan% − folder%
//   Cash / Cheque:    never touch the card (no net shown, no credit math)
// ═══════════════════════════════════════════════════════════════════════════
export const DEFAULT_FOLDER_RATE = 0.02;
export const CARD_FEE_SHEET = {
  debit: (amt) => 0.07 + amt * 0.0075,     // Interac
  interac: (amt) => 0.07 + amt * 0.0075,
  credit: (amt) => amt * 0.025,            // flat-rate credit swipe
};
export function estimateCardFee(amount, cardType) {
  const key = String(cardType || '').toLowerCase();
  const fn = CARD_FEE_SHEET[key] || CARD_FEE_SHEET.credit; // default to credit's flat rate when unknown
  return Math.max(0, fn(Number(amount) || 0));
}
export function computeNetCollected(grossAmount, { cardType = null, loanRate = 0, folderRate = DEFAULT_FOLDER_RATE } = {}) {
  const gross = Number(grossAmount) || 0;
  const fee = estimateCardFee(gross, cardType);
  const loan = gross * Number(loanRate || 0);
  const folder = gross * Number(folderRate ?? DEFAULT_FOLDER_RATE);
  return Math.max(0, gross - fee - loan - folder);
}

/**
 * loadDeliveryCardCredits — per-location card credits computed STRICTLY from
 * finished deliveries since true-up (owner spec Oct 7 2026). Every Debit /
 * Credit cod_payment on a completed, counted delivery brings money back onto
 * the Square card: gross − fee (rate sheet) − loan% − folder%. Cash and Cheque
 * payments never touch the card. Replaces the Square-ledger sale scan as the
 * credit side of the balance estimate — the ledger only ever held half the
 * collections (broken link chains, pending entries, unlinked manual rings).
 * Returns Map(location_id → { gross, fees, loan, folder, credits, count, lastAt }).
 */
export async function loadDeliveryCardCredits(cfgArg, userId = null) {
  void userId; // deliveries are fetched from the shared IDB mirror / API — no user scoping on reads
  const cfg = cfgArg;
  const folderRate = Number(cfg?.folder_rate ?? DEFAULT_FOLDER_RATE);
  const loanRateByLoc = new Map();
  (cfg?.locations || []).forEach((l) => { if (l?.location_id) loanRateByLoc.set(l.location_id, Number(l.loan_rate || 0)); });
  const tu = cfg?.trued_up_at ? new Date(cfg.trued_up_at) : null;
  const cutoffDate = (tu ? new Date(tu.getTime() - 6 * 3600000) : new Date(Date.now() - 6 * 3600000)).toISOString().slice(0, 10);
  const isCounted = (d) => String(d?.delivery_date || '') >= cutoffDate;
  const [cfgsRaw, allDeliveries] = await Promise.all([
    idbOrApi(offlineDB.STORES.SQUARE_LOCATION_CONFIGS, 'locCfgs', IDB_REF_TTL, () => base44.entities.SquareLocationConfig.list(), 1),
    getAllDeliveriesIdb(),
  ]);
  const cfgLoc = new Map();
  (cfgsRaw || []).forEach((c) => { if (c?.id && c?.square_location_id) cfgLoc.set(c.id, c.square_location_id); });
  // store→location map needs Stores too
  const storesRaw = await idbOrApi(offlineDB.STORES.STORES, 'stores', IDB_REF_TTL, () => base44.entities.Store.list(), 5);
  const storeToLoc = new Map();
  (storesRaw || []).forEach((st) => {
    const loc = st?.square_location_config_id ? cfgLoc.get(st.square_location_config_id) : null;
    if (st?.id && loc) storeToLoc.set(String(st.id), loc);
  });
  const byLoc = new Map();
  const aggFor = (locId) => {
    if (!byLoc.has(locId)) byLoc.set(locId, { gross: 0, fees: 0, loan: 0, folder: 0, credits: 0, count: 0, lastAt: null });
    return byLoc.get(locId);
  };
  const collectFrom = (d) => {
    if (d?.status !== 'completed' || !isCounted(d)) return;
    const payments = Array.isArray(d?.cod_payments) ? d.cod_payments : [];
    const cardPayments = payments.filter((p) =>
      ['debit', 'credit'].includes(String(p?.type || '').toLowerCase()) && Number(p?.amount) > 0);
    if (cardPayments.length === 0) return;
    const locId = storeToLoc.get(String(d?.store_id || ''));
    if (!locId) return;
    const loanRate = loanRateByLoc.get(locId) || 0;
    const agg = aggFor(locId);
    for (const p of cardPayments) {
      const amount = Number(p.amount);
      const type = String(p.type || '').toLowerCase();
      const fee = estimateCardFee(amount, type);
      const loan = amount * loanRate;
      const folder = amount * folderRate;
      agg.gross += amount; agg.fees += fee; agg.loan += loan; agg.folder += folder;
      agg.credits += amount - fee - loan - folder;
      agg.count += 1;
    }
    const doneAt = String(d.actual_delivery_time || '');
    if (doneAt && String(agg.lastAt || '') < doneAt) agg.lastAt = doneAt;
  };
  for (const d of (allDeliveries || [])) collectFrom(d);
  // IDB prunes deliveries older than 60 days — sweep the API tail once when
  // the true-up window extends beyond that horizon (same pattern as
  // computeCodOutstandingDetailed).
  const idbHorizon = new Date(Date.now() - 59 * 86400000).toISOString().slice(0, 10);
  if (cutoffDate < idbHorizon) {
    for (let page = 0; page < 4; page++) {
      const list = await base44.entities.Delivery.list('-created_date', 2000, page * 2000).catch(() => []);
      const rows = list || [];
      for (const d of rows) {
        if (String(d?.delivery_date || '') >= idbHorizon) continue; // IDB already covers these
        collectFrom(d);
      }
      if (rows.length < 2000) break;
    }
  }
  for (const agg of byLoc.values()) {
    const r2 = (x) => Math.round(x * 100) / 100;
    agg.gross = r2(agg.gross); agg.fees = r2(agg.fees); agg.loan = r2(agg.loan);
    agg.folder = r2(agg.folder); agg.credits = r2(agg.credits);
  }
  return byLoc;
}

// Both ledger windows (card sales + unlinked-ring sales pool) use the same
// Edmonton-day horizon: candidates are deliveries dated cutoff-onward, and a
// confirming ring can land at most 3 days before that.
function windowSinceFor(cfg) {
  const tu = cfg?.trued_up_at ? new Date(cfg.trued_up_at) : null;
  const cutoffD = (tu ? new Date(tu.getTime() - 6 * 3600000) : new Date(Date.now() - 6 * 3600000)).toISOString().slice(0, 10);
  return new Date(new Date(`${cutoffD}T00:00:00Z`).getTime() - 3 * 86400000).toISOString();
}

// One row per square_id, whatever the table holds (Oct 2 2026): a mid-storm
// ledger sync once re-created rows as duplicates, and each copy of a swipe
// re-counted its amount AND its ~7-cent fee in the card-balance math. The
// sync now dedupes on write; this dedupes on read so the math is correct
// even against pre-fix duplicate rows.
// Entry-kind transition (owner revamp, Oct 3 2026): sale -> collected,
// payout -> card_spend. The DB backfill rewrites old rows, but IDB window
// caches can still hold old-kind rows for up to 10 minutes — every reader
// accepts BOTH values until the migration fully settles.
const SALE_KINDS = ['sale', 'collected'];
const PAYOUT_KINDS = ['payout', 'card_spend'];
const isSaleKind = (e) => SALE_KINDS.includes(String(e?.entry_kind || ''));
const isPayoutKind = (e) => PAYOUT_KINDS.includes(String(e?.entry_kind || ''));

function dedupeBySquareId(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows || []) {
    const key = r?.square_id || r?.id || null;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

export async function loadCardSales(cfg, userId = null) {
  if (!cfg?.trued_up_at) return [];
  const cached = await freshLedgerWindows(cfg, userId);
  if (cached && cached.fetched?.sales) return dedupeBySquareId(cached.sales);
  const out = [];
  let skip = 0;
  for (let page = 0; page < 40; page++) {
    const rows = await base44.entities.SquareLedgerEntry.filter(
      { tender_type: 'CARD', status: 'COMPLETED', occurred_at: { $gte: cfg.trued_up_at } },
      'created_date', 500, skip
    ).catch(() => []);
    const list = rows || [];
    out.push(...list);
    if (list.length < 500) break;
    skip += 500;
  }
  const deduped = dedupeBySquareId(out).filter(isSaleKind);
  writeLedgerCache({ trued_up_at: cfg.trued_up_at, sales: deduped }, userId);
  return deduped;
}

// cod_collection ledger rows windowed to the candidate horizon (Oct 2 2026):
// previously an UNWINDOWED full scan — every confirmed COD ring ever recorded —
// on every refresh. Only candidates dated cutoff-onward can be confirmed, and
// a ring always lands AFTER its delivery's date, so the window is lossless.
// Fully paged (the old unpageed filter silently truncated at the server's
// default page size anyway).
async function loadCodSales(cfg, userId = null) {
  const since = windowSinceFor(cfg);
  const cached = await freshLedgerWindows(cfg, userId);
  if (cached && cached.window_since === since && cached.fetched?.cod_sales) return dedupeBySquareId(cached.cod_sales);
  const out = [];
  let skip = 0;
  for (let page = 0; page < 20; page++) {
    const rows = await base44.entities.SquareLedgerEntry.filter(
      { sale_class: 'cod_collection', occurred_at: { $gte: since } },
      'created_date', 500, skip
    ).catch(() => []);
    const list = rows || [];
    out.push(...list);
    if (list.length < 500) break;
    skip += 500;
  }
  const deduped = dedupeBySquareId(out);
  writeLedgerCache({ trued_up_at: cfg?.trued_up_at || null, window_since: since, cod_sales: deduped }, userId);
  return deduped;
}

// Completed sales for the unlinked-ring fallback, same window as loadCodSales.
async function loadWindowSales(cfg, userId = null) {
  const since = windowSinceFor(cfg);
  const cached = await freshLedgerWindows(cfg, userId);
  if (cached && cached.window_since === since && cached.fetched?.window_sales) return dedupeBySquareId(cached.window_sales);
  const out = [];
  let skip = 0;
  for (let page = 0; page < 20; page++) {
    const rows = await base44.entities.SquareLedgerEntry.filter(
      { status: 'COMPLETED', occurred_at: { $gte: since } },
      'created_date', 500, skip
    ).catch(() => []);
    const list = rows || [];
    out.push(...list);
    if (list.length < 500) break;
    skip += 500;
  }
  const dedupedW = dedupeBySquareId(out).filter(isSaleKind);
  writeLedgerCache({ trued_up_at: cfg?.trued_up_at || null, window_since: since, window_sales: dedupedW }, userId);
  return dedupedW;
}

// Card-spend EVIDENCE pool (owner spec, Oct 3 2026): a swiped COD appears in
// the ledger as either ONE sale or a COMBINATION of 2+ partial sales totaling
// the COD amount — same date, same store, same customer card — and the story
// almost always carries one or more FAILED (declined) entries on that card
// too. The badge/rows "Card Spend" pill needs BOTH sides of that story, so
// this loads 30 days of completed CARD sales plus every decline, riding the
// same 10-minute IDB windows cache. 30 days covers the full "Past
// uncollected" list; older CODs than that never had swipes detected anyway.
export async function loadCardSpendEvidence(cfg, userId = null) {
  // Day-aligned so the cache key is stable across calls within a day (the
  // 10-minute TTL guard in freshLedgerWindows still bounds staleness).
  const since = new Date(Math.floor(Date.now() / 86400000) * 86400000 - 30 * 86400000).toISOString();
  const cached = await freshLedgerWindows(cfg, userId);
  if (cached && cached.evidence_since === since && cached.fetched?.evidence_sales && cached.fetched?.evidence_declines) {
    return { sales: dedupeBySquareId(cached.evidence_sales).filter(isSaleKind), declines: dedupeBySquareId(cached.evidence_declines) };
  }
  const sales = [];
  const declines = [];
  let skip = 0;
  // Owner report (Oct 6 2026): Square's own app shows some card-spend swipes
  // under a "Pending" header — authorized but not yet settled (e.g. Elaine
  // Ash's 49.98). Those must be eligible for the Card Spend badge too, not
  // just COMPLETED ones, so pull all three in-flight-or-settled statuses.
  for (const st of ['COMPLETED', 'APPROVED', 'PENDING']) {
    skip = 0;
    for (let page = 0; page < 20; page++) {
      const rows = await base44.entities.SquareLedgerEntry.filter(
        { tender_type: 'CARD', status: st, occurred_at: { $gte: since } },
        'created_date', 500, skip
      ).catch(() => []);
      const list = rows || [];
      sales.push(...list);
      if (list.length < 500) break;
      skip += 500;
    }
  }
  skip = 0;
  for (let page = 0; page < 20; page++) {
    const rows = await base44.entities.SquareLedgerEntry.filter(
      { entry_kind: 'decline', occurred_at: { $gte: since } },
      'created_date', 500, skip
    ).catch(() => []);
    const list = rows || [];
    declines.push(...list);
    if (list.length < 500) break;
    skip += 500;
  }
  const dedupedSales = dedupeBySquareId(sales).filter(isSaleKind);
  const dedupedDeclines = dedupeBySquareId(declines);
  writeLedgerCache({ trued_up_at: cfg?.trued_up_at || null, evidence_since: since, evidence_sales: dedupedSales, evidence_declines: dedupedDeclines }, userId);
  return { sales: dedupedSales, declines: dedupedDeclines };
}

// Bank sweeps (BATCH payouts) since the true-up. Square auto-transfers the
// card balance to the linked bank account — the real card DROPS by these,
// so the estimate must subtract them (owner mismatch report, Oct 2 2026:
// Bonnie Doon swept $75.59 the same day and the app kept showing it).
// SIMPLE payouts are EXCLUDED: they are Square's per-sale withholdings
// (loan/folder), which the credits formula already deducts via
// loan_rate/folder_rate — subtracting them again would double-count.
// Verified live: BATCH = sale − fee − loan% − 2% exactly, SIMPLE = 2% of sale.
// Only PAID/SENT have actually left the balance (PENDING/IN_PROGRESS have not,
// CANCELED/FAILED never will). Dedupe by square_id AND amount+time+type —
// duplicate payout rows exist in the ledger (Callingwood Oct 2: the same
// 05:37Z payout persisted twice).
export async function loadCardPayouts(cfg, userId = null) {
  if (!cfg?.trued_up_at) return [];
  const cached = await freshLedgerWindows(cfg, userId);
  if (cached && cached.fetched?.payouts) return cached.payouts || [];
  // OWNER REPORT Oct 7 2026 ("balances way off since true-up"): the previous
  // model subtracted each card sale's settled_cents as a "bank sweep" — but
  // that money never LEAVES the card. Square auto-sweeps each sale's net
  // FROM the store location balance ONTO the card (BATCH payout, destination
  // SQUARE_STORED_BALANCE — stored by squareLedgerSync as 'store_topup',
  // owner spec Oct 5: "actual collected, not the settled amounts").
  // Subtracting it while ALSO crediting the delivery net collection netted
  // every collection to ~zero while the real cards grew (CW was ~$113 low).
  // Only REAL withdrawals subtract now: negative payouts recorded by the
  // sync as entry_kind 'store_withdraw'. Topups/arrivals are display-only —
  // the delivery credits already represent them.
  const rows = [];
  let skip = 0;
  for (let page = 0; page < 20; page++) {
    const list = await base44.entities.SquareLedgerEntry.filter(
      { occurred_at: { $gte: cfg.trued_up_at } },
      'created_date', 500, skip
    ).catch(() => []);
    rows.push(...(list || []));
    if ((list || []).length < 500) break;
    skip += 500;
  }
  const seenId = new Set();
  const out = [];
  for (const r of rows || []) {
    if (String(r?.entry_kind || '') !== 'store_withdraw') continue;
    const st = String(r?.status || '').toUpperCase();
    if (st === 'PENDING' || st === 'IN_PROGRESS' || st === 'FAILED') continue;
    if (!r?.id || !r?.square_id || seenId.has(r.square_id)) continue;
    seenId.add(r.square_id);
    const cents = Math.abs(Math.round(Number(r.amount_cents || 0)));
    out.push({ id: r.id, location_id: r.location_id, amount: cents / 100, amount_cents: cents, occurred_at: r.occurred_at, status: r.status });
  }
  writeLedgerCache({ trued_up_at: cfg.trued_up_at, payouts: out }, userId);
  return out;
}

// Card top-ups — fund transfers ONTO the Square Cards (owner request, Oct 3
// 2026: "pull transfer records card-to-card / folder-to-card"). The sync
// stores them as entry_kind 'card_topup' at the card (MOBILE) locations:
// per-sale money moves (attributed to the source store) and, when Square
// exposes them, manual folder/card-to-card transfers (unattributed).
// They CREDIT the card — PAYOUT_KINDS above deliberately excludes
// card_topup so sweeps math can never subtract them. Not yet wired into
// cardEstimate (owner's call — see Oct 3 notes); shown as records on the
// Balances page so transfers finally show up.
export async function loadCardTopups(cfg, userId = null) {
  if (!cfg?.trued_up_at) return [];
  const cached = await freshLedgerWindows(cfg, userId);
  if (cached && cached.fetched?.topups) return cached.topups || [];
  const rows = [];
  let skip = 0;
  for (let page = 0; page < 20; page++) {
    const list = await base44.entities.SquareLedgerEntry.filter(
      { occurred_at: { $gte: cfg.trued_up_at } },
      'created_date', 500, skip
    ).catch(() => []);
    // 'card_topup' = manual folder/card-to-card transfers; 'store_topup' =
    // Square's auto-sweep of each card sale's net ONTO the card (owner spec
    // Oct 5) — both are ARRIVALS, display-only (the estimate credits
    // collections via delivery data, not these rows).
    rows.push(...(list || []).filter((r) => ['card_topup', 'store_topup'].includes(String(r?.entry_kind || ''))));
    if ((list || []).length < 500) break;
    skip += 500;
  }
  const out = [];
  for (const r of dedupeBySquareId(rows)) {
    out.push({
      id: r.id,
      square_id: r.square_id,
      card_location_id: r.location_id || null,
      card_name: r.location_name || null,
      amount: Number(r.amount_cents || 0) / 100,
      occurred_at: r.occurred_at || null,
      attributed_location_id: r.attributed_location_id || null,
      reason: r.reason || null,
    });
  }
  writeLedgerCache({ trued_up_at: cfg.trued_up_at, topups: out }, userId);
  return out;
}

export function payoutsByLocation(payouts) {
  const m = new Map();
  for (const p of payouts || []) {
    if (!p?.location_id) continue;
    m.set(p.location_id, (m.get(p.location_id) || 0) + (Number(p.amount) || 0) / 100);
  }
  return m;
}

export async function buildStoreNameMap() {
  // IDB-first (Oct 2 2026): the app sync keeps STORES fresh locally.
  const rows = await idbOrApi(offlineDB.STORES.STORES, 'stores', IDB_REF_TTL,
    () => base44.entities.Store.list(), 5);
  const m = new Map();
  (rows || []).forEach((s) => { if (s?.id) m.set(String(s.id), s?.name || String(s.id)); });
  return m;
}

export async function buildStoreToLocMap() {
  const [storesRaw, cfgsRaw] = await Promise.all([
    idbOrApi(offlineDB.STORES.STORES, 'stores', IDB_REF_TTL,
      () => base44.entities.Store.list(), 5),
    idbOrApi(offlineDB.STORES.SQUARE_LOCATION_CONFIGS, 'locCfgs', IDB_REF_TTL,
      () => base44.entities.SquareLocationConfig.list(), 1),
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
export async function computeCodOutstandingDetailed(cfgArg, userId = null) {
  // IDB-first for the app-synced reference data (no API cost); the Square
  // ledger scans stay on the API (ledger rows change only via squareLedgerSync,
  // so they are one bounded read each, windowed where possible).
  // OWNER SPEC (Oct 7 2026): outstanding is STRICTLY delivery data — pending /
  // in_transit / en_route deliveries with a required COD. All Square-ledger
  // reads are gone (they only ever held half the collections). A FINISHED
  // delivery is collected: its money is calculated into the card estimate via
  // loadDeliveryCardCredits (Debit/Credit) or lands as drawer cash (Cash badge)
  // — finished rows no longer linger here as "awaiting Square".
  const [storesRaw, cfgsRaw, patientsRaw, allDeliveries] = await Promise.all([
    idbOrApi(offlineDB.STORES.STORES, 'stores', IDB_REF_TTL, () => base44.entities.Store.list(), 5),
    idbOrApi(offlineDB.STORES.SQUARE_LOCATION_CONFIGS, 'locCfgs', IDB_REF_TTL, () => base44.entities.SquareLocationConfig.list(), 1),
    idbOrApi(offlineDB.STORES.PATIENTS, 'patients', IDB_REF_TTL, () => base44.entities.Patient.list(), 20),
    getAllDeliveriesIdb(),
  ]);
  const patientById = new Map();
  (patientsRaw || []).forEach((p) => { if (p?.id) patientById.set(String(p.id), p); if (p?.patient_id) patientById.set(String(p.patient_id), p); });
  const patientNameOf = (pid) => (pid ? (patientById.get(String(pid))?.full_name || null) : null);
  const cfgLoc = new Map();
  (cfgsRaw || []).forEach((c) => { if (c?.id && c?.square_location_id) cfgLoc.set(c.id, c.square_location_id); });
  const storeToLoc = new Map();
  // Store badge info (owner report Oct 5 2026: badges missing next to patient
  // names on Uncollected / Past uncollected rows). computeCodOutstandingDetailed
  // items only carried store_id — the render reads it.storeAbbrev/storeColor
  // which were always undefined for delivery-derived rows.
  const storeInfoById = new Map();
  (storesRaw || []).forEach((s) => {
    const loc = s?.square_location_config_id ? cfgLoc.get(s.square_location_config_id) : null;
    if (s?.id && loc) storeToLoc.set(String(s.id), loc);
    if (s?.id) storeInfoById.set(String(s.id), { abbreviation: s?.abbreviation || null, color: s?.color || null });
  });
  const storeBadgeOf = (sid) => {
    const si = sid ? storeInfoById.get(String(sid)) : null;
    return si ? { storeAbbrev: si.abbreviation, storeColor: si.color } : { storeAbbrev: null, storeColor: null };
  };
  const cfg = cfgArg;
  const tu = cfg?.trued_up_at ? new Date(cfg.trued_up_at) : null;
  const cutoffDate = (tu ? new Date(tu.getTime() - 6 * 3600000) : new Date(Date.now() - 6 * 3600000)).toISOString().slice(0, 10);
  const isCounted = (d) => String(d?.delivery_date || '') >= cutoffDate;
  const centsOf = (n) => Math.round(Number(n || 0) * 100);
  const byLoc = new Map();
  const aggFor = (locId) => {
    if (!byLoc.has(locId)) byLoc.set(locId, { total: 0, pendingCount: 0, awaitingCount: 0, items: [] });
    return byLoc.get(locId);
  };

  for (const status of ['pending', 'in_transit', 'en_route']) {
    const rows = deliveriesWithStatus(allDeliveries, status);
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
      agg.items.push({ delivery_id: d.id, status, amount: outstanding / 100, reason: 'pending_or_in_transit', date: String(d.delivery_date || '').slice(0, 10), created_date: d.created_date || null, patient: patientNameOf(d.patient_id), store_id: d.store_id, ...storeBadgeOf(d.store_id) });
    }
  }

  // COLLECTED-COD DEDUCTION ITEMS (owner report, Oct 7 2026, the $53.05
  // Londonderry case): a post-True-Up COD deducted from the estimate while it
  // was out (the order's goods were charged to the Square card) must KEEP
  // its deduction after the delivery completes — the charge already hit the
  // card; only the collected net (loadDeliveryCardCredits) comes back on top.
  // Without this, finishing a delivery released the pending deduction AND
  // added the net credit, double-counting the gross amount. Items use the
  // FULL required COD (not outstanding-minus-payments) — the charge was the
  // whole amount. computePendingCodDeduction applies the same pre-True-Up /
  // touched / not-Tapped / payout-matched rules via its whitelist ('completed').
  const deductByLoc = new Map();
  for (const d of deliveriesWithStatus(allDeliveries, 'completed') || []) {
    const required = Number(d?.cod_total_amount_required || 0);
    if (required <= 0 || !isCounted(d)) continue;
    const locId = storeToLoc.get(String(d?.store_id || ''));
    if (!locId) continue;
    if (!deductByLoc.has(locId)) deductByLoc.set(locId, []);
    deductByLoc.get(locId).push({
      delivery_id: d.id, status: 'completed', amount: centsOf(required) / 100,
      reason: 'collected_charge', date: String(d.delivery_date || '').slice(0, 10),
      created_date: d.created_date || null,
    });
  }

  const out = {};
  const allLocs = new Set([...byLoc.keys(), ...deductByLoc.keys()]);
  for (const locId of allLocs) {
    const agg = byLoc.get(locId) || { total: 0, pendingCount: 0, awaitingCount: 0, items: [] };
    out[locId] = { location_id: locId, total: agg.total / 100, pending_count: agg.pendingCount, awaiting_square_count: agg.awaitingCount, items: agg.items.slice(0, 50), deductItems: deductByLoc.get(locId) || [] };
  }
  return out;
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
    const byStore = new Map();
    const list = await getAllDeliveriesIdb();
    for (const d of list) {
      const dd = String(d?.delivery_date || '');
      if (dd < from || dd >= today) continue;
      if (d?.status === 'cancelled') continue;
      const required = Number(d?.cod_total_amount_required || 0);
      if (required <= 0 || !d?.store_id) continue;
      byStore.set(String(d.store_id), (byStore.get(String(d.store_id)) || 0) + required);
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
    const allRows = await getAllDeliveriesIdb();
    for (const status of ['pending', 'in_transit', 'en_route']) {
      const rows = deliveriesWithStatus(allRows, status);
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

// ── Owner reconcile plan (Oct 3 2026) ───────────────────────────────────────
// Store-card fingerprint learning: a card swiped 5+ times at ONE location
// whose sales NEVER match a COD is the store's own business card (store-card
// spend), not a patient collection — exclude it from credit math and from COD
// matching. Fingerprints repeat over the whole window.
export function learnStoreCardFingerprints(sales) {
  const counts = new Map();
  const codLinked = new Set();
  for (const s of sales || []) {
    const fp = s?.card_fingerprint;
    if (!fp || !s?.location_id) continue;
    const key = `${s.location_id}:${fp}`;
    counts.set(key, (counts.get(key) || 0) + 1);
    if (s?.sale_class === 'cod_collection' || s?.delivery_id) codLinked.add(key);
  }
  const storeCardFps = new Set();
  for (const [key, n] of counts) {
    if (n >= 5 && !codLinked.has(key)) storeCardFps.add(String(key).split(':').slice(1).join(':'));
  }
  return storeCardFps;
}

// Payout-matched outstanding COD (owner rule Oct 3): an outstanding COD
// subtracts from the card balance ONLY when the store's payout(s) since
// true-up EXACTLY equal the COD amount (single payout, or a subset of 2-3
// combining to it — "amount or amounts that equal the COD to collect").
// Returns the matched payout indexes so they can be excluded from the bank
// sweep total (subtracting both the COD and its charge payout would
// double-count).
export function matchPayoutChargedCods(outstandingItems, payoutCents) {
  const outs = (outstandingItems || [])
    .map((it) => ({ cents: Math.round(Number(it?.amount || 0) * 100), id: it?.delivery_id ? String(it.delivery_id) : null }))
    .filter((x) => Number.isFinite(x.cents) && x.cents > 0);
  const payouts = (payoutCents || []).map((c) => Math.round(Number(c) || 0));
  const matched = new Set();
  const matchedItemIds = new Set();
  let chargedCents = 0;
  let chargedCount = 0;
  const available = () => payouts.map((c, i) => ({ c, i })).filter((x) => !matched.has(x.i) && x.c > 0);
  for (const target of outs) {
    const pool = available();
    let hit = null;
    for (const one of pool) if (one.c === target) { hit = [one]; break; }
    if (!hit) {
      outer: for (let i = 0; i < pool.length; i++) {
        for (let j = i + 1; j < pool.length; j++) {
          if (pool[i].c + pool[j].c === target) { hit = [pool[i], pool[j]]; break outer; }
          for (let k = j + 1; k < pool.length; k++) {
            if (pool[i].c + pool[j].c + pool[k].c === target) { hit = [pool[i], pool[j], pool[k]]; break outer; }
          }
        }
      }
    }
    if (hit) { hit.forEach((h) => matched.add(h.i)); chargedCents += target.cents; chargedCount += 1; if (target.id) matchedItemIds.add(target.id); }
  }
  return { matched, chargedCents, chargedCount, matchedItemIds };
}

// OWNER RULE (Oct 6-7 2026, corrected): the card_start counted at True-Up
// already reflects every COD outstanding AT THAT MOMENT — deducting them
// again would double-count. So an outstanding COD only affects the estimate
// going forward when the owner takes an action AFTER true-up:
//   - a brand-new delivery entered (created_date >= trued_up_at) deducts the
//     moment it's pending/in-transit (default assumption: Card Spend), OR
//   - an OLDER (pre-true-up) COD the owner explicitly clicks (its Card Spend
//     mark's touchedAt >= trued_up_at) then participates from that click
//     onward, using whatever state the click left it in.
// Everything else (pre-existing, never touched since true-up) stays neutral
// — "none of these should be added or deducted until I click a badge."
// marksMap: { [deliveryId]: { notTapped: boolean, touchedAt: iso } }.
export function computePendingCodDeduction(outstandingItems, marksMap, excludeIds, truedUpAt) {
  let deductCents = 0; let count = 0;
  const tu = truedUpAt ? new Date(truedUpAt).getTime() : null;
  for (const it of outstandingItems || []) {
    if (!['pending', 'in_transit', 'en_route', 'completed'].includes(String(it?.status || ''))) continue;
    const id = it?.delivery_id ? String(it.delivery_id) : null;
    if (id && excludeIds && excludeIds.has(id)) continue;
    const cents = Math.round(Number(it?.amount || 0) * 100);
    if (!(cents > 0)) continue;
    const mark = id ? marksMap?.[id] : null;
    const createdT = it?.created_date ? new Date(it.created_date).getTime() : null;
    const isNewSinceTrueUp = tu != null && createdT != null && createdT >= tu;
    const touchedT = mark?.touchedAt ? new Date(mark.touchedAt).getTime() : null;
    const isTouchedSinceTrueUp = tu != null && touchedT != null && touchedT >= tu;
    if (!isNewSinceTrueUp && !isTouchedSinceTrueUp) continue; // neutral — untouched pre-existing COD
    if (mark?.notTapped === true) continue; // explicitly not tapped — never deducts
    deductCents += cents; count += 1;
  }
  return { deductCents, count };
}

function computeByLocId({ config, deliveryCredits, weeklyAvgByLoc, payoutsByLoc, payoutCentsByLoc, codOutstandingDetailed, marksMap, truedUpAt }) {
  // OWNER SPEC (Oct 7 2026): the credit side of the estimate comes STRICTLY
  // from delivery data — finished deliveries' Debit/Credit cod_payments,
  // net of the rate-sheet fee + loan% + folder% (loadDeliveryCardCredits).
  // The Square-ledger sale scan is gone: it only ever held half the
  // collections (broken link chains, pending entries, unlinked rings).
  const byLocId = new Map();
  for (const loc of (config.locations || [])) {
    const _dc = deliveryCredits?.get?.(loc.location_id) || {};
    const credits = Number(_dc.credits || 0);
    const loan = Number(_dc.loan || 0);
    const storeCardSpend = 0;
    // UN-SWIPED CODs DO NOT REDUCE THE BALANCE (owner rule, Oct 2 2026,
    // Londonderry $528.17 report): a COD only registers as money removed from
    // the card once its actual card spend exists in the Square records. The
    // spend arrives as a card sale (counted in credits above) and the delivery
    // gets cod_confirmed_collected, so outstanding CODs — pending, in
    // transit, or collected cash awaiting the Square ring — are tracked in the
    // Uncollected lists and drive the low-balance forecast, but they do NOT
    // subtract from the estimate. The estimate reflects only real card
    // activity: starting balance + net sale credits − bank sweeps.
    // BATCH bank sweeps since true-up also leave the card (Oct 2 2026 fix).
    // PAYOUT-MATCHED OUTSTANDING CODs (owner rule Oct 3 2026): a COD to collect
    // subtracts from the card balance ONLY when the store's payouts contain an
    // amount (or amounts combining to) exactly the COD cents — the charge has
    // hit the card. Matched payouts drop out of the sweep total so the COD and
    // its charge are never counted twice.
    // REAL card withdrawals only (owner report Oct 7 2026): a sale's
    // settled/net cents auto-sweep ONTO the card ('store_topup'), they never
    // leave it — subtracting them netted every collection to ~zero while the
    // real cards grew. Only 'store_withdraw' payouts (negative BATCH
    // reversals) are money leaving the card.
    const withdrawn = (payoutCentsByLoc?.get?.(loc.location_id) || []).reduce((sum, c) => sum + (Number(c) || 0), 0) / 100;
    // Estimate-side COD list = ACTIVE uncollected items + the collected-charge
    // deduction items (owner report Oct 7 2026: a deducted COD keeps its
    // deduction after completion — the order's charge already hit the card).
    const outstandingItems = [
      ...((codOutstandingDetailed?.[loc.location_id]?.items) || []),
      ...((codOutstandingDetailed?.[loc.location_id]?.deductItems) || []),
    ];
    // Owner rule Oct 6 2026 + Oct 7 2026 fix: deducted CODs (active OR
    // completed post-True-Up) keep deducting; "Not Tapped" marks never deduct.
    const { deductCents: pendingDeductCents, count: pendingDeductCount } = computePendingCodDeduction(outstandingItems, marksMap, null, truedUpAt);
    const cardEstimate = Math.round((Number(loc.card_start || 0) + credits - withdrawn - pendingDeductCents / 100) * 100) / 100;
    const codAvg = Math.round(Number(weeklyAvgByLoc?.[loc.location_id] || 0) * 100) / 100;
    byLocId.set(loc.location_id, {
      name: loc.name || loc.location_id,
      cardEstimate,
      loanRemaining: Math.round(Math.max(0, Number(loc.loan_start || 0) - loan) * 100) / 100,
      codAvg,
      sweptOut: Math.round(withdrawn * 100) / 100, // real withdrawals since true-up
      chargedToCard: 0, // payout-matching retired Oct 7: sale nets ARRIVE on the card, they don't leave
      chargedCount: 0,
      pendingDeducted: Math.round(pendingDeductCents) / 100,
      pendingDeductCount,
      storeCardSpend: Math.round(storeCardSpend * 100) / 100,
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

// FIX (Oct 3 2026): loadSummary was hoisted to MODULE scope for the
// summaryCache/inflight coalescing, but still referenced `userIdRef` — a ref
// that lives INSIDE the hook. Module scope can never see hook locals, so every
// load threw `userIdRef is not defined` and the badge fell into the retry loop
// (observed as "reload attempt 1-4 failed"). The uid now travels as a
// parameter from the hook's reload().
async function loadSummary(force, uid) {
  const now = Date.now();
  if (!force && summaryCache.data && now - summaryCache.at < SUMMARY_CACHE_TTL) {
    return { cached: true, data: summaryCache.data, degraded: false };
  }
  // Coalesce concurrent requests (mount + a WS debounce firing together)
  if (inflight) return inflight;
  inflight = (async () => {
    const config = await loadConfig();
    const [deliveryCredits, stl, names, spendMarkRows] = await Promise.all([
      config ? loadDeliveryCardCredits(config, uid).catch(() => new Map()) : Promise.resolve(new Map()),
      buildStoreToLocMap().catch(() => new Map()),
      buildStoreNameMap().catch(() => new Map()),
      // Not Tapped overrides (owner Card Spend badge toggle, Oct 6 2026) —
      // a "Not Tapped" COD is added back to the card estimate, never deducted.
      getAppSettingRows(SPEND_MARKS_KEY).catch(() => []),
    ]);
    // Defensive: multiple records with the same setting_key have appeared
    // before — always read the most recently updated one.
    const marksRec = (spendMarkRows || []).filter(Boolean).sort((a, b) => String(b?.updated_date || '').localeCompare(String(a?.updated_date || '')))[0];
    const spendMarksVal = marksRec?.setting_value;
    // Normalize legacy {notTappedAt} shape and the new {notTapped,touchedAt}
    // shape into one marksMap: { [id]: { notTapped, touchedAt } }.
    const marksMap = {};
    for (const [k, v] of Object.entries(spendMarksVal && typeof spendMarksVal === 'object' ? spendMarksVal : {})) {
      if (!v || typeof v !== 'object') continue;
      if (v.notTappedAt) marksMap[k] = { notTapped: true, touchedAt: v.notTappedAt };
      else if (v.touchedAt) marksMap[k] = { notTapped: !!v.notTapped, touchedAt: v.touchedAt };
    }
    // One detailed pass — the totals map used by the card math is derived from
    // it, and the detailed output (items/patient names) is kept so the Square
    // Balances page can hydrate offline from the IDB snapshot without a
    // second compute.
    const [codDetailedRaw, weekly, dailyRemaining, payouts] = await Promise.all([
      config ? computeCodOutstandingDetailed(config, uid) : Promise.resolve({}),
      computeWeeklyCached(),
      computeDailyCodRemainingByStore(),
      config ? loadCardPayouts(config, uid) : Promise.resolve([]),
    ]);
    // null = both attempts failed (e.g. transient entity rate limit). Cache the
    // degraded result so the badge still shows something, but flag it so the
    // hook schedules a self-heal forced reload.
    const degraded = codDetailedRaw === null;
    const codOutstandingDetailed = degraded ? {} : (codDetailedRaw || {});
    const codOutstanding = {};
    for (const [locId, agg] of Object.entries(codOutstandingDetailed)) codOutstanding[locId] = agg?.total ?? agg;
    const payoutsLoc = payoutsByLocation(payouts);
    const payoutCentsByLoc = new Map();
    for (const pw of payouts || []) {
      if (!pw?.location_id) continue;
      if (!payoutCentsByLoc.has(pw.location_id)) payoutCentsByLoc.set(pw.location_id, []);
      payoutCentsByLoc.get(pw.location_id).push(Math.round(Number(pw.amount_cents || 0)));
    }
    const data = {
      byLocId: config ? computeByLocId({ config, deliveryCredits, codOutstanding, weeklyAvgByLoc: weeklyAvgByLocFromStores(stl, weekly), payoutsByLoc: payoutsLoc, payoutCentsByLoc, codOutstandingDetailed, marksMap, truedUpAt: config?.trued_up_at || null }) : new Map(),
      payoutsByLoc: payoutsLoc,
      storeToLoc: stl,
      weeklyByStore: weekly,
      storeNames: names,
      dailyRemainingByStore: dailyRemaining,
      codOutstandingDetailed,
      config: config || null,
      deliveryCredits: deliveryCredits || new Map(),
      sales: [], // legacy field — sale-based math retired Oct 7 2026
      payouts: payouts || [],
    };
    summaryCache.at = Date.now();
    summaryCache.data = data;
    return { cached: false, data, degraded };
  })().finally(() => { inflight = null; });
  return inflight;
}

export function useSquareBalancesSummary(enabled = true, userId = null) {
  const [ready, setReady] = useState(false);
  const [byLocId, setByLocId] = useState(new Map());
  const [storeToLoc, setStoreToLoc] = useState(new Map());
  const [weeklyByStore, setWeeklyByStore] = useState(new Map());
  const [storeNames, setStoreNames] = useState(new Map());
  const [dailyRemainingByStore, setDailyRemainingByStore] = useState(new Map());
  const [payoutsByLoc, setPayoutsByLoc] = useState(new Map());
  const reloadSeq = useRef(0);
  const userIdRef = useRef(userId);
  userIdRef.current = userId;
  // True once an IDB snapshot has been applied at boot — controls whether the
  // deferred first-load band-aid still applies (fresh installs only).
  const hydratedFromIdbRef = useRef(false);

  // Serialize the summary for the IDB snapshot. Maps become entry arrays;
  // deserializeSummary() rebuilds them. Fire-and-forget, never blocks the UI.
  const persistSnapshot = useCallback((data) => {
    if (!data) return;
    const payload = {
      byLocId: [...(data.byLocId || new Map())],
      payoutsByLoc: [...(data.payoutsByLoc || new Map())],
      storeToLoc: [...(data.storeToLoc || new Map())],
      weeklyByStore: [...(data.weeklyByStore || new Map())],
      storeNames: [...(data.storeNames || new Map())],
      dailyRemainingByStore: [...(data.dailyRemainingByStore || new Map())],
      codOutstandingDetailed: data.codOutstandingDetailed || {},
      config: data.config || null,
      deliveryCredits: [...(data.deliveryCredits || new Map())],
      sales: data.sales || [],
      payouts: data.payouts || [],
      savedAt: new Date().toISOString(),
    };
    saveSummarySnapshot(userIdRef.current, payload).catch?.(() => {});
  }, []);

  const apply = useCallback((data) => {
    setByLocId(data.byLocId);
    setStoreToLoc(data.storeToLoc);
    setWeeklyByStore(data.weeklyByStore);
    setStoreNames(data.storeNames);
    setDailyRemainingByStore(data.dailyRemainingByStore);
    setPayoutsByLoc(data.payoutsByLoc || new Map());
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
      ({ data, degraded } = await loadSummary(force, userIdRef.current || null));
    } catch (e) {
      const msg = String(e?.message || e);
      const status = Number(e?.status || e?.response?.status || 0);
      const rateLimited = status === 429 || /429|rate limit|too many/i.test(msg);
      console.warn(`[useSquareBalancesSummary] reload attempt ${attempt + 1}${rateLimited ? ' (rate-limited)' : ''} failed:`, msg);
      if (seq !== reloadSeq.current) return;
      if (attempt < 3) {
        // RATE-AWARE BACKOFF (Oct 2 2026, tuned for offline-first): a 429
        // means the per-minute quota bucket is exhausted — the badge already
        // renders the IDB snapshot (and the ledger windows cache keeps the
        // compute offline), so retries only need to EVENTUALLY succeed, never
        // fast. Long waits also stop the retry loop itself from feeding the
        // storm (observed: attempts 1-4 back-to-back made the dots worse).
        const wait = rateLimited ? [30000, 90000, 180000][attempt] : 2000 * Math.pow(2, attempt);
        setTimeout(() => reload(true, attempt + 1), wait);
      }
      return;
    }
    if (seq !== reloadSeq.current) return;
    apply(data);
    persistSnapshot(data);
    // A degraded run (COD-outstanding fetch failed twice) freezes the badge
    // with wrong totals because updates are event-driven — nothing else will
    // fix it. Schedule ONE 30s forced reload to self-heal.
    if (degraded) {
      if (healTimerRef.current) clearTimeout(healTimerRef.current);
      healTimerRef.current = setTimeout(() => { healTimerRef.current = null; reload(true); }, 30000);
    }
  }, [apply, persistSnapshot]);

  // ── Event-driven ONLY updates (owner spec, Oct 1 2026) ────────────────────
  // The badge refreshes ONLY when a user changes a COD delivery (create/edit/
  // delete/collect/status) or performs a True-Up. No periodic re-checking, no
  // timers, no refresh on non-COD activity (GPS, route ops, plain deliveries).
  useEffect(() => {
    if (!enabled) return undefined;
    // OFFLINE-FIRST BOOT (owner report, Oct 2 2026): the summary was NOT in
    // IDB, so every boot started from an empty badge and the only way to load
    // it without joining the boot read-storm was the artificial 4s defer +
    // 'lightweightRefreshComplete' band-aid. Now the LAST snapshot is read
    // from IDB and applied INSTANTLY — the badge shows real numbers at boot,
    // even fully offline — and the fixed boot delay is REMOVED. The first
    // fresh server load still rides the boot wave event (right when the quota
    // bucket frees up); a short 20s silent fallback covers the rare boot where
    // no wave event fires, and it is invisible because the badge is already
    // rendered from the snapshot. Fresh installs (no snapshot yet) keep the
    // original deferred behavior — there is nothing to render otherwise.
    let cancelled = false;
    let bootDelayFired = false;
    let bootTimer = null;
    let firstLoadDone = false;
    const runFirstLoad = () => {
      if (bootDelayFired || firstLoadDone) return;
      bootDelayFired = true;
      if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
      reload();
    };
    (async () => {
      const snap = await getSummarySnapshot().catch(() => null);
      if (cancelled) return;
      // Card balances are role/user-scoped (admin sees all cards, drivers
      // their stores) — never render another user's snapshot.
      if (snap?.payload && (!snap.user_id || snap.user_id === userIdRef.current)) {
        const data = deserializeSummary(snap.payload);
        if (data && !bootDelayFired) {
          apply(data);
          setReady(true);
          hydratedFromIdbRef.current = true;
        }
      }
      if (!hydratedFromIdbRef.current) {
        // No usable snapshot (fresh install / cleared cache): keep the old
        // deferred first load — nothing to render offline.
        bootTimer = setTimeout(runFirstLoad, 4000);
      } else {
        // 60s (Oct 2 2026, was 20s + boot-wave): the badge already renders the
        // snapshot instantly, so the first network refresh has nothing to
        // win by racing the boot read-storm — every 429 here was a red/orange
        // heartbeat dot on the owner's stats card. One minute of (already
        // visible) snapshot data is the cheaper trade.
        bootTimer = setTimeout(runFirstLoad, 60000);
      }
    })();
    const unsubs = [];
    let cfgTimer = null, codTimer = null;
    // True-Up writes AppSettings — the one non-delivery event that directly
    // changes the card starting balances, so it refreshes the badge too.
    try {
      unsubs.push(base44.entities.AppSettings.subscribe((ev) => {
        if (ev?.data?.setting_key !== SETTING_KEY) return;
        if (!bootDelayFired) return; // quiet boot window — snapshot still showing
        clearTimeout(cfgTimer);
        cfgTimer = setTimeout(() => reload(true), 2500);
      }));
    } catch {}
    const scheduleCodReload = () => {
      if (!bootDelayFired) return; // quiet boot window — snapshot still showing
      clearTimeout(codTimer);
      // NON-forced (Oct 2 2026 rate-limit fix): the 60s summary cache
      // coalesces WS bursts — a delivery-change volley runs at most once a
      // minute instead of on every 2.5s-debounced event. True-Up still
      // forces (card_start changed).
      codTimer = setTimeout(() => reload(false), 2500);
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
    // SquareLedgerEntry broadcasts (page sync / manual ring bookkeeping):
    // the ledger windows cache MUST be dropped — the next reload refetches.
    // This is what keeps the IDB cache trustworthy without a polling timer:
    // any change to the badge's money data invalidates it exactly on time.
    try {
      unsubs.push(base44.entities.SquareLedgerEntry.subscribe(() => {
        invalidateLedgerWindows();
        if (!bootDelayFired) return; // quiet boot window — snapshot still showing
        clearTimeout(cfgTimer);
        cfgTimer = setTimeout(() => reload(true), 2500);
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
    // Backend ledger-sync stamp (Oct 7 2026): squareLedgerSync writes
    // AppSettings 'square_ledger_sync' when it changed links/splits/
    // confirmations — its entity writes are service-role and produce NO
    // SquareLedgerEntry broadcasts, so without this the badge never learns
    // about splits. Heal the IDB delivery mirror too (cod_confirmed_collected
    // stamped server-side never reaches the client otherwise).
    const onLedgerSyncStamp = async (e) => {
      const updated = e?.detail?.data || e?.detail;
      if (updated?.setting_key !== 'square_ledger_sync') return;
      invalidateLedgerWindows();
      try {
        const rows = await base44.entities.Delivery.list('-updated_date', 500, 0).catch(() => []);
        if (rows?.length) await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, rows);
        idbReadCaches.deliveries = { at: 0, rows: null };
      } catch { /* non-critical */ }
      if (!bootDelayFired) return; // quiet boot window — snapshot still showing
      clearTimeout(cfgTimer);
      cfgTimer = setTimeout(() => reload(true), 2500);
    };
    window.addEventListener('appSettingsUpdated', onLedgerSyncStamp);
    return () => {
      cancelled = true;
      firstLoadDone = true;
      if (bootTimer) clearTimeout(bootTimer);
      clearTimeout(cfgTimer); clearTimeout(codTimer);
      unsubs.forEach((u) => { try { u?.(); } catch {} });
      window.removeEventListener('deliveriesUpdated', onDeliveriesUpdated);
      window.removeEventListener('appSettingsUpdated', onLedgerSyncStamp);
    };
  }, [enabled, reload, apply]);

  return { ready, byLocId, storeToLoc, weeklyByStore, storeNames, dailyRemainingByStore, payoutsByLoc };
}
