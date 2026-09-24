// Offline cache for Square finance-audit ledger entries (SquareLedgerEntry entity).
// Mirrors the squareCODOfflineManager pattern: server data is authoritative,
// IDB is a render-first snapshot written after each successful fetch/sync.
import { offlineDB } from './offlineDatabase';

const LEDGER_STORE = offlineDB.STORES.SQUARE_LEDGER;
const LAST_SYNC_KEY = 'square_ledger_last_sync_at';

export const saveLedgerEntriesOffline = async (entries) => {
  try {
    const records = (entries || []).filter(Boolean);
    await offlineDB.clearStore(LEDGER_STORE);
    if (records.length > 0) {
      await offlineDB.bulkSave(LEDGER_STORE, records);
    }
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(LAST_SYNC_KEY, new Date().toISOString());
    }
    return { success: true, count: records.length };
  } catch (error) {
    console.error('[SquareLedgerOffline] Error saving ledger entries:', error);
    return { success: false, error: error.message };
  }
};

export const getLedgerEntriesOffline = async () => {
  try {
    const records = await offlineDB.getAll(LEDGER_STORE);
    return records || [];
  } catch (error) {
    console.error('[SquareLedgerOffline] Error reading ledger entries:', error);
    return [];
  }
};

export const getLedgerLastSyncAt = () => {
  try {
    return localStorage.getItem(LAST_SYNC_KEY) || null;
  } catch {
    return null;
  }
};
