import React from 'react';

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

/**
 * Wipe the ledger cache entirely (store + last-sync marker).
 * Owner directive (Sep 24 2026): the Square finance audit IDB cache exists
 * ONLY for the app owner's devices, for faster historical loading. Data is
 * written solely from the owner-gated SquareSyncAudit page; this purge
 * guarantees non-owner accounts never retain ledger bytes — including on
 * devices shared with the owner (logout/login handoff).
 */
export const purgeLedgerEntriesOffline = async () => {
  try {
    await offlineDB.clearStore(LEDGER_STORE);
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(LAST_SYNC_KEY);
    }
    return { success: true };
  } catch (error) {
    console.error('[SquareLedgerOffline] Error purging ledger entries:', error);
    return { success: false, error: error.message };
  }
};

// Owner identity mirrors the SquareSyncAudit page gate: platform App Owner
// role, or the owner's accounts by email.
const isLedgerCacheOwner = (user) => {
  if (!user) return false;
  const email = String(user.email || '').toLowerCase();
  return user.role === 'admin' || email === 'tauberr1328' || email === 'the.wizard@live.ca';
};

/**
 * Global guard: whenever a NON-owner account is active, wipe the ledger cache.
 * Mounted once from GlobalOverlays so it covers every page and every session.
 * The empty `square_ledger` object store itself still exists on all devices
 * (IDB schema upgrades run before login is known) but costs ~nothing; this
 * guard ensures it never holds data for anyone but the owner.
 */
export const useSquareLedgerCacheGuard = (currentUser) => {
  const userId = currentUser?.id || null;
  const isOwner = isLedgerCacheOwner(currentUser);
  React.useEffect(() => {
    if (userId && !isOwner) {
      purgeLedgerEntriesOffline();
    }
  }, [userId, isOwner]);
};
