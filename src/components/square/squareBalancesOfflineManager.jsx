// Offline-first snapshot for the Square Balances summary (badge + page).
// Mirrors the squareLedgerOfflineManager pattern: server data is authoritative,
// IDB is a render-first snapshot written after each successful load.
//
// WHY (owner report, Oct 2 2026): the Square Balances summary was NOT part of
// the IDB offline-first load — on every app boot the badge started empty and a
// deferred first server fetch (4s delay + boot-wave event) was the only way to
// avoid joining the boot read-storm and getting rate-limited. With this
// snapshot the badge/page render the last known numbers instantly at boot;
// the server fetch then only REFRESHES them (wave event / COD events), so the
// artificial boot delay could be removed.
import { offlineDB } from '@/components/utils/offlineDatabase';

const SUMMARY_STORE = offlineDB.STORES.SQUARE_BALANCES_SUMMARY;
const RECORD_ID = 'summary';

// RATE SIGNATURE (owner report Oct 28 2026: after Bonnie Doon's loan rate was
// corrected 17.25% -> 16.5% the CARD BALANCE kept rendering the pre-fix
// numbers). The cached summary carries fully computed figures (credits, loan,
// card estimate), so it is only valid for the RATE SHEET that produced it.
// Stamping the signature lets any reader discard a snapshot computed under a
// different loan/folder rate instead of showing stale money math.
const ratesSignature = (config) => {
  const locs = [...(config?.locations || [])]
    .map((l) => `${l?.location_id}:${Number(l?.loan_rate || 0)}`)
    .sort()
    .join(',');
  return `${Number(config?.folder_rate || 0)}|${locs}`;
};

/**
 * Persist a summary snapshot. `payload` must be JSON-plain (Maps serialized as
 * entry arrays) — deserializeSummary() rebuilds it.
 */
export const saveSummarySnapshot = async (userId, payload) => {
  try {
    const record = {
      id: RECORD_ID,
      user_id: userId || null,
      saved_at: new Date().toISOString(),
      rates_sig: ratesSignature(payload?.config),
      payload: payload || null,
    };
    await offlineDB.save(SUMMARY_STORE, record);
    return { success: true };
  } catch (error) {
    console.error('[SquareBalancesOffline] Error saving summary snapshot:', error);
    return { success: false, error: error.message };
  }
};

/**
 * Load the last snapshot. Returns the raw record ({ user_id, saved_at, payload })
 * or null. Callers MUST check user_id before rendering — card balances are
 * role/user-scoped (admin sees all cards, drivers only their stores) and the
 * snapshot is whatever the last signed-in user computed.
 */
export const getSummarySnapshot = async (currentConfig = null) => {
  try {
    const rec = await offlineDB.getById(SUMMARY_STORE, RECORD_ID);
    if (!rec || !rec.payload) return null;
    // Computed under a different rate sheet? Discard — the caller recomputes.
    if (currentConfig && rec.rates_sig && rec.rates_sig !== ratesSignature(currentConfig)) {
      console.warn('[SquareBalancesOffline] summary snapshot discarded — loan/folder rate changed');
      return null;
    }
    return rec;
  } catch (error) {
    console.error('[SquareBalancesOffline] Error reading summary snapshot:', error);
    return null;
  }
};

/**
 * Rebuild the in-memory summary shape from a stored payload. Unknown/missing
 * keys fall back to empty Maps so a partially-written snapshot can never crash
 * the badge.
 */
export const deserializeSummary = (payload) => {
  const map = (v) => new Map(Array.isArray(v) ? v : []);
  if (!payload || typeof payload !== 'object') return null;
  return {
    byLocId: map(payload.byLocId),
    payoutsByLoc: map(payload.payoutsByLoc),
    storeToLoc: map(payload.storeToLoc),
    weeklyByStore: map(payload.weeklyByStore),
    storeNames: map(payload.storeNames),
    dailyRemainingByStore: map(payload.dailyRemainingByStore),
    codOutstandingDetailed: payload.codOutstandingDetailed || {},
    config: payload.config || null,
    configRecordId: payload.configRecordId || null,
    deliveryCredits: map(payload.deliveryCredits),
    sales: Array.isArray(payload.sales) ? payload.sales : [],
    payouts: Array.isArray(payload.payouts) ? payload.payouts : [],
    savedAt: payload.savedAt || null,
  };
};

