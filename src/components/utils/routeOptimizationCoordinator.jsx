/**
 * routeOptimizationCoordinator
 *
 * Single unified route optimization coordinator.
 *
 * This is the ONLY function that triggers route optimization + polyline regeneration.
 * All code paths (manual FAB, form save, start delivery, status update, accept all)
 * must go through this coordinator.
 *
 * Now uses the client-side engine (clientRouteEngine.js) instead of backend functions.
 * This eliminates the race condition where the backend optimizer reads stale data
 * before client-side writes have settled: the engine operates on fresh in-memory data,
 * then the coordinator writes results to the backend DB for other viewers.
 */

import { base44 } from '@/api/base44Client';
import { invalidate } from '@/components/utils/dataManager';
import { offlineDB } from '@/components/utils/offlineDatabase';
import { getOrFetchHereApiKey } from '@/components/utils/hereApiKeyStore';
import { optimizeRouteClientSide } from '@/components/utils/clientRouteEngine';
import { recalculateTrackingNumbersLocal } from '@/components/utils/recalculateTrackingNumbersLocal';

/**
 * Core route optimization engine (client-side).
 *
 * @param {Object} params
 * @param {string} params.driverId
 * @param {string} params.deliveryDate       - YYYY-MM-DD
 * @param {Object} [params.currentLocation]   - { lat, lon } for polyline origin
 * @param {Array}  [params.deliveries]        - Local deliveries array (from React state/refs)
 * @param {Array}  [params.patients]          - Local patients array
 * @param {Array}  [params.stores]            - Local stores array
 * @param {Array}  [params.appUsers]          - Local appUsers array
 * @param {string[]} [params.orderedDeliveryIds] - Pre-computed ordered IDs (skip optimizer if provided)
 * @param {boolean} [params.skipOptimize=false]  - Skip optimization (use orderedDeliveryIds directly)
 * @param {boolean} [params.skipPolyline=false]  - Skip polyline generation entirely
 * @param {string}  [params.source='coordinator'] - Label for logging / events
 * @param {boolean} [params.bypassDriverStatus=true]
 * @param {boolean} [params.preserveExistingOrder=false]
 * @param {boolean} [params.cyclingSegmentOnly=false]
 * @param {Object}  [params.cyclingOrigin]
 * @param {Object}  [params.cyclingDestination]
 * @param {string[]} [params.cyclingStopIds]
 * @param {boolean} [params.drivingSegmentOnly=false]
 * @param {Object}  [params.drivingOrigin]
 * @param {string[]} [params.excludeStopIds]
 * @param {number}  [params.startingStopOrder]
 * @param {boolean} [params.recalcTrackingNumbers=false] — When true, recalculate TR#s into writeBatch before bulk DB write (Accept All only)
 * @returns {Promise<{success: boolean, optimizeData?: Object, freshDeliveries?: Array, orderedDeliveryIds?: string[], error?: string}>}
 */
