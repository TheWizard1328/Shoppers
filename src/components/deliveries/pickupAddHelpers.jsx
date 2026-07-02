/**
 * pickupAddHelpers.jsx
 * Handles the "Add Pickup" tab logic in the Add To Route form.
 * Called from DeliveryForm.jsx when isPickupMode is true.
 */

import { resolvePickupTimeWindow } from './deliveryAddHelpers';
import { buildPickupStagedDelivery } from './deliveryStagingHelpers';
import { createDelivery as createDeliveryLocal, setBatchFormSaving } from '../utils/entityMutations';
import { pauseRealtimeSync, resumeRealtimeSync } from '../utils/realtimeSync';
import { loadStatHolidays, isStatHoliday } from '../utils/statHolidayResolver';

/**
 * Returns true if the pickup should be flagged as after_hours:
 * - The delivery date is a stat holiday, OR
 * - The driver is not the scheduled default driver for that store/day/slot
 */
const shouldBeAfterHours = async (formData, store) => {
  const { delivery_date, driver_id, ampm_deliveries } = formData;
  if (!delivery_date || !store) return false;

  // Check stat holiday
  const holidays = await loadStatHolidays();
  if (isStatHoliday(delivery_date, holidays)) return true;

  // Check if driver is the default scheduled driver for this store/day/slot
  const dayOfWeek = new Date(`${delivery_date}T00:00:00`).getDay();
  const isSaturday = dayOfWeek === 6;
  const isSunday = dayOfWeek === 0;
  const slot = ampm_deliveries || 'AM';

  let scheduledDriverId;
  if (isSaturday) {
    scheduledDriverId = slot === 'PM' ? store.saturday_pm_driver_id : store.saturday_am_driver_id;
  } else if (isSunday) {
    scheduledDriverId = slot === 'PM' ? store.sunday_pm_driver_id : store.sunday_am_driver_id;
  } else {
    scheduledDriverId = slot === 'PM' ? store.weekday_pm_driver_id : store.weekday_am_driver_id;
  }

  // If no driver is scheduled for this slot, or the driver doesn't match → after hours
  if (!scheduledDriverId || String(scheduledDriverId) !== String(driver_id)) return true;

  return false;
};

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

  const afterHours = await shouldBeAfterHours(formData, store);

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
    after_hours_pickup: afterHours,
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