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

export const START_ACTION_NAME = 'start_delivery';

export const queueConsolidateBreadcrumbs = async ({ driverId, deliveryDate, deliveryId }) => {
  if (!driverId || !deliveryDate) return;

  // ── C: FLUSH the offline master trail to the server BEFORE slicing ────────
  // The master trail on the server is only updated every 3rd offline save (15s).
  // If the completion happens within that window, the server's master trail is
  // missing the last 1-2 points. Force-flushing ensures the slicing function
  // has the absolute latest GPS data.
  try {
    const { offlineDB } = await import('../utils/offlineDatabase');
    const offlineKey = `${driverId}__TODAY__${deliveryDate}`;
    const masterRecord = await offlineDB.getById(offlineDB.STORES.DELIVERY_BREADCRUMBS, offlineKey);
    if (masterRecord?.encoded_polyline && masterRecord?.timestamps) {
      const { base44 } = await import('@/api/base44Client');
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
  if (Array.isArray(payments) && payments.some((payment) => ['Debit', 'Credit'].includes(payment?.type) && Number(payment?.amount || 0) > 0)) return true;
  return ['Debit', 'Credit'].includes(deliveryRecord?.cod_payment_type);
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