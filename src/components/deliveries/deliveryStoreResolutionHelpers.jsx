import { getVisiblePickupSlotsForDate } from '../utils/ampmUtils';

export const resolveDefaultDriverForNewDelivery = ({
  currentUser,
  stores,
  drivers,
  allDrivers,
  deliveryDate,
  initialDriverId,
  userHasRole,
  getDriverNameForStorage,
  scheduledDriverMap = {},  // override-first map: storeId -> driverId (built from DriverScheduleOverride → store default)
  allDeliveries = []
}) => {
  if (!currentUser || !stores || !drivers) {
    return { driverId: '', driverName: '' };
  }

  const isDriver = userHasRole(currentUser, 'driver');
  const isDispatcher = userHasRole(currentUser, 'dispatcher');
  const isAdmin = userHasRole(currentUser, 'admin');

  if (isDriver && !isAdmin && !isDispatcher) {
    const resolvedDriverId = initialDriverId && initialDriverId !== 'all' ? initialDriverId : currentUser.id;
    const currentUserDriver = (allDrivers || []).find((driver) => driver?.id === resolvedDriverId);

    if (currentUserDriver) {
      return {
        driverId: resolvedDriverId,
        driverName: getDriverNameForStorage(currentUserDriver)
      };
    }
  }

  // Admins: always start with no driver selected ("All Drivers")
  if (isAdmin) {
    return { driverId: '', driverName: '' };
  }

  // Dispatchers: resolve with 3-tier priority:
  //   1. Driver who already has a store pickup for the dispatcher's store on this date
  //   2. DriverScheduleOverride (via scheduledDriverMap, keyed by store_id)
  //   3. Store's default driver for the date's day-of-week slot
  if (isDispatcher && !isDriver) {
    const relevantStoreIds = (currentUser.store_ids || []);
    if (relevantStoreIds.length === 0) return { driverId: '', driverName: '' };

    const selectedDate = new Date((deliveryDate || new Date().toISOString().slice(0, 10)) + 'T00:00:00');
    const dayOfWeek = selectedDate.getDay();
    const prefix = dayOfWeek === 6 ? 'saturday' : dayOfWeek === 0 ? 'sunday' : 'weekday';

    for (const storeId of relevantStoreIds) {
      const store = stores.find((s) => s && s.id === storeId);
      if (!store) continue;

      // Priority 1: Driver who already has a store pickup for this store on this date
      const existingPickupDriverId = deliveryDate && allDeliveries.length > 0
        ? (allDeliveries.find((d) =>
            d && !d.patient_id &&
            d.store_id === storeId &&
            d.delivery_date === deliveryDate &&
            d.driver_id &&
            !['cancelled', 'failed'].includes(d.status)
          )?.driver_id || null)
        : null;

      // Priority 2: DriverScheduleOverride (pre-built map takes override → store default)
      const overrideDriverId = scheduledDriverMap[storeId];

      // Priority 3: Store default driver for AM slot, fall back to PM
      const storeDefaultDriverId =
        store[`${prefix}_am_driver_id`] ||
        store[`${prefix}_pm_driver_id`] ||
        null;

      const driverId = existingPickupDriverId || overrideDriverId || storeDefaultDriverId;
      if (!driverId) continue;

      const driver = (allDrivers || drivers || []).find((d) => d && (d.id === driverId || d.user_id === driverId));
      if (driver) {
        return {
          driverId: driver.id,
          driverName: getDriverNameForStorage(driver)
        };
      }
    }
  }

  return { driverId: '', driverName: '' };
};

export const expandStoresForTimeSlots = ({ stores, deliveryDate, now = new Date() }) => {
  // Slot visibility is dictated by the 2:00 PM cutoff (see getVisiblePickupSlotsForDate):
  // today before 2 PM → both slots; today at/after 2 PM → PM only; future/past dates → both.
  // Unlike the old behavior, BOTH slots are always offered per store even when the store has
  // no scheduled driver for that slot — dispatchers can still create after-hours pickups
  // (e.g. a PM pickup for an AM-only store); the form just requires manual driver selection.
  const visibleSlots = getVisiblePickupSlotsForDate(deliveryDate, now);

  const processedStores = [];

  (stores || []).forEach((store) => {
    if (!store) return;

    visibleSlots.forEach((slot) => {
      processedStores.push({
        ...store,
        id: `${store.id}_${slot}`,
        name: `${store.name} [${slot}]`,
        _originalStoreId: store.id,
        _timeSlot: slot
      });
    });
  });

  return processedStores;
};