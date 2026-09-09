/**
 * pickupAddHelpers.jsx
 * Handles the "Add Pickup" tab logic in the Add To Route form.
 * Called from DeliveryForm.jsx when isPickupMode is true.
 */

import { resolvePickupTimeWindow } from './deliveryAddHelpers';
import { buildPickupStagedDelivery } from './deliveryStagingHelpers';
import { loadStatHolidays, isStatHoliday } from '../utils/statHolidayResolver';
import { executeOfflineBatchAction } from '../utils/offlineBatchAction';
import { offlineDB } from '../utils/offlineDatabase';

/**
 * Returns true if the pickup should be flagged as after_hours:
 * - The delivery date is a stat holiday, OR
 * - The driver is not the scheduled driver for that store/date
 *   (DriverScheduleOverride is slot-agnostic — a single override for a store/date
 *   means that driver covers ALL slots; falls back to slot-specific store defaults
 *   when no override exists), OR
 * - The driver's route for that date is already in-progress or completed
 *
 * Uses the pre-built scheduledDriverMap (no per-pickup live query).
 */
const shouldBeAfterHours = async (formData, store, allDeliveries = [], scheduledDriverMap = {}) => {
  const { delivery_date, driver_id, ampm_deliveries } = formData;
  if (!delivery_date || !store) return false;

  // 1. Check stat holiday
  const holidays = await loadStatHolidays();
  if (isStatHoliday(delivery_date, holidays)) return true;

  const slot = ampm_deliveries || 'AM';

  // 2. Look up the scheduled driver from the pre-built map.
  // scheduledDriverMap already resolves: override (slot-agnostic) → store default (slot-specific).
  const slotKey = `${store.id}_${slot}`;
  const scheduledDriverId = scheduledDriverMap[slotKey] || scheduledDriverMap[store.id] || null;

  // 3. If no driver scheduled or driver doesn't match → after hours
  if (!scheduledDriverId || scheduledDriverId === '__booked_off__' || String(scheduledDriverId) !== String(driver_id)) return true;

  // 4. Check if this driver's route is already in-progress or completed for that store/date/slot
  const routeDeliveries = (allDeliveries || []).filter(
    (d) => d && d.driver_id === driver_id && d.delivery_date === delivery_date && d.store_id === store.id
  );
  const activeStatuses = ['en_route', 'in_transit', 'completed', 'failed', 'cancelled'];
  const routeIsActive = routeDeliveries.some((d) => activeStatuses.includes(d.status));
  if (routeIsActive) return true;

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
  scheduledDriverMap = {},
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

  const afterHours = await shouldBeAfterHours(formData, store, allDeliveries, scheduledDriverMap);

  // Assign a basic stop_order so the pickup appears at the end of the route
  // until the batch optimizer reorders everything on "Done".
  const existingStopOrders = routeDeliveriesForDriver
    .map((d) => d?.stop_order)
    .filter((n) => typeof n === 'number' && !isNaN(n));
  const basicStopOrder = existingStopOrders.length > 0 ? Math.max(...existingStopOrders) + 1 : 1;

  const pickupPayload = {
    ...pickupToCreate,
    patient_id: null,
    status: 'en_route',
    tracking_number: trackingNumber,
    stop_order: basicStopOrder,
    isNextDelivery: false, // Only the batch optimizer (on "Done") assigns the single next-delivery flag
    delivery_time_start: resolvedTimeStart,
    delivery_time_end: resolvedTimeEnd,
    delivery_time_eta: resolvedTimeStart,
    time_window_start: resolvedTimeStart,
    time_window_end: resolvedTimeEnd,
    after_hours_pickup: afterHours,
  };

  let createdPickup = null;

  await executeOfflineBatchAction({
    actionName: 'AddPickup',
    work: async () => {
      // Stage to offlineDB immediately with a temp ID
      const tempId = `temp_delivery_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const localRecord = { ...pickupPayload, id: tempId, _isLocal: true, created_date: new Date().toISOString(), updated_date: new Date().toISOString() };
      await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, [localRecord]).catch(() => null);
      createdPickup = localRecord;
      return { records: [localRecord], driverId: formData.driver_id, deliveryDate: formData.delivery_date };
    },
    // Skip per-pickup optimization — the batch optimizer runs ONCE when the user
    // clicks "Done" (handleBatchSave → performRouteOptimization). This drops the
    // per-pickup time from ~20-30s (HERE API polyline + stop ordering) to ~1-2s
    // (single backend create). Multiple pickups can be added rapidly in succession.
    runOptimizer: false,
    applyLocalUI: null, // pickup is reflected via the deliveriesUpdated broadcast in the wrapper
  });

  const routeDriverId = formData.driver_id;
  const routeDeliveryDate = formData.delivery_date;

  setHasChanges(false);
  setPickupsAddedCount((prev) => prev + 1);
  addedPickupRoutesRef.current.push({ driverId: routeDriverId, deliveryDate: routeDeliveryDate });
  setError(null);

  // Clear form so user can add another pickup without reopening
  handleClearForm();

  return createdPickup;
};