export async function performRouteOptimization({
  driverId,
  deliveryDate,
  currentLocation = null,
  deliveries = null,
  patients = null,
  stores = null,
  appUsers = null,
  orderedDeliveryIds = null,
  skipOptimize = false,
  skipPolyline = false,
  source = 'coordinator',
  bypassDriverStatus = true,
  preserveExistingOrder = false,
  cyclingSegmentOnly = false,
  cyclingOrigin = null,
  cyclingDestination = null,
  cyclingStopIds = [],
  drivingSegmentOnly = false,
  drivingOrigin = null,
  excludeStopIds = [],
  startingStopOrder = null,
  recalcTrackingNumbers = false,
}) {
  if (!driverId || !deliveryDate) {
    console.warn(`[RouteOptimization] ${source} — missing driverId or deliveryDate`);
    return { success: false, error: 'Missing driverId or deliveryDate' };
  }

  // ── Early exit: if deliveries were provided and contain zero active stops, bail.
  // This prevents wasted HERE API calls when a delete leaves the route empty.
  // ""Active" = not in a terminal status (completed/failed/cancelled).
  const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'];
  if (Array.isArray(deliveries) && deliveries.length > 0) {
    const activeStops = deliveries.filter(
      (d) => d && !TERMINAL_STATUSES.includes(String(d.status || ''))
    );
    if (activeStops.length === 0) {
      console.log(`[RouteOptimization] ${source} — no active stops for driver ${driverId} on ${deliveryDate}, skipping`);
      return { success: true, skipped: true, reason: 'no_active_stops', freshDeliveries: [], optimizeData: { skipped: true, reason: 'no_active_stops' } };
    }
    // Diagnostic: log the status breakdown so we can see what's happening
    const _statusBreakdown = {};
    for (const d of deliveries) {
      const s = String(d?.status || 'unknown');
      _statusBreakdown[s] = (_statusBreakdown[s] || 0) + 1;
    }
    console.log(`[RouteOptimization] ${source} — ENTRY: ${deliveries.length} deliveries, ${activeStops.length} active. Status breakdown:`, _statusBreakdown);
  } else {
    console.log(`[RouteOptimization] ${source} — ENTRY: deliveries=${deliveries === null ? 'null (will fetch from backend)' : 'empty array'}, driverId=${driverId}, date=${deliveryDate}`);
  }

  // ── Fire KITT bar immediately so UI responds before any async work ────────
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('routeOptimizationStarted', { detail: { source, driverId, deliveryDate } }));
    window.dispatchEvent(new CustomEvent('optimizationRunning', { detail: { driverId, deliveryDate, active: true } }));
  }

  // ── Resolve HERE API key ──────────────────────────────────────────────────
  let hereApiKey = null;
  try {
    hereApiKey = await getOrFetchHereApiKey();
    console.log(`[RouteOptimization] ${source} — HERE API key resolved: ${hereApiKey ? '✅ available' : '❌ NULL'}`);
  } catch (e) {
    console.error(`[RouteOptimization] ${source} — failed to get HERE API key:`, e?.message);
  }
  if (!hereApiKey) {
    console.error(`[RouteOptimization] ${source} — BAILING: HERE API key not available (check getActiveHereApiKey backend function + bootstrap manifest)`);
    return { success: false, error: 'HERE API key not available' };
  }

  // ── Resolve current location from AppUser if not provided ─────────────────
  let resolvedCurrentLocation = currentLocation;
  let resolvedAppUsers = appUsers;

  if (!resolvedCurrentLocation || !Number.isFinite(resolvedCurrentLocation?.lat) || !Number.isFinite(resolvedCurrentLocation?.lon)) {
    // Try to resolve from appUsers first (if provided)
    if (!resolvedAppUsers) {
      try {
        resolvedAppUsers = await base44.entities.AppUser.filter({ user_id: driverId }).catch(() => []);
      } catch (e) {
        console.warn(`[RouteOptimization] ${source} — failed to fetch AppUser for location fallback:`, e?.message);
      }
    }
    const driverAppUser = Array.isArray(resolvedAppUsers) ? resolvedAppUsers.find(au => au?.user_id === driverId) : null;
    const fallbackLat = Number(driverAppUser?.current_latitude);
    const fallbackLon = Number(driverAppUser?.current_longitude);
    if (Number.isFinite(fallbackLat) && Number.isFinite(fallbackLon)) {
      resolvedCurrentLocation = { lat: fallbackLat, lon: fallbackLon };
    }
  }

  // ── Fetch local data if not provided by caller ────────────────────────────
  // When the caller doesn't pass local data (e.g. legacy call sites), we fall back to
  // fetching from the backend. This is the old behavior and may still race, but it's
  // better than failing. New call sites should always pass local data.
  let resolvedDeliveries = deliveries;
  let resolvedPatients = patients;
  let resolvedStores = stores;

  if (!resolvedDeliveries) {
    console.warn(`[RouteOptimization] ${source} — no local deliveries provided, fetching from backend (may race)`);
    resolvedDeliveries = await base44.entities.Delivery.filter({
      driver_id: driverId, delivery_date: deliveryDate
    }).catch(() => []);
  }
  if (!resolvedPatients) {
    const patientIds = [...new Set((resolvedDeliveries || []).filter(d => d.patient_id).map(d => d.patient_id))];
    resolvedPatients = patientIds.length ? await base44.entities.Patient.filter({ id: { $in: patientIds } }).catch(() => []) : [];
  }
  if (!resolvedStores) {
    const storeIds = [...new Set((resolvedDeliveries || []).map(d => d.store_id).filter(Boolean))];
    resolvedStores = storeIds.length ? await base44.entities.Store.filter({ id: { $in: storeIds } }).catch(() => []) : [];
  }
  if (!resolvedAppUsers) {
    resolvedAppUsers = await base44.entities.AppUser.filter({ user_id: driverId }).catch(() => []);
  }

  // ── Second active-stops check: after backend fetch (for callers that passed deliveries=null).
  // If the fetched data shows no active stops, bail before wasting HERE API calls.
  {
    const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'];
    const activeStops = (resolvedDeliveries || []).filter(
      (d) => d && !TERMINAL_STATUSES.includes(String(d.status || ''))
    );
    if (activeStops.length === 0) {
      console.log(`[RouteOptimization] ${source} — no active stops found after backend fetch for driver ${driverId} on ${deliveryDate}, skipping`);
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('optimizationRunning', { detail: { driverId, deliveryDate, active: false } }));
        window.dispatchEvent(new CustomEvent('routeOptimizationComplete', { detail: { source, driverId, deliveryDate, skipped: true } }));
      }
      return { success: true, skipped: true, reason: 'no_active_stops_after_fetch', freshDeliveries: [], optimizeData: { skipped: true, reason: 'no_active_stops' } };
    }
  }

  try {
    // ── Step 1: Run client-side optimization engine ──────────────────────────
    let optimizeData = null;

    if (!skipOptimize) {
      const engineResult = await optimizeRouteClientSide({
        deliveries: resolvedDeliveries,
        patients: resolvedPatients,
        stores: resolvedStores,
        appUsers: resolvedAppUsers,
        driverId,
        deliveryDate,
        hereApiKey,
        currentLocation: resolvedCurrentLocation,
        source,
        preserveExistingOrder,
        cyclingSegmentOnly,
        cyclingOrigin,
        cyclingDestination,
        cyclingStopIds,
        drivingSegmentOnly,
        drivingOrigin,
        excludeStopIds,
        startingStopOrder,
      }).catch((err) => {
        console.error(`[RouteOptimization] ${source} — client engine error:`, err);
        return null;
      });

      if (!engineResult?.success) {
        console.error(`[RouteOptimization] ${source} — engine FAILED:`, engineResult?.error || 'unknown');
        // Engine failed — return failure so the caller can show an error.
        // Previously this was "non-fatal" which caused silent optimization failures:
        // no stop_order updates, no polylines, no ETAs — and the caller had no idea.
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('optimizationRunning', { detail: { driverId, deliveryDate, active: false } }));
          window.dispatchEvent(new CustomEvent('routeOptimizationComplete', { detail: { source, driverId, deliveryDate, optimizedCount: null, error: engineResult?.error || 'engine_failed' } }));
        }
        return { success: false, error: engineResult?.error || 'Engine failed to optimize route', freshDeliveries: resolvedDeliveries || [] };
      } else {
        const _polyCount = (engineResult.writeBatch || []).filter(w => w.data?.encoded_polyline != null).length;
        console.log(`[RouteOptimization] ${source} — engine SUCCESS: ${engineResult.optimizedCount} stops, routeChanged=${engineResult.routeChanged}, writeBatch=${engineResult.writeBatch?.length}, withPolylines=${_polyCount}, usedFallbackOrdering=${engineResult.usedFallbackOrdering}`);
      }

      optimizeData = engineResult;

      // ── Step 1b: Recalculate tracking numbers into writeBatch (Accept All only) ─
      // Runs AFTER the engine assigns stop_order but BEFORE the bulk DB write,
      // so TR#s and stop_order are written atomically in a single bulkUpdateDeliveries
      // call. This eliminates the race where stop_order is written first and a
      // separate TR# write follows seconds later (or times out).
      if (recalcTrackingNumbers && optimizeData?.writeBatch?.length > 0) {
        try {
          // Merge stop_order from writeBatch back into resolvedDeliveries so the
          // TR# calculator sees the post-optimization order.
          const _stopOrderMap = new Map(optimizeData.writeBatch.map(w => [w.id, w.data?.stop_order]));
          const _trSource = (resolvedDeliveries || []).map(d => {
            const newOrder = _stopOrderMap.get(d.id);
            return newOrder != null ? { ...d, stop_order: newOrder } : d;
          });
          const _trUpdates = recalculateTrackingNumbersLocal({
            deliveries: _trSource,
            stores: stores || [],
            patients: patients || [],
          });
          if (_trUpdates.length > 0) {
            const _trMap = new Map(_trUpdates.map(u => [u.id, u.tracking_number]));
            let _patched = 0;
            for (const w of optimizeData.writeBatch) {
              const tr = _trMap.get(w.id);
              if (tr != null) { w.data.tracking_number = tr; _patched++; }
            }
            // Also patch resolvedDeliveries so freshDeliveries gets correct TR#s
            for (let i = 0; i < (resolvedDeliveries || []).length; i++) {
              const tr = _trMap.get(resolvedDeliveries[i]?.id);
              if (tr != null) resolvedDeliveries[i].tracking_number = tr;
            }
            console.log(`[RouteOptimization] ${source} — TR# recalculated: ${_trUpdates.length} computed, ${_patched} merged into writeBatch (atomic with stop_order)`);
          }
        } catch (_trErr) {
          console.warn(`[RouteOptimization] ${source} — TR# recalculation failed (non-fatal):`, _trErr?.message || _trErr);
        }
      }

      // ── Step 2: Write results to backend DB via single bulk call ─────────
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('routeOptimizationPhase', { detail: { source, driverId, deliveryDate, phase: 'polylines' } }));
      }
      if (optimizeData?.writeBatch && optimizeData.writeBatch.length > 0) {
        const _polyWrites = optimizeData.writeBatch.filter(w => w.data?.encoded_polyline != null).length;
        const _trWrites = optimizeData.writeBatch.filter(w => w.data?.tracking_number != null).length;
        console.log(`[RouteOptimization] ${source} — bulk-writing ${optimizeData.writeBatch.length} updates (${_polyWrites} with polylines, ${_trWrites} with TR#)`);
        try {
          await base44.functions.invoke('bulkUpdateDeliveries', { updates: optimizeData.writeBatch });
        } catch (e) {
          console.warn(`[RouteOptimization] ${source} — bulkUpdateDeliveries failed, falling back to individual writes:`, e?.message);
          // Fallback: individual writes in parallel batches of 20
          const CHUNK_SIZE = 20;
          for (let i = 0; i < optimizeData.writeBatch.length; i += CHUNK_SIZE) {
            const chunk = optimizeData.writeBatch.slice(i, i + CHUNK_SIZE);
            await Promise.all(chunk.map(async ({ id, data }) => {
              try { await base44.entities.Delivery.update(id, data); } catch (_) {}
            }));
          }
        }
      }
    } else if (orderedDeliveryIds) {
      // Caller provided pre-computed order — just use it
      optimizeData = { success: true, orderedDeliveryIds, optimizedRoute: [], writeBatch: [] };
    }

    // ── Step 3: Build fresh deliveries from engine write batch (no re-fetch needed) ──
    // Apply writeBatch onto the resolved local deliveries so caller gets up-to-date records instantly.
    const writeMap = new Map((optimizeData?.writeBatch || []).map(({ id, data }) => [id, data]));
    const freshDeliveries = (resolvedDeliveries || []).map(d => {
      const patch = writeMap.get(d.id);
      return patch ? { ...d, ...patch } : d;
    });

    if (Array.isArray(freshDeliveries) && freshDeliveries.length > 0) {
      const _freshPolyCount = freshDeliveries.filter(d => d?.encoded_polyline).length;
      console.log(`[RouteOptimization] ${source} — local merge: ${freshDeliveries.length} deliveries, ${_freshPolyCount} with polylines`);
      // CRITICAL: Use individual saves (merge), NOT replaceRecordsByIndex.
      // freshDeliveries only contains THIS driver's deliveries — replaceRecordsByIndex
      // would DELETE all other drivers' deliveries for the same date from IDB,
      // causing cached data loss when optimization is triggered via status toggle.
      Promise.all(freshDeliveries.map(d => offlineDB.save(offlineDB.STORES.DELIVERIES, d).catch(() => {}))).catch(() => {});
    }

    const usedFallbackOrdering = optimizeData?.usedFallbackOrdering === true;
    const usedFallbackPolyline = false; // Engine handles polylines inline; no separate fallback

    // Dispatch completion with stop count for KITT bar final message
    const _optimizedCount = optimizeData?.optimizedCount || optimizeData?.writeBatch?.length || 0;
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('routeOptimizationComplete', { detail: { source, driverId, deliveryDate, optimizedCount: _optimizedCount } }));
      window.dispatchEvent(new CustomEvent('optimizationRunning', { detail: { driverId, deliveryDate, active: false } }));
    }

    return {
      success: true,
      optimizeData,
      freshDeliveries: freshDeliveries || [],
      orderedDeliveryIds: optimizeData?.orderedDeliveryIds || orderedDeliveryIds || null,
      usedFallbackOrdering,
      usedFallbackPolyline,
      isDegraded: usedFallbackOrdering || usedFallbackPolyline,
    };
  } catch (error) {
    console.error(`[RouteOptimization] ${source} — Error:`, error);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('optimizationRunning', { detail: { driverId, deliveryDate, active: false } }));
      window.dispatchEvent(new CustomEvent('routeOptimizationComplete', { detail: { source, driverId, deliveryDate, optimizedCount: null } }));
    }
    return { success: false, error: error.message };
  }
}