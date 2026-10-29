/**
 * Single-broadcast commit helpers — Accept All pattern generalized (Oct 13 2026).
 * ------------------------------------------------------------------
 * Contract shared by Accept All and the Start button:
 *   1. ALL server writes go through commitDeliveryUpdatesSilently(): ONE
 *      bulkUpdateDeliveries {silent:true} invoke. Silent mode writes with the
 *      service role, which emits NO WebSocket events — observer devices never
 *      watch a route build one stop at a time.
 *   2. fireRouteCommitMarker() then sends the ONE user-scoped marker write
 *      (route_commit_at) on the acted-on record. That write IS the single
 *      broadcast; remote realtimeSync instances detect the marker, fetch the
 *      finished route from the server once, and render one complete update.
 *
 * Fallbacks stay silent too — direct user-scoped Delivery.update calls would
 * re-create the per-stop WS broadcast storm this module exists to prevent.
 */
import { base44 } from '@/api/base44Client';
import { getDeliveryFieldLock } from './completionLockout';

/**
 * Commit [{id, data}] delivery updates with ZERO WebSocket broadcasts.
 * Returns the number of records committed (0 when nothing to commit or
 * everything failed).
 */
// Status-protection guard (owner report, Oct 13 2026 — completed stops reverting
// to en_route/in_transit after app restart). The Start full-path optimizer builds
// its writeBatch from a possibly-stale state snapshot; a stop completed seconds
// earlier can still appear active in that snapshot, and the batch's status
// re-assert silently overwrites the completion on the SERVER (IDB/UI stay
// 'completed' until the next cloud pull — when the revert becomes visible and
// cascades). IDB is the local-first authority (every action writes IDB before
// the server), so any batch entry that would write an ACTIVE status over an
// IDB-TERMINAL record is dropped. Fails OPEN on IDB errors.
const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'];
const _dropTerminalStomps = async (updates) => {
  const statusWriters = updates.filter((u) => u?.data?.status && !TERMINAL_STATUSES.includes(String(u.data.status)));
  if (statusWriters.length === 0) return updates;
  try {
    const { offlineDB } = await import('./offlineDatabase');
    const records = await offlineDB.getByIds(offlineDB.STORES.DELIVERIES, statusWriters.map((u) => u.id)).catch(() => null);
    if (!Array.isArray(records)) return updates; // fail open
    const terminalIds = new Set(
      records.filter((r) => r && TERMINAL_STATUSES.includes(String(r.status || ''))).map((r) => r.id)
    );
    if (terminalIds.size === 0) return updates;
    const kept = updates.filter((u) => !terminalIds.has(u.id));
    console.warn(`[RouteCommit] dropped ${updates.length - kept.length} update(s) that would revert a terminal (completed/failed/cancelled) IDB record to an active status`);
    return kept;
  } catch (_) {
    return updates; // fail open
  }
};

// ── START-STOMP GUARD (owner report Oct 21 2026: 'Start button — first press
// does everything right then REVERTS it, second press works') ────────────────
// A racing writer (accept/optimization triggered seconds after a Start) commits
// a writeBatch computed from a PRE-Start snapshot: the started stop still shows
// pending in that snapshot, so its entry writes status pending / isNextDelivery
// false / nulls the leg polyline over the just-started IDB record — the visible
// revert. This guard drops any entry that DOWNGRADES a recently-started record:
// IDB en_route/in_transit + isNextDelivery true + updated within 120s. IDB is
// local-first authority; a legit later action writes IDB BEFORE committing, so
// its own entries never match this shape. Fails OPEN on IDB errors.
const _STARTED_ACTIVE = ['en_route', 'in_transit'];
const _START_PROTECT_MS = 120 * 1000;
const _dropStartStomps = async (updates) => {
  const suspects = updates.filter((u) => {
    const d = u?.data || {};
    const st = String(d.status || '');
    // Terminal writes are NEVER stale stomps — a completion legitimately
    // clears the next flag and overwrites the started state (its own flow
    // already wrote the terminal status to IDB before committing anyway).
    if (TERMINAL_STATUSES.includes(st)) return false;
    return st === 'pending' || d.isNextDelivery === false
      || (d.encoded_polyline === null && (d.status !== undefined || d.isNextDelivery !== undefined));
  });
  if (suspects.length === 0) return updates;
  try {
    const { offlineDB } = await import('./offlineDatabase');
    const records = await offlineDB.getByIds(offlineDB.STORES.DELIVERIES, suspects.map((u) => u.id)).catch(() => null);
    if (!Array.isArray(records)) return updates; // fail open
    const byId = new Map(records.filter(Boolean).map((r) => [r.id, r]));
    const now = Date.now();
    const staleIds = new Set();
    for (const u of suspects) {
      const r = byId.get(u.id);
      if (!r) continue;
      const isStarted = _STARTED_ACTIVE.includes(String(r.status || ''))
        && r.isNextDelivery === true;
      const fresh = r.updated_date && (now - Date.parse(r.updated_date)) < _START_PROTECT_MS;
      if (isStarted && fresh) staleIds.add(u.id);
    }
    if (staleIds.size === 0) return updates;
    const kept = updates.filter((u) => !staleIds.has(u.id));
    console.warn(`[RouteCommit] dropped ${staleIds.size} stale update(s) that would revert a just-started stop (pre-Start snapshot writer)`);
    return kept;
  } catch (_) {
    return updates; // fail open
  }
};

