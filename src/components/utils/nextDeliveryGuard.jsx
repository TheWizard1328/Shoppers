// ── Next-delivery flag self-heal (owner report Oct 30 2026) ──────────────────
//
// OWNER REPORT: "I had a yellow status marker for my next stop, a polyline drawn
// to it, map cycle FAB phase 2 locked to that stop. Then I switched to another
// driver's route, made some changes to THEIR route, came back to mine and the
// isNextDelivery flag was gone — it would not lock back to phase 2 and the FAB
// fell back to phase one."
//
// Root causes already fixed at the source (v15): a mid-route optimization with no
// current flag used to stamp isNextDelivery:false on EVERY stop, so the route lost
// its next stop and later runs reinforced the wipe. This module is the belt-and-
// braces guard: whatever path clears the flag (a bulk write from another driver's
// flow, a stale IDB mirror, a duty-toggle sweep, an unknown writer), the driver's
// own route is never left with ZERO next stops while it still has work on it.
//
// Rules (kept deliberately narrow so it can never fight real intent):
//   • only heals a route with NO isNextDelivery=true anywhere
//   • only when at least one stop is still active (not completed/failed/cancelled)
//   • never moves an existing flag, never touches a finished route
//   • promotes the same stop the engines would: accepted (non-pending) before
//     pending, non-interstore before ISP/ISD, lowest stop_order first
//   • local write + server write + deliveriesUpdated so every view converges

import { offlineDB } from './offlineDatabase';
import { updateDeliveryLocal } from './offlineMutations';
import { canThisDeviceRestoreNextFlag, stampNextFlagOwner, parseFlagOwner } from './nextFlagOwnership';
import { isEntityDead, markEntityDead } from './deadEntityGuard';

const TERMINAL = ['completed', 'failed', 'cancelled'];
const isInterStoreId = (id) => String(id || '').startsWith('ISP') || String(id || '').startsWith('ISD');

const orderOf = (d) => {
  const n = Number(d?.stop_order);
  return Number.isFinite(n) ? n : 99999;
};

// ── OWNER REPORT (Nov 12 2026): "three devices keep fixing the same flag" ────
// The restore is a WRITE, and every device running a dashboard was willing to
// perform it. Robert's route was restored 12 times in one hour on the SAME stop
// from the editor desktop, The-Tablet and Londonderry - each one read a local
// copy that was a moment behind, saw no next stop and stamped its own pick.
//
// Two rules now bound it:
//   1. Only a PRIMARY device may restore. window.__isPrimaryDevice is set by
//      Dashboard.jsx from the device registry (is_primary_tracker plus status).
//      Secondary phones, the editor desktop and tablets all resolve false, so
//      they only ever DISPLAY the flag the primary wrote - they never write it.
//      `undefined` (very first boot, before the registry resolved) still heals,
//      so a genuine first-route restore is never lost.
//   2. One restore per stop per 5 minutes, per device. Even a primary device
//      cannot re-stamp the same stop in a loop while the write is in flight.
const RESTORE_COOLDOWN_MS = 5 * 60 * 1000;
const recentRestores = new Map();

const isPrimaryWriterDevice = () => {
  if (typeof window === 'undefined') return true;
  const flag = window.__isPrimaryDevice;
  if (flag === true) return true;
  if (flag === false) return false;
  return true; // not resolved yet - keep the original healing behaviour
};

const recentlyRestored = (key) => {
  const at = recentRestores.get(key);
  if (!at) return false;
  if (Date.now() - at < RESTORE_COOLDOWN_MS) return true;
  recentRestores.delete(key);
  return false;
};

export function pickNextStopCandidate(routeDeliveries = []) {
  // A stop whose server record 404'd can never be the next stop: promoting it
  // just re-queues a dead write (owner report Nov 22 2026).
  const active = routeDeliveries.filter(
    (d) => d && d.id && !TERMINAL.includes(String(d.status || '').toLowerCase()) && !isEntityDead(d.id)
  );
  if (active.length === 0) return null;
  const nonInterStore = active.filter((d) => !isInterStoreId(d.delivery_id));
  const pool = nonInterStore.length > 0 ? nonInterStore : active;
  const accepted = pool.filter((d) => String(d.status || '').toLowerCase() !== 'pending');
  const candidates = accepted.length > 0 ? accepted : pool;
  return [...candidates].sort((a, b) => orderOf(a) - orderOf(b))[0] || null;
}

/**
 * Ensure a driver's route has exactly one next stop.
 * Returns the promoted delivery id, or null when nothing needed doing.
 *
 * `deliveries` — optional pre-loaded list (skips the IDB read).
 * `skipServerWrite` — IDB + UI only (used by read-only/viewer surfaces).
 */
/**
 * Clear the next-delivery flag from any FINISHED stop on a driver's route.
 *
 * OWNER REPORT (Nov 2 2026): "two stops with the next delivery flag, including
 * my very first stop which has been completed already". A completed / failed /
 * cancelled stop can never be the next stop, but every refresh path (pull,
 * queued replay, snapshot, background sync) happily re-wrote a stale copy that
 * still carried the flag. offlineDatabase now refuses to store the flag on a
 * terminal record; this heals rows that are ALREADY wrong in IndexedDB and on
 * the server, and it runs on every route guard pass.
 *
 * Returns the ids it cleared.
 */
