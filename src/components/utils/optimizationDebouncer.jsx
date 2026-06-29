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
import { performRouteOptimization } from './routeOptimizationCoordinator';

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
    // Signal that optimization is now actively running (KITT bar)
    window.dispatchEvent(new CustomEvent('optimizationRunning', { detail: { driverId, deliveryDate, active: true } }));

    // Use the unified coordinator — same FAB path (optimizeRemainingStops → regenerateType1Polyline)
    await performRouteOptimization({
      driverId,
      deliveryDate,
      source: 'edit_form_deferred',
      bypassDriverStatus: true,
    });

    // Done — hide KITT bar
    window.dispatchEvent(new CustomEvent('optimizationRunning', { detail: { driverId, deliveryDate, active: false } }));

    // Broadcast UI refresh
    window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
      detail: {
        driverId,
        deliveryDate,
        triggeredBy: 'optimizationDebouncer',
        fullReplacement: false,
      }
    }));
    window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));
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

/**
 * Cancel ALL pending deferred optimizations and hide the spinner immediately.
 * Call this at the start of a manual route-optimize to prevent the debouncer
 * from firing concurrently and showing the orange KITT bar over the manual flow.
 */
export function cancelAllDeferredOptimizations() {
  for (const [key, entry] of pending.entries()) {
    if (entry?.timerId) clearTimeout(entry.timerId);
    const [driverId, deliveryDate] = key.split('|');
    // Hide both spinner types for this route
    window.dispatchEvent(new CustomEvent('optimizationDebouncerState', { detail: { driverId, deliveryDate, active: false } }));
    window.dispatchEvent(new CustomEvent('optimizationRunning', { detail: { driverId, deliveryDate, active: false } }));
  }
  pending.clear();
}