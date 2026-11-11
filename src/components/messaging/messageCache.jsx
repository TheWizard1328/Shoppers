/**
 * messageCache — offline-first chat store (owner directive Nov 4 2026).
 *
 * "are the message data being loaded from online DB's or IDB??? It should be
 *  IDB load and IDB & Online save with a broadcast of the read status and sent
 *  messages..."
 *
 * Every chat row this user may see lives in the `messages` IndexedDB store.
 * READ  → IndexedDB only. A network read happens at most once every
 *         NETWORK_REFRESH_MS per scope, in the background, never on a tab or
 *         thread switch.
 * WRITE → local row first (instant UI), then the server; the server id replaces
 *         the local temp id and the row is re-cached.
 * WS    → a received row is cached and a `rxdeliver:messages:changed` event
 *         tells any open panel to repaint from IndexedDB (no network).
 */
import { base44 } from '@/api/base44Client';
import { offlineDB } from '@/components/utils/offlineDatabase';

const STORE = offlineDB.STORES.MESSAGES;
const NETWORK_REFRESH_MS = 5 * 60 * 1000; // one background read per scope / 5 min
const CHANGE_EVENT = 'rxdeliver:messages:changed';
const refreshAt = new Map(); // scope key -> last network read

const authIdOf = (user) => user?.user_id || user?.id || null;

/**
 * A driver↔patient thread is private to that driver. Everyone sees the shared
 * store thread (no driver_id) plus ONLY their own driver thread — this is what
 * stopped another driver's patient chat appearing in Robert's panel.
 */
export function isVisibleToUser(message, user) {
  if (!message) return false;
  if (!message.driver_id) return true;
  const mine = authIdOf(user);
  return !!mine && String(message.driver_id) === String(mine);
}

export function filterVisible(rows, user) {
  return (rows || []).filter((m) => isVisibleToUser(m, user));
}

export function notifyMessagesChanged(detail = {}) {
  try {
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail }));
  } catch { /* noop */ }
}

export function onMessagesChanged(handler) {
  const listener = (e) => handler?.(e?.detail || {});
  window.addEventListener(CHANGE_EVENT, listener);
  return () => window.removeEventListener(CHANGE_EVENT, listener);
}

/** Cache rows locally (newest wins). Never throws. */
export async function cacheMessages(rows) {
  const list = (Array.isArray(rows) ? rows : [rows]).filter((r) => r && r.id);
  if (list.length === 0) return;
  try {
    await offlineDB.bulkSave(STORE, list, { silent: true });
  } catch {
    try { for (const row of list) await offlineDB.save(STORE, row, { silent: true }); } catch { /* noop */ }
  }
}

export async function patchCachedMessage(id, patch) {
  if (!id) return null;
  try {
    const existing = await offlineDB.getById(STORE, id);
    if (!existing) return null;
    const next = { ...existing, ...patch };
    await offlineDB.save(STORE, next, { silent: true });
    return next;
  } catch { return null; }
}

/** All cached chat rows, newest first. Pure IndexedDB, no network. */
export async function readCachedMessages(user = null) {
  try {
    const rows = await offlineDB.getAll(STORE);
    const list = (rows || []).filter((r) => r && r.id);
    list.sort((a, b) => new Date(b.created_date || 0) - new Date(a.created_date || 0));
    return user ? filterVisible(list, user) : list;
  } catch { return []; }
}

export async function readCachedPatientThread(patientId, user = null) {
  if (!patientId) return [];
  try {
    const rows = await offlineDB.getByIndex(STORE, 'patient_id', patientId);
    const list = user ? filterVisible(rows || [], user) : (rows || []);
    list.sort((a, b) => new Date(a.created_date || 0) - new Date(b.created_date || 0));
    return list;
  } catch { return []; }
}

/**
 * Read one conversation out of the local mirror.
 *
 * HISTORY (fix Nov 10 2026, owner report: "clicking a thread shows no messages
 * even though the thread cards show a recent date stamp for today"): the
 * messages store is PHI-encrypted, and its index fields were not carried in
 * plaintext, so the conversation_id index held nothing and every open fell
 * through to a network read. A throttled/failed read then painted an empty
 * thread. Three defences now live here:
 *   1. index read, then a plain scan of the store filtered by conversation_id
 *      (rescues rows cached before the index fix),
 *   2. a sender/receiver pair read when the conversation id turns up nothing,
 *   3. rows are stamped with their conversation_id before caching, so the index
 *      keeps working for every future open.
 */
