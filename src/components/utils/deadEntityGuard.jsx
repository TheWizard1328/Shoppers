/**
 * deadEntityGuard.jsx — stop retrying writes for records the server has deleted.
 *
 * OWNER REPORT (Nov 22 2026, hourly digests): the Kingsway dashboard kept
 * re-flagging stop 6b033b9b on Mathew's route. The stop no longer exists
 * server-side, so every isNextDelivery / next_flag_owner write came back
 * "Entity Delivery with ID ... not found" (404). The queued mutation was
 * RETAINED (that is the normal, correct behaviour for a network failure), so the
 * same dead write retried forever: guard restores the flag locally, server 404s,
 * mutation retained, repeat. It also kept the dead row alive in IndexedDB, so
 * nextDeliveryGuard picked it as the next stop every pass.
 *
 * A 404 "not found" is not a transient failure — the record is gone. This module
 * classifies that error, remembers the ids so the guard stops picking them, and
 * provides the drop helper (local row + queued mutation) used by both write
 * paths.
 *
 * The dead set is persisted (localStorage) with a 24h TTL so a reload does not
 * resurrect the loop, but a genuinely re-created record id can be picked up
 * again tomorrow. Ids are also dropped from the set when a write for them
 * succeeds.
 */

const STORAGE_KEY = 'rx_dead_entity_ids_v1';
const TTL_MS = 24 * 60 * 60 * 1000;

let cache = null;

const load = () => {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    cache = parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    cache = {};
  }
  return cache;
};

const save = () => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(load()));
  } catch (_) { /* storage full / private mode — in-memory set still works */ }
};

/** True when the error means "this record does not exist on the server". */
export function isEntityNotFoundError(error) {
  if (!error) return false;
  const status = Number(
    error?.status || error?.statusCode || error?.response?.status || error?.cause?.status || 0
  );
  if (status === 404) return true;
  const msg = String(error?.message || error?.detail || error || '').toLowerCase();
  if (!msg) return false;
  // Base44: "Entity Delivery with ID 6b033b9b... not found"
  return msg.includes('not found') && (msg.includes('entity') || msg.includes('with id'));
}

/** Remember that this id no longer exists server-side. */
export function markEntityDead(id) {
  if (!id) return;
  const map = load();
  map[String(id)] = Date.now();
  save();
}

/** Forget an id (its write succeeded, or the record came back). */
export function clearEntityDead(id) {
  if (!id) return;
  const map = load();
  if (!(String(id) in map)) return;
  delete map[String(id)];
  save();
}

/** Has this id been marked dead within the TTL? */
export function isEntityDead(id) {
  if (!id) return false;
  const map = load();
  const at = map[String(id)];
  if (!at) return false;
  if (Date.now() - at > TTL_MS) {
    delete map[String(id)];
    save();
    return false;
  }
  return true;
}

/**
 * A 404 landed for this record: mark it dead, drop its queued mutation and its
 * local row so nothing retries it and no view keeps rendering a ghost.
 *
 * Returns true when the record was handled as dead.
 */
export async function dropDeadEntityMutation({ entity = 'Delivery', id, mutationId = null } = {}) {
  if (!id) return false;
  markEntityDead(id);
  try {
    const { offlineDB } = await import('./offlineDatabase');
    if (mutationId) await offlineDB.removePendingMutation(mutationId).catch(() => {});
    if (String(entity) === 'Delivery') {
      await offlineDB.deleteRecord(offlineDB.STORES.DELIVERIES, id).catch(() => {});
    }
  } catch (_) { /* offline DB unavailable — the dead marker still stops the loop */ }
  console.warn(`[deadEntityGuard] ${entity} ${id} no longer exists server-side (404) — dropped queued mutation and local row; it will not be retried`);
  return true;
}