// ── LOCK-VALUE GUARD: the most recent action pins its optimistic values via
// lockDeliveryFields (Start pins status/isNextDelivery/delivery_time_start on
// the started stop for 60s). A racing batch entry writing a DIFFERENT value
// for a pinned field is a stale writer — drop the whole entry (its stop_order/
// ETA payload was computed from the same stale snapshot anyway). Terminal
// status writes always pass (completions win over everything).
const _dropLockedFieldStomps = (updates) => {
  try {
    const kept = [];
    for (const u of updates) {
      const lock = getDeliveryFieldLock(u?.id);
      if (!lock || !lock.values) { kept.push(u); continue; }
      // A TERMINAL status write is a completion — it legitimately clears the
      // next flag and supersedes any Start-era pinned values. Always passes.
      if (TERMINAL_STATUSES.includes(String(u.data?.status || ''))) { kept.push(u); continue; }
      let conflict = null;
      for (const [field, value] of Object.entries(u.data || {})) {
        const pinned = lock.values[field];
        if (pinned === undefined) continue;
        if (field === 'status' && TERMINAL_STATUSES.includes(String(value))) continue;
        if (value !== pinned) { conflict = field; break; }
      }
      if (conflict) {
        console.warn(`[RouteCommit] dropped stale update for ${u.id} — locked field '${conflict}' would be overwritten (pinned=${JSON.stringify(lock.values[conflict])}, incoming=${JSON.stringify(u.data[conflict])})`);
        continue;
      }
      kept.push(u);
    }
    return kept;
  } catch (_) {
    return updates; // fail open
  }
};

// ── No-op resend gate (owner report Oct 29 2026: "one rate limit per stop") ──
// Every completion runs several silent passes over the SAME route (compute
// flags, ETA cascade, optimizer). Each pass re-sent records whose payload was
// already written seconds earlier by the previous pass, so one completion could
// spend 40+ entity_update slots on maybe 15 genuinely different rows. Identical
// payloads for the same record inside 90s are dropped here, at the single bulk
// choke point, so only real changes reach the server.
const _recentBulkSends = new Map();
const _BULK_SIG_TTL_MS = 90 * 1000;
const _bulkPayloadSig = (data) => {
  try {
    return JSON.stringify(Object.keys(data || {}).sort().reduce((acc, k) => { acc[k] = data[k]; return acc; }, {}));
  } catch (_) { return ''; }
};
const _dropNoopResends = (list) => {
  const now = Date.now();
  for (const [id, v] of _recentBulkSends) { if (now - v.at > _BULK_SIG_TTL_MS) _recentBulkSends.delete(id); }
  const kept = [];
  let skipped = 0;
  for (const u of list) {
    const key = String(u.id);
    const sig = _bulkPayloadSig(u.data);
    const prev = _recentBulkSends.get(key);
    if (prev && prev.sig === sig) { skipped++; continue; }
    _recentBulkSends.set(key, { sig, at: now });
    kept.push(u);
  }
  if (skipped) console.log(`[RouteCommit] skipped ${skipped} no-op resend(s) — identical payload already sent within ${_BULK_SIG_TTL_MS / 1000}s`);
  return kept;
};