export async function loadConversationMessages({ conversationId, otherUserId = null, currentUserId = null, limit = 500, force = false }) {
  if (!conversationId) return [];

  const byDate = (a, b) => new Date(a.created_date || 0) - new Date(b.created_date || 0);
  const matchesConversation = (m) => String(m?.conversation_id || '') === String(conversationId);

  const readCache = async () => {
    let rows = [];
    try {
      rows = await offlineDB.getByIndex(STORE, 'conversation_id', conversationId);
    } catch { rows = []; }
    if (!rows || rows.length === 0) {
      // Index miss (legacy encrypted rows) — scan and filter instead.
      try {
        const all = await offlineDB.getAll(STORE);
        rows = (all || []).filter(matchesConversation);
      } catch { rows = []; }
    }
    return (rows || []).filter(Boolean).sort(byDate);
  };

  let cached = await readCache();

  const scope = `conversation:${conversationId}:${otherUserId || ''}`;
  const refresh = async () => {
    try {
      let rows = await base44.entities.Message.filter({ conversation_id: conversationId }, '-created_date', limit).catch(() => null);
      if (!rows || rows.length === 0) {
        // Legacy rows may not carry a conversation_id — fall back to the
        // participant pair so a 1:1 thread can never open empty.
        const pair = [];
        if (currentUserId && otherUserId) {
          pair.push(...(await base44.entities.Message.filter({ sender_id: currentUserId, receiver_id: otherUserId }, '-created_date', limit).catch(() => []) || []));
          pair.push(...(await base44.entities.Message.filter({ sender_id: otherUserId, receiver_id: currentUserId }, '-created_date', limit).catch(() => []) || []));
        }
        rows = pair;
      }
      const list = (rows || []).filter(Boolean).map((m) => (m.conversation_id ? m : { ...m, conversation_id: conversationId }));
      await cacheMessages(list);
      notifyMessagesChanged({ conversationId });
      return list.sort(byDate);
    } catch { return null; }
  };

  if (!force && cached.length > 0) {
    if (shouldNetworkRefresh(scope)) refresh().catch(() => {});
    return cached;
  }
  const fresh = await refresh();
  return (fresh && fresh.length > 0 ? fresh : cached) || [];
}

const PRUNE_STAMP = 'rxdeliver_messages_pruned_at';
const PRUNE_KEEP = 3000;

/**
 * Keep the local chat mirror bounded: newest PRUNE_KEEP rows survive, and the
 * sweep runs at most once a day. Server history is untouched.
 */
export async function pruneMessageCache() {
  try {
    const last = Number(localStorage.getItem(PRUNE_STAMP) || 0);
    if (Date.now() - last < 24 * 60 * 60 * 1000) return 0;
    localStorage.setItem(PRUNE_STAMP, String(Date.now()));
    const rows = await offlineDB.getAll(STORE);
    if ((rows || []).length <= PRUNE_KEEP) return 0;
    const ordered = (rows || []).sort((a, b) => new Date(b.created_date || 0) - new Date(a.created_date || 0));
    const doomed = ordered.slice(PRUNE_KEEP);
    for (const row of doomed) await offlineDB.deleteRecord(STORE, row.id);
    return doomed.length;
  } catch { return 0; }
}

