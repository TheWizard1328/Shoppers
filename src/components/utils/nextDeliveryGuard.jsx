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

const TERMINAL = ['completed', 'failed', 'cancelled'];
const isInterStoreId = (id) => String(id || '').startsWith('ISP') || String(id || '').startsWith('ISD');

const orderOf = (d) => {
  const n = Number(d?.stop_order);
  return Number.isFinite(n) ? n : 99999;
};

export function pickNextStopCandidate(routeDeliveries = []) {
  const active = routeDeliveries.filter(
    (d) => d && d.id && !TERMINAL.includes(String(d.status || '').toLowerCase())
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
export async function ensureRouteHasNextStop({
  driverId,
  deliveryDate,
  deliveries = null,
  source = 'nextDeliveryGuard',
  skipServerWrite = false,
} = {}) {
  try {
    if (!driverId || !deliveryDate) return null;

    let list = Array.isArray(deliveries) ? deliveries : null;
    if (!list) {
      list = await offlineDB.getAll(offlineDB.STORES.DELIVERIES);
    }
    const route = (list || []).filter(
      (d) => d && d.driver_id === driverId && d.delivery_date === deliveryDate
    );
    if (route.length === 0) return null;
    // Already flagged (any stop, including one the optimizer just promoted).
    if (route.some((d) => d?.isNextDelivery === true)) return null;

    const target = pickNextStopCandidate(route);
    if (!target) return null; // finished / nothing active — leave it alone

    await updateDeliveryLocal(target.id, { isNextDelivery: true }, { skipSmartRefresh: true });
    if (!skipServerWrite) {
      try {
        const { base44 } = await import('@/api/base44Client');
        await base44.entities.Delivery.update(target.id, { isNextDelivery: true }).catch(() => null);
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
