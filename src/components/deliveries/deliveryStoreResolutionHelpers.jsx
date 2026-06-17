export const resolveDefaultDriverForNewDelivery = ({
  currentUser,
  stores,
  drivers,
  allDrivers,
  deliveryDate,
  initialDriverId,
  userHasRole,
  getDriverNameForStorage,
  scheduledDriverMap = {}  // override-first map: storeId -> driverId (built from DriverScheduleOverride → store default)
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

  // Dispatchers: resolve with override-first priority:
  //   1. DriverScheduleOverride (via scheduledDriverMap, keyed by store_id)
  //   2. Store's default driver for the date's day-of-week slot
  if (isDispatcher && !isDriver) {
    const relevantStoreIds = (currentUser.store_ids || []);
    if (relevantStoreIds.length === 0) return { driverId: '', driverName: '' };

    const selectedDate = new Date((deliveryDate || new Date().toISOString().slice(0, 10)) + 'T00:00:00');
    const dayOfWeek = selectedDate.getDay();
    const prefix = dayOfWeek === 6 ? 'saturday' : dayOfWeek === 0 ? 'sunday' : 'weekday';

    for (const storeId of relevantStoreIds) {
      const store = stores.find((s) => s && s.id === storeId);
      if (!store) continue;

      // Priority 1: DriverScheduleOverride (pre-built map takes override → store default)
      const overrideDriverId = scheduledDriverMap[storeId];

      // Priority 2: Store default driver for AM slot, fall back to PM
      const storeDefaultDriverId =
        store[`${prefix}_am_driver_id`] ||
        store[`${prefix}_pm_driver_id`] ||
        null;

      const driverId = overrideDriverId || storeDefaultDriverId;
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

export const expandStoresForTimeSlots = ({ stores, deliveryDate }) => {
  const selectedDate = deliveryDate ? new Date(deliveryDate + 'T00:00:00') : new Date();
  const dayOfWeek = selectedDate.getDay();
  const isSaturday = dayOfWeek === 6;
  const isSunday = dayOfWeek === 0;

  const processedStores = [];

  (stores || []).forEach((store) => {
    if (!store) return;

    const amDriverId = isSaturday
      ? store.saturday_am_driver_id
      : isSunday
        ? store.sunday_am_driver_id
        : store.weekday_am_driver_id;

    const pmDriverId = isSaturday
      ? store.saturday_pm_driver_id
      : isSunday
        ? store.sunday_pm_driver_id
        : store.weekday_pm_driver_id;

    let addedSlot = false;

    if (amDriverId) {
      processedStores.push({
        ...store,
        id: `${store.id}_AM`,
        name: `${store.name} [AM]`,
        _originalStoreId: store.id,
        _timeSlot: 'AM'
      });
      addedSlot = true;
    }

    if (pmDriverId) {
      processedStores.push({
        ...store,
        id: `${store.id}_PM`,
        name: `${store.name} [PM]`,
        _originalStoreId: store.id,
        _timeSlot: 'PM'
      });
      addedSlot = true;
    }

    if (!addedSlot) {
      processedStores.push(store);
    }
  });

  return processedStores;
};