/** Local, temporary id for a message that has not reached the server yet. */
export const tempMessageId = () => `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * True when this scope may run a background network refresh. Debounces so tab
 * switching and thread switching never hammer the entity API.
 */
export function shouldNetworkRefresh(scopeKey, minIntervalMs = NETWORK_REFRESH_MS) {
  const last = refreshAt.get(scopeKey) || 0;
  if (Date.now() - last < minIntervalMs) return false;
  refreshAt.set(scopeKey, Date.now());
  return true;
}

export function markNetworkRefresh(scopeKey) {
  refreshAt.set(scopeKey, Date.now());
}

export function resetNetworkRefresh(scopeKey) {
  if (scopeKey) refreshAt.delete(scopeKey);
  else refreshAt.clear();
}

/**
 * The visible patient threads for a staff member. Cache first; a network read
 * only happens when the cache is cold or the 5-minute window has passed.
 */
export async function loadPatientThreads({ user, storeIds = [], seeAllStores = false, limit = 300, driverOnly = false }) {
  const uid = authIdOf(user);
  const scope = `patient-threads:${driverOnly ? `driver:${uid}` : seeAllStores ? 'all' : storeIds.slice().sort().join(',')}`;

  const cachedAll = await readCachedMessages(null);
  const cached = cachedAll.filter((m) => {
    if (!m?.patient_id) return false;
    if (!isVisibleToUser(m, user)) return false;
    if (driverOnly) return String(m.driver_id || '') === String(uid || '');
    if (seeAllStores || storeIds.length === 0) return true;
    return storeIds.includes(m.store_id);
  });

  if (cached.length > 0) {
    if (shouldNetworkRefresh(scope)) {
      refreshPatientThreads({ user, storeIds, seeAllStores, limit, driverOnly }).catch(() => {});
    }
    return cached;
  }

  const fresh = await refreshPatientThreads({ user, storeIds, seeAllStores, limit, driverOnly });
  // Cold cache AND a failed read = "unknown", never "no threads": the panel must
  // keep what it already shows instead of blanking.
  if (fresh === null) return null;
  return filterVisible(fresh, user).filter((m) => m?.patient_id);
}

/** One network read of the scope, cached locally. Returns the rows or null. */
async function refreshPatientThreads({ user, storeIds, seeAllStores, limit, driverOnly }) {
  const uid = authIdOf(user);
  try {
    if (driverOnly) {
      const rows = await base44.entities.Message.filter({ driver_id: uid }, '-created_date', limit);
      const list = (rows || []).filter((m) => m?.patient_id);
      await cacheMessages(list);
      return list;
    }
    if (seeAllStores || storeIds.length === 0) {
      const all = await base44.entities.Message.filter({}, '-created_date', limit);
      const list = (all || []).filter((m) => m?.patient_id);
      await cacheMessages(list);
      return list;
    }
    const batches = await Promise.all(
      storeIds.map((storeId) =>
        base44.entities.Message.filter({ store_id: storeId }, '-created_date', limit).then((r) => r).catch(() => null)
      )
    );
    if (batches.every((b) => b === null)) return null;
    const list = batches.filter(Boolean).flat().filter((m) => m?.patient_id);
    await cacheMessages(list);
    return list;
  } catch { return null; }
}

/** Cache-first read of one patient's whole thread. */
export async function loadPatientThread({ user, patientId, limit = 200, force = false }) {
  const cached = await readCachedPatientThread(patientId, user);
  const scope = `patient-thread:${patientId}:${authIdOf(user) || ''}`;
  const refresh = async () => {
    try {
      const rows = await base44.entities.Message.filter({ patient_id: patientId }, '-created_date', limit);
      const list = (rows || []).filter((m) => m?.patient_id);
      await cacheMessages(list);
      notifyMessagesChanged({ patientId });
      return filterVisible(list, user).sort((a, b) => new Date(a.created_date || 0) - new Date(b.created_date || 0));
    } catch { return null; }
  };

  if (!force && cached.length > 0) {
    if (shouldNetworkRefresh(scope)) refresh().catch(() => {});
    return cached;
  }
  const fresh = await refresh();
  return fresh || cached;
}

/**
 * Cache a message that was just written to the server. `localId` is the temp id
 * of the optimistic row it replaces.
 */
export async function commitSentMessage(row, localId = null) {
  if (!row?.id) return;
  try { if (localId) await offlineDB.deleteRecord(STORE, localId); } catch { /* noop */ }
  await cacheMessages([row]);
  notifyMessagesChanged({ sent: true });
}

/** Mark cached rows read locally, then push the flag to the server quietly. */
export async function markThreadRead(rows = []) {
  const pending = (rows || []).filter((m) => !m.read);
  if (pending.length === 0) return 0;
  for (const m of pending) await patchCachedMessage(m.id, { read: true });
  notifyMessagesChanged({ read: true });
  await Promise.all(pending.map((m) => base44.entities.Message.update(m.id, { read: true }).catch(() => {})));
  return pending.length;
}
