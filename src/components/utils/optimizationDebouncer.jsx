/**
 * Optimization Debouncer
 *
 * Central controller for deferred route optimization after delivery form edits.
 *
 * Rules:
 * - Each driver+date pair has its own independent 5-second countdown.
 * - When the delivery form opens, the timer for that driver+date is paused (cleared).
 * - When Update/Done is clicked, the timer restarts for that driver+date.
 * - When the timer fires, purgeAndRegeneratePolylines is called ONCE for that route.
 * - Spinner state (orange, counter-clockwise) is broadcast via a custom event so
 *   any interested UI component can show/hide the indicator.
 * - "needsOptimization=false" calls still reset the timer but skip the backend call.
 */

import { base44 } from '@/api/base44Client';
import { recalculateAndUpdateStopOrders } from './stopOrderManager';

const DEBOUNCE_MS = 5000;

// Map of "driverId|deliveryDate" → { timerId, needsOptimization }
const pending = new Map();

/** Broadcast spinner state to the UI */
function emitSpinner(driverId, deliveryDate, active) {
  window.dispatchEvent(new CustomEvent('optimizationDebouncerState', {
    detail: { driverId, deliveryDate, active }
  }));
}

/**
 * Request a (potentially deferred) optimization for a driver+date route.
 *
 * @param {string}  driverId          - Driver whose route changed
 * @param {string}  deliveryDate      - YYYY-MM-DD of the route
 * @param {boolean} needsOptimization - true → run optimizer+polylines when timer fires
 */
export function requestDeferredOptimization(driverId, deliveryDate, needsOptimization) {
  if (!driverId || !deliveryDate) return;

  const key = `${driverId}|${deliveryDate}`;

  // Clear any existing timer for this route
  const existing = pending.get(key);
  if (existing?.timerId) {
    clearTimeout(existing.timerId);
    emitSpinner(driverId, deliveryDate, false);
  }

  // Merge needsOptimization: if any call in the debounce window requested optimization, honour it
  const previouslyNeeded = existing?.needsOptimization || false;
  const finalNeedsOptimization = previouslyNeeded || needsOptimization;

  if (!finalNeedsOptimization) {
    // Nothing structural changed — don't even start the spinner
    pending.delete(key);
    return;
  }

  // Start spinner and new timer
  emitSpinner(driverId, deliveryDate, true);

  const timerId = setTimeout(async () => {
    pending.delete(key);
    emitSpinner(driverId, deliveryDate, false);

    try {
      // Step 1: Recalculate stop orders (finished first by actual_delivery_time, then incomplete by ETA/start)
      await recalculateAndUpdateStopOrders(driverId, deliveryDate, true /* skipPolylineRegeneration */);

      // Step 2: Fetch fresh ordered IDs after resort
      const freshDeliveries = await base44.entities.Delivery.filter({
        driver_id: driverId,
        delivery_date: deliveryDate
      }).catch(() => []);

      const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
      const activeStops = (freshDeliveries || [])
        .filter(d => d?.id && !finishedStatuses.includes(d?.status) && d?.status !== 'pending' && d?.status !== 'Staged')
        .sort((a, b) => (Number(a.stop_order) || 0) - (Number(b.stop_order) || 0));

      const orderedDeliveryIds = activeStops.map(d => d.id);

      if (orderedDeliveryIds.length > 0) {
        // Step 3: Optimize remaining stops
        await base44.functions.invoke('optimizeRemainingStops', {
          driverId,
          deliveryDate,
          bypassDriverStatus: true
        }).catch(() => null);

        // Step 4: Purge and regenerate polylines with the ordered IDs
        await base44.functions.invoke('purgeAndRegeneratePolylines', {
          driverId,
          deliveryDate,
          routeStopOrder: orderedDeliveryIds,
          reason: 'edit_form_deferred',
          scope: 'active_only',
          bypassDriverStatus: true
        }).catch(() => null);
      }

      // Step 5: Broadcast UI refresh
      window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
        detail: {
          driverId,
          deliveryDate,
          triggeredBy: 'optimizationDebouncer',
          fullReplacement: false
        }
      }));
      window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));

    } catch (err) {
      console.warn('[OptimizationDebouncer] Deferred optimization failed (non-fatal):', err?.message || err);
    }
  }, DEBOUNCE_MS);

  pending.set(key, { timerId, needsOptimization: finalNeedsOptimization });
}

/**
 * Pause (clear) the debounce timer for a driver+date without cancelling the intent.
 * Call this when the delivery form opens so we don't fire mid-edit.
 *
 * @param {string} driverId
 * @param {string} deliveryDate
 */
export function pauseDeferredOptimization(driverId, deliveryDate) {
  if (!driverId || !deliveryDate) return;
  const key = `${driverId}|${deliveryDate}`;
  const existing = pending.get(key);
  if (!existing) return;

  clearTimeout(existing.timerId);
  // Keep the entry in the map with needsOptimization preserved, but no active timer
  pending.set(key, { timerId: null, needsOptimization: existing.needsOptimization });
  emitSpinner(driverId, deliveryDate, false);
}

/**
 * Cancel everything for a driver+date (e.g. driver changed, form cancelled).
 */
export function cancelDeferredOptimization(driverId, deliveryDate) {
  if (!driverId || !deliveryDate) return;
  const key = `${driverId}|${deliveryDate}`;
  const existing = pending.get(key);
  if (existing?.timerId) clearTimeout(existing.timerId);
  pending.delete(key);
  emitSpinner(driverId, deliveryDate, false);
}

/**
 * Check whether there is a pending (paused or active) optimization for a route.
 */
export function hasPendingOptimization(driverId, deliveryDate) {
  return pending.has(`${driverId}|${deliveryDate}`);
}