export async function clearTerminalNextFlags({
  driverId,
  deliveryDate,
  deliveries = null,
  skipServerWrite = false,
} = {}) {
  const cleared = [];
  try {
    if (!driverId || !deliveryDate) return cleared;
    let list = Array.isArray(deliveries) ? deliveries : null;
    if (!list) list = await offlineDB.getAll(offlineDB.STORES.DELIVERIES);
    const stale = (list || []).filter(
      (d) => d && d.id && d.isNextDelivery === true &&
        d.driver_id === driverId && d.delivery_date === deliveryDate &&
        TERMINAL.includes(String(d.status || '').toLowerCase())
    );
    for (const d of stale) {
      await updateDeliveryLocal(d.id, { isNextDelivery: false, next_flag_owner: null }, { skipSmartRefresh: true });
      cleared.push(d.id);
    }
    if (cleared.length > 0 && !skipServerWrite) {
      const { base44 } = await import('@/api/base44Client');
      for (const id of cleared) {
        base44.entities.Delivery.update(id, { isNextDelivery: false, next_flag_owner: null }).catch(() => {});
      }
    }
    if (cleared.length > 0) {
      console.warn(`[NextDeliveryGuard] cleared next-delivery flag from ${cleared.length} finished stop(s) on ${driverId}/${deliveryDate}`);
    }
  } catch (err) {
    console.warn('[NextDeliveryGuard] clearTerminalNextFlags failed:', err?.message || err);
  }
  return cleared;
}

/**
 * ONE next stop, never two.
 *
 * OWNER REPORT (Nov 20 2026): "I click Start on another stop and the previous
 * stop that had the next-delivery flag doesn't get cleared — I end up with two
 * stops marked next, and it survives a refresh and a full restart."
 *
 * The Start path's server CLEAR of the previous holder could be dropped by the
 * route-commit guard (fixed in routeCommitMarker: a batch that promotes another
 * stop on the route is a real advance). This is the belt-and-braces sweep: if a
 * route ever holds TWO flags, keep the one that matches reality and clear the
 * rest. Winner order: a STARTED stop (en_route / in_transit) first, then the
 * newest next_flag_owner claim, then the lowest stop_order.
 *
 * Returns the ids it cleared.
 */
export async function clearDuplicateNextFlags({
  driverId,
  deliveryDate,
  deliveries = null,
  skipServerWrite = false,
} = {}) {
  const cleared = [];
  try {
    if (!driverId || !deliveryDate) return cleared;
    let list = Array.isArray(deliveries) ? deliveries : null;
    if (!list) list = await offlineDB.getAll(offlineDB.STORES.DELIVERIES);
    const flagged = (list || []).filter(
      (d) => d && d.id && d.isNextDelivery === true &&
        d.driver_id === driverId && d.delivery_date === deliveryDate
    );
    if (flagged.length < 2) return cleared;

    const rank = (d) => {
      const started = ['en_route', 'in_transit'].includes(String(d.status || '').toLowerCase()) ? 1 : 0;
      const claim = parseFlagOwner(d.next_flag_owner);
      return { started, at: claim?.at || 0, order: orderOf(d) };
    };
    const sorted = [...flagged].sort((a, b) => {
      const ra = rank(a); const rb = rank(b);
      if (ra.started !== rb.started) return rb.started - ra.started; // started stop wins
      if (ra.at !== rb.at) return rb.at - ra.at;                     // newest claim next
      return ra.order - rb.order;                                    // then route order
    });
    const keep = sorted[0];
    for (const d of sorted.slice(1)) {
      // RELEASE THE CLAIM TOO (owner report Nov 22 2026): clearing only the flag
      // left next_flag_owner on the record, so newestRouteFlagOwner kept seeing a
      // stale claim from a finished stop and every OTHER device refused to
      // restore - the route sat with no next stop and the guard churned.
      await updateDeliveryLocal(d.id, { isNextDelivery: false, next_flag_owner: null }, { skipSmartRefresh: true });
      cleared.push(d.id);
      if (!skipServerWrite) {
        try {
          const { base44 } = await import('@/api/base44Client');
          await base44.entities.Delivery.update(d.id, { isNextDelivery: false, next_flag_owner: null }).catch(() => null);
        } catch (_) { /* offline — queued mutation carries it */ }
      }
    }
    if (cleared.length > 0) {
      console.warn(`[NextDeliveryGuard] ${flagged.length} stops held the next-delivery flag on ${driverId}/${deliveryDate} — kept ${keep.id}, cleared ${cleared.length}`);
    }
  } catch (err) {
    console.warn('[NextDeliveryGuard] clearDuplicateNextFlags failed:', err?.message || err);
  }
  return cleared;
}

