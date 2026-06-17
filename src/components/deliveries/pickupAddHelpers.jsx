/**
 * pickupAddHelpers.jsx
 * Handles the "Add Pickup" tab logic in the Add To Route form.
 * Called from DeliveryForm.jsx when isPickupMode is true.
 */

import { resolvePickupTimeWindow } from './deliveryAddHelpers';
import { buildPickupStagedDelivery } from './deliveryStagingHelpers';
import { createDelivery as createDeliveryLocal, setBatchFormSaving } from '../utils/entityMutations';
import { pauseRealtimeSync, resumeRealtimeSync } from '../utils/realtimeSync';

/**
 * Adds a pickup to the route immediately (creates it in the DB).
 * Returns the created pickup record, or null on failure.
 */
export const addPickupToRoute = async ({
  formData,
  store,
  allDeliveries,
  stagedDeliveries,
  extraPickups = [],
  setHasChanges,
  setPickupsAddedCount,
  addedPickupRoutesRef,
  setError,
  handleClearForm,
}) => {
  const codAmount = formData.cod_total_amount_required > 0
    ? formData.cod_total_amount_required / 100
    : 0;

  const timeSlot = formData.ampm_deliveries || 'AM';

  const pickupToCreate = buildPickupStagedDelivery({
    formData,
    codAmount,
    store,
    timeSlot,
    existingStopIds: [
      ...(allDeliveries || []).map((d) => d?.stop_id),
      ...(stagedDeliveries || []).map((d) => d?.stop_id),
    ],
  });

  const pickupTimes = resolvePickupTimeWindow({
    store,
    deliveryDate: formData.delivery_date,
    timeSlot,
  });

  // Build list of all pickups (existing + newly created in this batch) to avoid tracking number collisions
  const routeDeliveriesForDriver = [
    ...(allDeliveries || []).filter(
      (d) =>
        d &&
        d.delivery_date === formData.delivery_date &&
        d.driver_id === formData.driver_id
    ),
    ...(extraPickups || []),
  ];

  const routePickups = routeDeliveriesForDriver.filter((d) => !d?.patient_id);
  const existingPickupTrackingNumbers = routePickups
    .map((d) => {
      const raw = String(d?.tracking_number || '');
      const match = raw.match(/(\d+)$/);
      return match ? parseInt(match[1], 10) : null;
    })
    .filter((v) => Number.isInteger(v));

  const trackingNumberBase =
    existingPickupTrackingNumbers.length > 0
      ? Math.max(...existingPickupTrackingNumbers) + 20
      : 0;
  const trackingNumber = trackingNumberBase === 0 ? '00' : String(trackingNumberBase);

  const resolvedTimeStart = pickupTimes?.delivery_time_start || pickupToCreate.delivery_time_start || '';
  const resolvedTimeEnd = pickupTimes?.delivery_time_end || pickupToCreate.delivery_time_end || '';

  // CRITICAL: defer polyline regeneration — handleBatchSave runs a single
  // optimizeRemainingStops + purgeAndRegeneratePolylines at the end, so we
  // must NOT trigger one per pickup or it causes duplicate records + ~15s delay.
  // Pause realtime broadcast so the WebSocket echo doesn't cause a duplicate UI render.
  setBatchFormSaving(true);
  pauseRealtimeSync();
  const createdPickup = await createDeliveryLocal({
    ...pickupToCreate,
    patient_id: null,
    status: 'en_route',
    tracking_number: trackingNumber,
    delivery_time_start: resolvedTimeStart,
    delivery_time_end: resolvedTimeEnd,
    delivery_time_eta: resolvedTimeStart,
    time_window_start: resolvedTimeStart,
    time_window_end: resolvedTimeEnd,
  }, { deferPolylineRefresh: true });
  setBatchFormSaving(false);
  resumeRealtimeSync();

  const routeDriverId = createdPickup?.driver_id || formData.driver_id;
  const routeDeliveryDate = createdPickup?.delivery_date || formData.delivery_date;

  setHasChanges(false);
  setPickupsAddedCount((prev) => prev + 1);
  addedPickupRoutesRef.current.push({ driverId: routeDriverId, deliveryDate: routeDeliveryDate });
  setError(null);

  // NOTE: Do NOT dispatch 'deliveriesUpdated' per-pickup — it triggers a full
  // smart-refresh + polyline cycle for every pickup, causing duplicate records
  // and ~15s delays. handleBatchSave fires a single optimizeRemainingStops +
  // purgeAndRegeneratePolylines when the user clicks Done.
  window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));

  // Clear form so user can add another pickup without reopening
  handleClearForm();

  return createdPickup;
};