export const commitDeliveryUpdatesSilently = async (updates = []) => {
  let valid = (updates || []).filter((u) => u?.id && u?.data && Object.keys(u.data).length > 0);
  if (valid.length === 0) return 0;
  valid = await _dropTerminalStomps(valid);
  if (valid.length > 0) valid = await _dropStartStomps(valid);
  if (valid.length > 0) valid = _dropLockedFieldStomps(valid);
  if (valid.length === 0) return 0;
  valid = _dropNoopResends(valid);
  if (valid.length === 0) return 0;
  try {
    const r = await base44.functions.invoke('bulkUpdateDeliveries', { updates: valid, silent: true });
    return typeof r?.updatedCount === 'number' ? r.updatedCount : valid.length;
  } catch (e) {
    console.warn('[RouteCommit] silent commit failed, retrying in silent chunks:', e?.message || e);
    const CHUNK = 20;
    let okCount = 0;
    for (let i = 0; i < valid.length; i += CHUNK) {
      const chunk = valid.slice(i, i + CHUNK);
      try {
        const r = await base44.functions.invoke('bulkUpdateDeliveries', { updates: chunk, silent: true });
        okCount += typeof r?.updatedCount === 'number' ? r.updatedCount : chunk.length;
      } catch (_) {}
    }
    return okCount;
  }
};

/**
 * THE single broadcast: one user-scoped marker write on the acted-on record.
 * Remote devices see route_commit_at in changedFields (or a fresh marker in the
 * payload), fetch the driver's route once, and render one update.
 */
export const fireRouteCommitMarker = async (deliveryId, committedCount = 0, changedIds = null) => {
  if (!deliveryId) return;
  try {
    const markerData = {
      route_commit_at: new Date().toISOString(),
      route_commit_count: committedCount
    };
    // OWNER DIRECTIVE (Oct 16 2026): the single end-of-action broadcast carries
    // ALL stop IDs whose data changed, so receivers (and the issue balloon
    // diagnostics) can see the full scope of the commit in one event.
    if (Array.isArray(changedIds) && changedIds.length > 0) {
      markerData.route_commit_ids = changedIds.filter(Boolean).slice(0, 50);
    }
    // Pre-write the marker fields to IDB so the content-aware self-echo check
    // (echoGuard) sees matching content and suppresses our own echo.
    try {
      const { offlineDB } = await import('./offlineDatabase');
      const [existing] = await offlineDB.getByIds(offlineDB.STORES.DELIVERIES, [deliveryId]).catch(() => []);
      if (existing) await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, [{ ...existing, ...markerData }]).catch(() => {});
    } catch (_) {}
    if (!window.__localDeliveryWrites) window.__localDeliveryWrites = new Map();
    window.__localDeliveryWrites.set(deliveryId, Date.now() + 30 * 1000); // suppress own echo
    await base44.entities.Delivery.update(deliveryId, markerData);
    console.log(`[RouteCommit] marker broadcast (${committedCount} records committed silently)`);
  } catch (mErr) {
    const msg = String(mErr?.message || mErr || '');
    if (/not\s*found|404/i.test(msg)) {
      // GHOST DELIVERY (owner report Oct 22 2026): this device still holds a
      // delivery the server already deleted (the delete WS broadcast was
      // missed — WS offline/TransportError at delete time — and delta sync
      // has no tombstones, so the remnant survives forever in IDB). Evidence:
      // "[RouteCommit] marker write failed: Entity Delivery with ID ... not
      // found" on the owner's phone while it kept the ghost as the
      // next-flagged stop. Self-heal: purge the remnant from IDB so it can
      // never poison route/marker/arrival flows again, then tell the UI to
      // re-read local data.
      try {
        const { offlineDB } = await import('./offlineDatabase');
        const [ghost] = await (offlineDB.getByIds(offlineDB.STORES.DELIVERIES, [deliveryId]).catch(() => []));
        await (offlineDB.deleteRecord(offlineDB.STORES.DELIVERIES, deliveryId).catch(() => {}));
        console.warn(`[RouteCommit] GHOST-PURGE: server reports delivery ${deliveryId} not found — purged stale local remnant` +
          (ghost ? ` (was driver=${ghost.driver_name} status=${ghost.status} isNext=${!!ghost.isNextDelivery})` : '') +
          `. If it held isNextDelivery, the next Complete/Accept re-syncs flags.`);
        try {
          window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
            detail: { driverId: ghost?.driver_id || null, deliveryDate: ghost?.delivery_date || null, triggeredBy: 'ghost_purge', purgedId: deliveryId }
          }));
        } catch (_) {}
      } catch (purgeErr) {
        console.warn('[RouteCommit] marker write failed AND ghost purge failed:', msg, purgeErr?.message || purgeErr);
      }
    } else {
      console.warn('[RouteCommit] marker write failed:', mErr?.message || mErr);
    }
  }
};
