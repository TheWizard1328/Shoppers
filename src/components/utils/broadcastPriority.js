// ┌─────────────────────────────────────────────────────────────────────────────
// │ BROADCAST PRIORITY STAGING — owner spec Oct 15 2026                          │
// │                                                                             │
// │ A driver finishing a stop (or any delivery write) used to hit EVERY        │
// │ subscribed device simultaneously: decrypt + IDB write + UI reconcile all    │
// │ at once, saturating each device's single JS main thread — local IDB reads   │
// │ starved, timed out, and fell back to SERVER reads account-wide (the 429     │
// │ storms right after completions).                                            │
// │                                                                             │
// │ Instead of the server sending tiered broadcasts, each RECEIVING device     │
// │ self-sorts by importance and stages low-priority work (owner: "make it so   │
// │ the incoming broadcast on all devices gets delayed in propagation on those  │
// │ devices based on the device importance"):                                   │
// │                                                                             │
// │  P0 — immediate (old behavior):                                             │
// │   - the delivery's own driver's devices (driver_id === this user)            │
// │   - devices of the delivery's PRIMARY store (store_id ∈ user's store_ids)    │
// │   - devices actively viewing the driver (dashboard/overlay selection)        │
// │  P1 — ~15s:                                                                 │
// │   - devices of OTHER stores on that driver's route today                     │
// │     (owner: "other stores on a driver's route get primary importance         │
// │     after the primary store")                                                │
// │   - admin devices (owner desktop instances — timers/host duties unaffected) │
// │  P2 — ~45s jittered: everyone else (unrelated store PCs, other drivers)      │
// │                                                                             │
// │ Fail-open: anything unresolvable (no payload, no user context, errors)      │
// │ processes immediately exactly as before. Staged events apply through the    │
// │ SAME realtimeSync handler (all guards: echo suppression, deleted-registry,  │
// │ merge locks, relevance gates run unchanged at flush time). Queued events    │
// │ coalesce by record id (newest wins), flush on tier timer, on app becoming    │
// │ visible, or on queue overflow — and an immediate P0 event for a record      │
// │ drops its queued copies so a stale staged record can never overwrite the    │
// │ fresh one. Missed/dropped staged events converge at the next boot/delta     │
// │ sync like any other WS gap.                                                 │
// └─────────────────────────────────────────────────────────────────────────────

import { getCurrentDashboardSelection } from './deliveryCardUtils';

const P0 = 'P0';
const P1 = 'P1';
const P2 = 'P2';
export const BROADCAST_PRIORITY = { P0, P1, P2 };

const P1_BASE_DELAY_MS = 15000;
const P1_JITTER_MS = 5000;
const P2_BASE_DELAY_MS = 45000;
const P2_JITTER_MS = 15000;
const QUEUE_OVERFLOW_FLUSH = 400;
const LOG_MIN_INTERVAL_MS = 60000; // ≤ 1 defer line + 1 flush line per tier per minute

// tier state: ordered Map (record id → event payload), one timer per tier
const _tiers = {
  [P1]: { map: new Map(), timer: null, delayMs: P1_BASE_DELAY_MS, jitterMs: P1_JITTER_MS, lastLog: 0 },
  [P2]: { map: new Map(), timer: null, delayMs: P2_BASE_DELAY_MS, jitterMs: P2_JITTER_MS, lastLog: 0 },
};

let _flushHandler = null; // set by realtimeSync's Delivery subscription
export const setDeliveryStageFlushHandler = (fn) => { _flushHandler = typeof fn === 'function' ? fn : null; };

const _getEffectiveUser = () => {
  try {
    const cache = sessionStorage.getItem('effectiveUserCache');
    if (cache) return JSON.parse(cache);
  } catch (_) {}
  return null;
};

const _rolesOf = (eff) => {
  const roles = eff?.appUser?.app_roles || eff?.user?.app_roles;
  return Array.isArray(roles) ? roles : [];
};

const _userIdOf = (eff) => eff?.user?.id || eff?.appUser?.user_id || eff?.appUser?.id || null;

const _storeIdsOf = (eff) => {
  const ids = eff?.appUser?.store_ids || eff?.user?.store_ids;
  return Array.isArray(ids) ? ids.map(String) : null;
};

// Other stores the driver serves on the delivery's date (live app state — cheap).
const _driverRouteStores = (driverId, deliveryDate) => {
  try {
    const all = (typeof window !== 'undefined' && Array.isArray(window.__appDeliveries))
      ? window.__appDeliveries : [];
    const stores = new Set();
    for (const d of all) {
      if (!d || !d.store_id) continue;
      if (String(d.driver_id || '') !== String(driverId)) continue;
      if (deliveryDate && d.delivery_date && d.delivery_date !== deliveryDate) continue;
      stores.add(String(d.store_id));
    }
    return Array.from(stores);
  } catch (_) {
    return [];
  }
};

/**
 * Compute this DEVICE's tier for one incoming delivery broadcast.
 * Fail-open to P0 (immediate) whenever anything is unresolvable.
 */
