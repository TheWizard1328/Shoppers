/**
 * Module-level helpers for useStopCardActions.
 *
 * Extracted (no behavior change) to keep useStopCardActions.jsx under the
 * 2500-line edit threshold. Pure functions only — no React hooks, no params
 * dependency. The breadcrumb consolidator + ETA / COD / travel-dist helpers
 * used across the start/complete/fail/retry/accept-single handlers live here.
 */

import { parseLocalTimestamp } from '../utils/timeRoundingHelper';
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
  } finally {
    // SLICING now runs SERVER-SIDE (owner approval Oct 4 2026): the scheduled
    // "Breadcrumb Slice Cycle" workflow invokes consolidateBreadcrumbSegment in
    // cycle mode every 5 minutes — full home-anchored walk per active
    // driver-date (same algorithm, same saved_to_route protection, self-heals
    // earlier legs, multi-arrival completions collapse into one slice). The
    // phone's job at stop-finish is now ONLY the force-flush above; the heavy
    // slicing invoke is off the driver's device entirely.
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