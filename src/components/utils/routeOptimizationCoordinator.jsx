/**
 * routeOptimizationCoordinator
 *
 * Single unified route optimization coordinator.
 *
 * This is the ONLY function that triggers route optimization + polyline regeneration.
 * All code paths (manual FAB, form save, start delivery, status update, accept all)
 * must go through this coordinator.
 *
 * Mirrors the proven Manual FAB path:
 *   optimizeRemainingStops → regenerateType1Polyline
 * then fetches fresh data, saves to offline DB, and broadcasts UI updates.
 */

import { base44 } from '@/api/base44Client';
import { invalidate } from '@/components/utils/dataManager';
import { offlineDB } from '@/components/utils/offlineDatabase';

/**
 * Core route optimization engine.
 *
 * @param {Object} params
 * @param {string} params.driverId
 * @param {string} params.deliveryDate       - YYYY-MM-DD
 * @param {Object} [params.currentLocation]   - { lat, lon } for polyline origin
 * @param {string[]} [params.orderedDeliveryIds] - Pre-computed ordered IDs (skip optimizer if provided)
 * @param {boolean} [params.skipOptimize=false]  - Skip optimizeRemainingStops call (use orderedDeliveryIds directly)
 * @param {boolean} [params.skipPolyline=false]  - Skip polyline regeneration entirely
 * @param {string}  [params.source='coordinator'] - Label for logging / events
 * @param {boolean} [params.bypassDriverStatus=true]
 * @param {Object}  [params.hereApiKey]
 * @returns {Promise<{success: boolean, optimizeData?: Object, freshDeliveries?: Array, orderedDeliveryIds?: string[], error?: string}>}
 */
export async function performRouteOptimization({
  driverId,
  deliveryDate,
  currentLocation = null,
  orderedDeliveryIds = null,
  skipOptimize = false,
  skipPolyline = false,
  source = 'coordinator',
  bypassDriverStatus = true,
  hereApiKey = null,
}) {
  if (!driverId || !deliveryDate) {
    console.warn(`[RouteOptimization] ${source} — missing driverId or deliveryDate`);
    return { success: false, error: 'Missing driverId or deliveryDate' };
  }

  let optimizeData = null;
  let resolvedOrderedIds = orderedDeliveryIds || null;

  try {
    // ── Step 1: Optimize remaining stops (unless skipped with pre-computed IDs) ──
    if (!skipOptimize && !resolvedOrderedIds) {
      const now = new Date();
      const currentLocalTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

      const optimizeResponse = await base44.functions.invoke('optimizeRemainingStops', {
        driverId,
        deliveryDate,
        currentLocalTime,
        deviceTime: now.toISOString(),
        ...(bypassDriverStatus ? { bypassDriverStatus: true } : {}),
        ...(hereApiKey ? { hereApiKey } : {}),
      }).catch((err) => {
        console.warn(`[RouteOptimization] ${source} — optimizeRemainingStops failed:`, err?.message);
        return null;
      });

      optimizeData = optimizeResponse?.data || optimizeResponse;

      if (!optimizeData?.success) {
        console.warn(`[RouteOptimization] ${source} — Optimizer did not succeed:`, optimizeData?.error || 'unknown');
        // Non-fatal — fall through and try polyline refresh with whatever order exists
      } else {
        resolvedOrderedIds = Array.isArray(optimizeData.orderedDeliveryIds) && optimizeData.orderedDeliveryIds.length > 0
          ? optimizeData.orderedDeliveryIds
          : null;
      }
    }

    // ── Step 2: Regenerate polylines using the proven FAB path (regenerateType1Polyline) ──
    if (!skipPolyline && resolvedOrderedIds && resolvedOrderedIds.length > 0) {
      // Use the same call as handleReoptimizeRoute (regenerateType1Polyline with ordered IDs)
      try {
        await base44.functions.invoke('regenerateType1Polyline', {
          driverId,
          deliveryDate,
          currentLocation: currentLocation || (optimizeData?.trueOriginCoords || null),
          orderedDeliveryIds: resolvedOrderedIds,
          routeChangeSource: source,
          force: true,
        }).catch((e) => {
          console.warn(`[RouteOptimization] ${source} — regenerateType1Polyline failed, falling back to purgeAndRegeneratePolylines:`, e?.message);
          // Fallback: try purgeAndRegeneratePolylines
          return base44.functions.invoke('purgeAndRegeneratePolylines', {
            driverId,
            deliveryDate,
            routeStopOrder: resolvedOrderedIds,
            reason: source,
            scope: 'active_only',
            bypassDriverStatus: true,
            recalculateEtas: false,
          }).catch((e2) => console.warn(`[RouteOptimization] ${source} — purgeAndRegeneratePolylines also failed:`, e2?.message));
        });
      } catch (e) {
        console.warn(`[RouteOptimization] ${source} — polyline regeneration failed:`, e?.message);
      }
    } else if (!skipPolyline && !resolvedOrderedIds) {
      // No ordered IDs — try purgeAndRegeneratePolylines with scope='active_only'
      try {
        await base44.functions.invoke('purgeAndRegeneratePolylines', {
          driverId,
          deliveryDate,
          scope: 'active_only',
          reason: source,
          bypassDriverStatus: true,
          recalculateEtas: false,
        }).catch((e) => console.warn(`[RouteOptimization] ${source} — purgeAndRegeneratePolylines failed:`, e?.message));
      } catch (e) {
        console.warn(`[RouteOptimization] ${source} — purgeAndRegeneratePolylines failed:`, e?.message);
      }
    }

    // ── Step 3: Fetch fresh deliveries and persist to offline DB ──
    // Wait briefly for the polyline backend function to finish writing encoded_polyline
    // back to the DB before we fetch — without this, the fetch races the async write.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    invalidate('Delivery');
    const freshDeliveries = await base44.entities.Delivery.filter({
      driver_id: driverId,
      delivery_date: deliveryDate,
    }).catch(() => []);

    if (Array.isArray(freshDeliveries) && freshDeliveries.length > 0) {
      await offlineDB.replaceRecordsByIndex(
        offlineDB.STORES.DELIVERIES,
        'delivery_date',
        deliveryDate,
        freshDeliveries
      ).catch(() => {});
    }

    return {
      success: true,
      optimizeData,
      freshDeliveries: freshDeliveries || [],
      orderedDeliveryIds: resolvedOrderedIds,
    };
  } catch (error) {
    console.error(`[RouteOptimization] ${source} — Error:`, error);
    return { success: false, error: error.message };
  }
}