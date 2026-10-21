// .repro/routeCommitMarker-test.js
import { base44 } from "./b44-stub.js";
import { getDeliveryFieldLock } from "./completionLockout-test.mjs";
var TERMINAL_STATUSES = ["completed", "failed", "cancelled"];
var _dropTerminalStomps = async (updates) => {
  const statusWriters = updates.filter((u) => u?.data?.status && !TERMINAL_STATUSES.includes(String(u.data.status)));
  if (statusWriters.length === 0) return updates;
  try {
    const { offlineDB } = await import("./odb-stub.js");
    const records = await offlineDB.getByIds(offlineDB.STORES.DELIVERIES, statusWriters.map((u) => u.id)).catch(() => null);
    if (!Array.isArray(records)) return updates;
    const terminalIds = new Set(
      records.filter((r) => r && TERMINAL_STATUSES.includes(String(r.status || ""))).map((r) => r.id)
    );
    if (terminalIds.size === 0) return updates;
    const kept = updates.filter((u) => !terminalIds.has(u.id));
    console.warn(`[RouteCommit] dropped ${updates.length - kept.length} update(s) that would revert a terminal (completed/failed/cancelled) IDB record to an active status`);
    return kept;
  } catch (_) {
    return updates;
  }
};
var _STARTED_ACTIVE = ["en_route", "in_transit"];
var _START_PROTECT_MS = 120 * 1e3;
var _dropStartStomps = async (updates) => {
  const suspects = updates.filter((u) => {
    const d = u?.data || {};
    const st = String(d.status || "");
    if (TERMINAL_STATUSES.includes(st)) return false;
    return st === "pending" || d.isNextDelivery === false || d.encoded_polyline === null && (d.status !== void 0 || d.isNextDelivery !== void 0);
  });
  if (suspects.length === 0) return updates;
  try {
    const { offlineDB } = await import("./odb-stub.js");
    const records = await offlineDB.getByIds(offlineDB.STORES.DELIVERIES, suspects.map((u) => u.id)).catch(() => null);
    if (!Array.isArray(records)) return updates;
    const byId = new Map(records.filter(Boolean).map((r) => [r.id, r]));
    const now = Date.now();
    const staleIds = /* @__PURE__ */ new Set();
    for (const u of suspects) {
      const r = byId.get(u.id);
      if (!r) continue;
      const isStarted = _STARTED_ACTIVE.includes(String(r.status || "")) && r.isNextDelivery === true;
      const fresh = r.updated_date && now - Date.parse(r.updated_date) < _START_PROTECT_MS;
      if (isStarted && fresh) staleIds.add(u.id);
    }
    if (staleIds.size === 0) return updates;
    const kept = updates.filter((u) => !staleIds.has(u.id));
    console.warn(`[RouteCommit] dropped ${staleIds.size} stale update(s) that would revert a just-started stop (pre-Start snapshot writer)`);
    return kept;
  } catch (_) {
    return updates;
  }
};
var _dropLockedFieldStomps = (updates) => {
  try {
    const kept = [];
    for (const u of updates) {
      const lock = getDeliveryFieldLock(u?.id);
      if (!lock || !lock.values) {
        kept.push(u);
        continue;
      }
      if (TERMINAL_STATUSES.includes(String(u.data?.status || ""))) {
        kept.push(u);
        continue;
      }
      let conflict = null;
      for (const [field, value] of Object.entries(u.data || {})) {
        const pinned = lock.values[field];
        if (pinned === void 0) continue;
        if (field === "status" && TERMINAL_STATUSES.includes(String(value))) continue;
        if (value !== pinned) {
          conflict = field;
          break;
        }
      }
      if (conflict) {
        console.warn(`[RouteCommit] dropped stale update for ${u.id} \u2014 locked field '${conflict}' would be overwritten (pinned=${JSON.stringify(lock.values[conflict])}, incoming=${JSON.stringify(u.data[conflict])})`);
        continue;
      }
      kept.push(u);
    }
    return kept;
  } catch (_) {
    return updates;
  }
};
var commitDeliveryUpdatesSilently = async (updates = []) => {
  let valid = (updates || []).filter((u) => u?.id && u?.data && Object.keys(u.data).length > 0);
  if (valid.length === 0) return 0;
  valid = await _dropTerminalStomps(valid);
  if (valid.length > 0) valid = await _dropStartStomps(valid);
  if (valid.length > 0) valid = _dropLockedFieldStomps(valid);
  if (valid.length === 0) return 0;
  try {
    const r = await base44.functions.invoke("bulkUpdateDeliveries", { updates: valid, silent: true });
    return typeof r?.updatedCount === "number" ? r.updatedCount : valid.length;
  } catch (e) {
    console.warn("[RouteCommit] silent commit failed, retrying in silent chunks:", e?.message || e);
    const CHUNK = 20;
    let okCount = 0;
    for (let i = 0; i < valid.length; i += CHUNK) {
      const chunk = valid.slice(i, i + CHUNK);
      try {
        const r = await base44.functions.invoke("bulkUpdateDeliveries", { updates: chunk, silent: true });
        okCount += typeof r?.updatedCount === "number" ? r.updatedCount : chunk.length;
      } catch (_) {
      }
    }
    return okCount;
  }
};
var fireRouteCommitMarker = async (deliveryId, committedCount = 0, changedIds = null) => {
  if (!deliveryId) return;
  try {
    const markerData = {
      route_commit_at: (/* @__PURE__ */ new Date()).toISOString(),
      route_commit_count: committedCount
    };
    if (Array.isArray(changedIds) && changedIds.length > 0) {
      markerData.route_commit_ids = changedIds.filter(Boolean).slice(0, 50);
    }
    try {
      const { offlineDB } = await import("./odb-stub.js");
      const [existing] = await offlineDB.getByIds(offlineDB.STORES.DELIVERIES, [deliveryId]).catch(() => []);
      if (existing) await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, [{ ...existing, ...markerData }]).catch(() => {
      });
    } catch (_) {
    }
    if (!window.__localDeliveryWrites) window.__localDeliveryWrites = /* @__PURE__ */ new Map();
    window.__localDeliveryWrites.set(deliveryId, Date.now() + 30 * 1e3);
    await base44.entities.Delivery.update(deliveryId, markerData);
    console.log(`[RouteCommit] marker broadcast (${committedCount} records committed silently)`);
  } catch (mErr) {
    console.warn("[RouteCommit] marker write failed:", mErr?.message || mErr);
  }
};
export {
  commitDeliveryUpdatesSilently,
  fireRouteCommitMarker
};
