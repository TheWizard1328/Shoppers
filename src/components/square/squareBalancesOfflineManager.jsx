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
export const getSummarySnapshot = async () => {
  try {
    const rec = await offlineDB.getById(SUMMARY_STORE, RECORD_ID);
    return rec && rec.payload ? rec : null;
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