/**
 * DUTY-STATUS SUPPRESSION (owner report Nov 20 2026).
 *
 * "I just put myself on break and the next-delivery flag for my next stop
 * looked like it was cleared, but then after a refresh or switching pages and
 * coming back to the dashboard that stop is marked next again even though I'm
 * still on break."
 *
 * Going on break / off duty clears the flag ON PURPOSE (DriverStatusToggle +
 * setDriverStatus). The guard only ever looked at the route, so an empty flag
 * read as damage and it put the flag straight back on the next refresh. While
 * the driver's own duty status is on_break or off_duty, an empty next flag is
 * CORRECT: leave it alone. Coming back on duty re-arms the flag itself in
 * DriverStatusToggle, so nothing is lost by staying quiet here.
 */
async function routeIsDutySuppressed(driverId) {
  try {
    const rec = await offlineDB.getById(offlineDB.STORES.APP_USERS, driverId).catch(() => null);
    const status = String(rec?.driver_status || '').toLowerCase();
    if (status !== 'on_break' && status !== 'off_duty') return false;
    // Safety valve: a stale local copy must not disable the heal forever. A
    // real break is stamped by the toggle, so anything older than 12h is
    // treated as unknown rather than as a live break.
    const stamp = rec?.driver_status_updated_at || rec?.updated_date || '';
    const at = Date.parse(stamp);
    if (Number.isFinite(at) && Date.now() - at > 12 * 60 * 60 * 1000) return false;
    return true;
  } catch (_) {
    return false; // never block the heal on a read error
  }
}

export async function ensureRouteHasNextStop({
  driverId,
  deliveryDate,
  deliveries = null,
  source = 'nextDeliveryGuard',
  skipServerWrite = false,
} = {}) {
  try {
    if (!driverId || !deliveryDate) return null;
    // Heal first: finished stops must never hold the flag (owner report Nov 2 2026).
    await clearTerminalNextFlags({ driverId, deliveryDate, deliveries, skipServerWrite });
    // Then: a route may hold at most ONE next stop (owner report Nov 20 2026).
    const _dupCleared = await clearDuplicateNextFlags({ driverId, deliveryDate, deliveries, skipServerWrite });

    let list = Array.isArray(deliveries) ? deliveries : null;
    // A duplicate sweep just changed flags — always re-read so the check below
    // sees the healed route instead of the caller's stale snapshot.
    if (!list || _dupCleared.length > 0) {
      list = await offlineDB.getAll(offlineDB.STORES.DELIVERIES);
    }
    const route = (list || []).filter(
      (d) => d && d.driver_id === driverId && d.delivery_date === deliveryDate
    );
    if (route.length === 0) return null;
    // Already flagged (any stop, including one the optimizer just promoted).
    // A flag sitting on a record the server deleted is not a real next stop —
    // otherwise the route looks healthy while every write for it 404s.
    if (route.some((d) => d?.isNextDelivery === true && !isEntityDead(d.id))) return null;

    // On break / off duty an EMPTY flag is deliberate — never restore it
    // (owner report Nov 20 2026).
    if (await routeIsDutySuppressed(driverId)) return null;

    // OWNER DIRECTION (Nov 12 2026): the device that SET the flag owns it.
    // Dispatchers/admins take ownership the moment they change it themselves;
    // otherwise the driver's own device keeps it. Devices that are only watching
    // no longer get to repair, which is what ended the 12-restores-an-hour loop.
    if (!canThisDeviceRestoreNextFlag(route)) {
      return null;
    }

    const target = pickNextStopCandidate(route);
    if (!target) return null; // finished / nothing active — leave it alone

    const restoreKey = `${driverId}|${deliveryDate}|${target.id}`;
    if (recentlyRestored(restoreKey)) return null;

    // The restore itself transfers ownership to this device, so a following run
    // on the same route agrees with it instead of re-picking.
    const restorePayload = stampNextFlagOwner({ isNextDelivery: true });
    await updateDeliveryLocal(target.id, restorePayload, { skipSmartRefresh: true });
    recentRestores.set(restoreKey, Date.now());
    if (!skipServerWrite) {
      try {
        const { base44 } = await import('@/api/base44Client');
        await base44.entities.Delivery.update(target.id, restorePayload).catch(async (err) => {
          const { isEntityNotFoundError } = await import('./deadEntityGuard');
          if (isEntityNotFoundError(err)) markEntityDead(target.id);
        });
      } catch (_) { /* offline — IDB + queued mutation carry it */ }
    }

    try {
      window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
        detail: {
          triggeredBy: 'nextDeliveryGuard',
          driverId,
          deliveryDate,
          source,
          restoredStopId: target.id,
          preserveLocalState: true,
        },
      }));
    } catch (_) {}

    console.warn(
      `[nextDeliveryGuard] route ${driverId} ${deliveryDate} had NO next stop (source=${source}) — restored isNextDelivery on stop ${target.id} (order ${orderOf(target)})`
    );
    return target.id;
  } catch (err) {
    console.warn('[nextDeliveryGuard] self-heal skipped:', err?.message || err);
    return null;
  }
}
