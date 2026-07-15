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
}) {
  if (!driverId || !deliveryDate) {
    console.warn(`[RouteOptimization] ${source} — missing driverId or deliveryDate`);
    return { success: false, error: 'Missing driverId or deliveryDate' };
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
  } catch (e) {
    console.warn(`[RouteOptimization] ${source} — failed to get HERE API key:`, e?.message);
  }
  if (!hereApiKey) {
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
        console.warn(`[RouteOptimization] ${source} — engine did not succeed:`, engineResult?.error || 'unknown');
        // Non-fatal — fall through and try to fetch whatever exists
      } else {
        const _polyCount = (engineResult.writeBatch || []).filter(w => w.data?.encoded_polyline != null).length;
        console.log(`[RouteOptimization] ${source} — engine SUCCESS: ${engineResult.optimizedCount} stops, routeChanged=${engineResult.routeChanged}, writeBatch=${engineResult.writeBatch?.length}, withPolylines=${_polyCount}, usedFallbackOrdering=${engineResult.usedFallbackOrdering}`);
      }

      optimizeData = engineResult;

      // ── Step 2: Write results to backend DB via single bulk call ─────────
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('routeOptimizationPhase', { detail: { source, driverId, deliveryDate, phase: 'polylines' } }));
      }
      if (optimizeData?.writeBatch && optimizeData.writeBatch.length > 0) {
        const _polyWrites = optimizeData.writeBatch.filter(w => w.data?.encoded_polyline != null).length;
        console.log(`[RouteOptimization] ${source} — bulk-writing ${optimizeData.writeBatch.length} updates (${_polyWrites} with polylines)`);
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