export const computeDeliveryBroadcastPriority = (data) => {
  try {
    if (!data || !data.id) return P0;

    const driverId = data.driver_id || null;
    const storeId = data.store_id ? String(data.store_id) : null;

    // No assignment context at all — old behavior (immediate).
    if (!driverId && !storeId) return P0;

    const eff = _getEffectiveUser();
    if (!eff) return P0; // no user context — fail-open

    const userId = _userIdOf(eff);
    const roles = _rolesOf(eff);

    // P0: this user IS the delivery's driver.
    if (driverId && userId && String(driverId) === String(userId)) return P0;

    // P0: this device belongs to the delivery's primary store.
    const userStoreIds = _storeIdsOf(eff);
    if (storeId && userStoreIds && userStoreIds.includes(storeId)) return P0;

    // P0: device is actively viewing this driver (dashboard or overlay selection).
    if (driverId) {
      try {
        const sel = getCurrentDashboardSelection();
        const selectedDriverId = sel?.selectedDriverId || null;
        const overlayDriverId =
          (typeof window !== 'undefined' && window.__appOverlayDriverId) || null;
        if (selectedDriverId && String(selectedDriverId) === String(driverId)) return P0;
        if (overlayDriverId && String(overlayDriverId) === String(driverId)) return P0;
      } catch (_) { /* selection unresolvable — continue tiering */ }
    }

    // P1: another store on this driver's route today.
    if (driverId && userStoreIds) {
      const routeStores = _driverRouteStores(driverId, data.delivery_date || null);
      if (routeStores.some((s) => userStoreIds.includes(s))) return P1;
    }

    // P1: admin devices (owner instances — propagate with the driver's other stores).
    if (roles.includes('admin')) return P1;

    return P2;
  } catch (_) {
    return P0;
  }
};

// ── staging queue ─────────────────────────────────────────────────────────────

const _flushTier = (tier) => {
  const t = _tiers[tier];
  if (!t || t.map.size === 0) return;
  const events = Array.from(t.map.values());
  t.map.clear();
  if (t.timer) { clearTimeout(t.timer); t.timer = null; }
  if (Date.now() - t.lastLog > LOG_MIN_INTERVAL_MS) {
    t.lastLog = Date.now();
    console.log(`⏳ [BcastStage] flushed ${events.length} staged delivery events (${tier})`);
  }
  const handler = _flushHandler;
  if (!handler) return; // no subscription yet — boot/delta sync converges
  Promise.resolve().then(() => handler(events)).catch((e) => {
    console.warn('[BcastStage] staged flush failed:', e?.message || e);
  });
};

const _armTierTimer = (tier) => {
  const t = _tiers[tier];
  if (t.timer) return;
  t.timer = setTimeout(() => { t.timer = null; _flushTier(tier); }, t.delayMs + Math.floor(Math.random() * t.jitterMs));
};

/**
 * RealtimeSync subscribe-callback hook. Returns true when the event was staged
 * (caller must NOT process it now — it re-enters the full handler at flush).
 */
export const stageDeliveryEventIfLowPriority = (entityName, event) => {
  try {
    if (entityName !== 'Delivery') return false;
    const type = event?.type;
    if (type !== 'update' && type !== 'create') return false;
    const data = event?.data;
    if (!data || !data.id) return false;

    // Own-write echo path must stay immediate (echo suppression runs on arrival).
    const localWrites = (typeof window !== 'undefined' && window.__localDeliveryWrites) || null;
    if (localWrites && localWrites.has(data.id)) return false;

    const tier = computeDeliveryBroadcastPriority(data);
    if (tier === P0) return false;

    const t = _tiers[tier];
    // Coalesce by record id across BOTH tiers: newest event wins.
    for (const other of Object.values(_tiers)) other.map.delete(data.id);
    t.map.set(data.id, event);
    _armTierTimer(tier);

    if (Date.now() - t.lastLog > LOG_MIN_INTERVAL_MS) {
      t.lastLog = Date.now();
      console.log(`⏳ [BcastStage] staged ${type} for delivery ${data.id} (${tier}, driver ${data.driver_id || 'n/a'}) — flush in ~${Math.round(t.delayMs / 1000)}s`);
    }
    // Overflow: unbounded staging would stack fresh data behind old events.
    if (t.map.size > QUEUE_OVERFLOW_FLUSH) _flushTier(tier);
    return true;
  } catch (_) {
    return false; // fail-open: process immediately
  }
};

/**
 * A P0 event just processed immediately — drop any staged copies of the same
 * record so a stale staged payload can never overwrite the fresh one later.
 */
export const noteImmediateDeliveryProcessed = (id) => {
  if (!id) return;
  for (const t of Object.values(_tiers)) {
    if (t.map.delete(id) && t.map.size === 0 && t.timer) {
      clearTimeout(t.timer);
      t.timer = null;
    }
  }
};



// Flush everything when the app becomes visible (device in active use needs
// current data NOW, not on the next tier timer).
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (!window.__bcastStageVisibilityArmed) {
    window.__bcastStageVisibilityArmed = true;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        _flushTier(P1);
        _flushTier(P2);
      }
    });
  }
}
