/**
 * Module-level helpers for useStopCardActions.
 *
 * Extracted (no behavior change) to keep useStopCardActions.jsx under the
 * 2500-line edit threshold. Pure functions only — no React hooks, no params
 * dependency. The breadcrumb consolidator + ETA / COD / travel-dist helpers
 * used across the start/complete/fail/retry/accept-single handlers live here.
 */

import { parseLocalTimestamp } from '../utils/timeRoundingHelper';
import { consolidateBreadcrumbSegment } from "@/functions/consolidateBreadcrumbSegment";
import { acquireBreadcrumbSyncLock } from "../utils/breadcrumbSyncLock";

export const START_ACTION_NAME = 'start_delivery';

export const queueConsolidateBreadcrumbs = async ({ driverId, deliveryDate, deliveryId }) => {
  if (!driverId || !deliveryDate) return;

  // ── C: FLUSH the offline master trail to the server BEFORE slicing ────────
  // The master trail on the server is only updated every 3rd offline save (15s).
  // If the completion happens within that window, the server's master trail is
  // missing the last 1-2 points. Force-flushing ensures the slicing function
  // has the absolute latest GPS data.
  //
  // The sync lock now covers the flush AND the slice call, so back-to-back
  // completions (multi-arrival dialog) queue behind each other instead of
  // racing two slicing runs against the same records.
  let releaseSliceLock = null;
  try {
    const { offlineDB } = await import('../utils/offlineDatabase');
    const offlineKey = `${driverId}__TODAY__${deliveryDate}`;
    const masterRecord = await offlineDB.getById(offlineDB.STORES.DELIVERY_BREADCRUMBS, offlineKey);
    if (masterRecord?.encoded_polyline && masterRecord?.timestamps) {
      const { base44 } = await import('@/api/base44Client');
      // Acquire mutex lock — prevents concurrent syncPendingBreadcrumbs calls
      // from the routine GPS sync loop and this pre-slice flush racing to create
      // duplicate master records (stop_order = -1).
      releaseSliceLock = await acquireBreadcrumbSyncLock();
      await base44.functions.invoke('syncPendingBreadcrumbs', {
        driver_id: driverId,
        delivery_date: deliveryDate,
        encoded_polyline: masterRecord.encoded_polyline,
        timestamps: masterRecord.timestamps,
        point_count: masterRecord.point_count,
      });
      console.log(`☁️ [Breadcrumbs] Pre-slice flush: ${masterRecord.point_count} points synced to server`);
    }
  } catch (flushErr) {
    console.warn('⚠️ [Breadcrumbs] Pre-slice flush failed:', flushErr?.message || flushErr);
    // Don't abort — the slicer will use whatever the server already has
  }

  try {
    // FULL home-anchored walk (owner fix, Sep 29 2026): the previous
    // 'incremental' tail cut anchored each new leg on the PREVIOUS leg's saved
    // segment record, matched by stop_order — but stop_orders now get
    // renumbered constantly (Start renumbering + repair passes renumber
    // finished stops 1..K by completion time), so the record lookup kept
    // missing and legs collapsed to 1-2 point stubs (owner report Sep 29:
    // "most stops set to 1 or 2 points"; preview of the full walk on the same
    // trail projected 275/119/230-point legs where incremental had written
    // 1-2). The full walk is the same proven algorithm as the Route Viewer
    // "reclip" scissors — home-anchored, time-primary boundaries — and it
    // re-slices EVERY finished leg on every completion, so earlier bad legs
    // self-heal as the day progresses. Manual saved_to_route legs are still
    // never overwritten (backend skips them), and orphaned/stale-numbered
    // segment records are cleaned up on each pass.
    const result = await consolidateBreadcrumbSegment({
      driver_id: driverId,
      delivery_date: deliveryDate,
      delivery_id: deliveryId,
    });
    if (result?.success) {
      console.log(`✅ [Breadcrumbs] Proximity slicing complete: ${result.total_segments} segments, ${result.master_point_count} master points`);
    } else {
      console.warn(`⚠️ [Breadcrumbs] Consolidation returned non-success:`, result?.error || result);
    }
  } catch (error) {
    console.warn('⚠️ [Breadcrumbs] Consolidation failed:', error?.message || error);
  } finally {
    if (releaseSliceLock) releaseSliceLock();
  }
};

export const ETA_REFRESH_THRESHOLD_MINUTES = 5;

export const parseTimeToMinutes = (timeString) => {
  if (!timeString || typeof timeString !== 'string') return null;
  const [hours, minutes] = timeString.split(':').map(Number);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return hours * 60 + minutes;
};

export const shouldRefreshRemainingEtas = (etaString, actualTimestamp) => {
  const etaMinutes = parseTimeToMinutes(etaString);
  const actualDate = parseLocalTimestamp(actualTimestamp);
  if (etaMinutes === null || !actualDate) return false;
  const actualMinutes = actualDate.getHours() * 60 + actualDate.getMinutes();
  return Math.abs(actualMinutes - etaMinutes) >= ETA_REFRESH_THRESHOLD_MINUTES;
};

export const hasDebitOrCreditCod = (deliveryRecord, paymentList = null) => {
  const payments = Array.isArray(paymentList) ? paymentList : deliveryRecord?.cod_payments;
  // Cheque is a direct collection — same as Debit/Credit (money taken directly,
  // catalog item removed). Cash alone stays in the catalog until deposit.
  const DIRECT_COD_TYPES = ['Debit', 'Credit', 'Cheque', 'Check'];
  if (Array.isArray(payments) && payments.some((payment) => DIRECT_COD_TYPES.includes(payment?.type) && Number(payment?.amount || 0) > 0)) return true;
  return DIRECT_COD_TYPES.includes(deliveryRecord?.cod_payment_type);
};

export const resolveTravelDistFallback = (deliveryRecord, retroactiveTravelDist, allRouteDeliveries = []) => {
  const currentStopOrder = Number(deliveryRecord?.stop_order);
  const isFirstStop = Number.isFinite(currentStopOrder) && !allRouteDeliveries.some((item) => Number(item?.stop_order) < currentStopOrder);
  if (isFirstStop) return 0;
  if (typeof retroactiveTravelDist === 'number') return retroactiveTravelDist;
  const estimatedDistanceKm = Number(deliveryRecord?.estimated_distance_km);
  const currentTravelDist = Number(deliveryRecord?.travel_dist);
  if (!Number.isFinite(estimatedDistanceKm)) return undefined;
  if (!Number.isFinite(currentTravelDist) || estimatedDistanceKm - currentTravelDist > 0.75) return estimatedDistanceKm;
  return undefined;
};