export const purgeSummarySnapshot = async () => {
  try {
    await offlineDB.clearStore(SUMMARY_STORE);
    return { success: true };
  } catch (error) {
    console.error('[SquareBalancesOffline] Error purging summary snapshot:', error);
    return { success: false, error: error.message };
  }
};

// ── Ledger windows cache (Oct 2 2026, "100% offline-first" owner request) ──
// The summary snapshot above renders INSTANTLY, but every refresh still re-
// fetched the SAME SquareLedgerEntry windows from the entity API (card sales
// pages, payout pages, cod_collection scan, unlinked-ring window) — 5-8 calls
// per run, and during boot those calls joined the platform rate-limit storm
// (owner report: red/orange heartbeat dots at every app open, 429s in console).
// Ledger rows only change via squareLedgerSync (page sync / backend), so the
// badge caches the fetched windows in IDB and serves refreshes from them. The
// cache is invalidated by: true-up change (trued_up_at mismatch), a 10-minute
// TTL, or a SquareLedgerEntry WS broadcast. Ledger rows are Square financial
// data, not PHI and not user-scoped — one shared record per device.
const LEDGER_WINDOWS_ID = 'ledger_windows';
// Schema stamp for the cached ledger windows. Bump this whenever ledger ROWS
// themselves are corrected server-side (e.g. a rate fix re-stamped loan_cents):
// every device then treats its cached copy as a miss and refetches the real
// rows once, instead of serving stale money math for the 10-minute TTL.
const LEDGER_WINDOWS_SCHEMA = 2;

export const saveLedgerWindows = async (windows, userId = null) => {
  try {
    const record = {
      id: LEDGER_WINDOWS_ID,
      user_id: userId || null,
      saved_at: new Date().toISOString(),
      schema: LEDGER_WINDOWS_SCHEMA,
      trued_up_at: windows?.trued_up_at || null,
      sales: Array.isArray(windows?.sales) ? windows.sales : [],
      payouts: Array.isArray(windows?.payouts) ? windows.payouts : [],
      cod_sales: Array.isArray(windows?.cod_sales) ? windows.cod_sales : [],
      window_sales: Array.isArray(windows?.window_sales) ? windows.window_sales : [],
      window_since: windows?.window_since || null,
      evidence_sales: Array.isArray(windows?.evidence_sales) ? windows.evidence_sales : [],
      evidence_declines: Array.isArray(windows?.evidence_declines) ? windows.evidence_declines : [],
      evidence_since: windows?.evidence_since || null,
    };
    await offlineDB.save(SUMMARY_STORE, record);
    return { success: true };
  } catch (error) {
    console.error('[SquareBalancesOffline] Error saving ledger windows:', error);
    return { success: false, error: error.message };
  }
};

// User-scoped like the summary snapshot: the windows are whatever the last
// signed-in user's badge fetched — never serve them across accounts.
export const getLedgerWindows = async (userId = null) => {
  try {
    const rec = await offlineDB.getById(SUMMARY_STORE, LEDGER_WINDOWS_ID);
    if (!rec?.saved_at) return null;
    if (Number(rec.schema || 0) !== LEDGER_WINDOWS_SCHEMA) return null; // stale schema → refetch
    if (rec.user_id && userId && rec.user_id !== userId) return null;
    if (!rec.user_id && userId) return null; // anonymous record after a named session — refuse
    return rec;
  } catch (error) {
    console.error('[SquareBalancesOffline] Error reading ledger windows:', error);
    return null;
  }
};

export const purgeLedgerWindows = async () => {
  try {
    // offlineDB has no single-record delete — overwrite the record with an
    // unservable tombstone (trued_up_at null fails the cache guard, saved_at
    // epoch fails the TTL guard). Never clearStore(): that would also wipe
    // the summary snapshot next to it in this store.
    await offlineDB.save(SUMMARY_STORE, {
      id: LEDGER_WINDOWS_ID,
      saved_at: new Date(0).toISOString(),
      trued_up_at: null,
      sales: [], payouts: [], cod_sales: [], window_sales: [],
    });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
};
