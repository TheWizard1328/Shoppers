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

/**
 * Commit [{id, data}] delivery updates with ZERO WebSocket broadcasts.
 * Returns the number of records committed (0 when nothing to commit or
 * everything failed).
 */
export const commitDeliveryUpdatesSilently = async (updates = []) => {
  const valid = (updates || []).filter((u) => u?.id && u?.data && Object.keys(u.data).length > 0);
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
export const fireRouteCommitMarker = async (deliveryId, committedCount = 0) => {
  if (!deliveryId) return;
  try {
    const markerData = {
      route_commit_at: new Date().toISOString(),
      route_commit_count: committedCount
    };
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
    console.warn('[RouteCommit] marker write failed:', mErr?.message || mErr);
  }
};
