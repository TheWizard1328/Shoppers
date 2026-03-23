export const resolveDefaultDriverForNewDelivery = ({
  currentUser,
  stores,
  drivers,
  allDrivers,
  deliveryDate,
  initialDriverId,
  userHasRole,
  getDriverNameForStorage
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

  if (isDispatcher && !isDriver && !isAdmin) {
    const dispatcherStoreIds = currentUser.store_ids || [];
    if (dispatcherStoreIds.length === 1) {
      const dispatcherStore = stores.find((store) => store && store.id === dispatcherStoreIds[0]);
      if (!dispatcherStore) {
        return { driverId: '', driverName: '' };
      }

      const selectedDate = new Date(deliveryDate + 'T00:00:00');
      const dayOfWeek = selectedDate.getDay();
      const driverIdField = dayOfWeek === 6
        ? 'saturday_am_driver_id'
        : dayOfWeek === 0
          ? 'sunday_am_driver_id'
          : 'weekday_am_driver_id';

      const driverId = dispatcherStore[driverIdField];
      const driver = drivers.find((item) => item && item.id === driverId);

      if (driver) {
        return {
          driverId,
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

    if (amDriverId && pmDriverId) {
      processedStores.push({
        ...store,
        id: `${store.id}_AM`,
        name: `${store.name} [AM]`,
        _originalStoreId: store.id,
        _timeSlot: 'AM'
      });
      processedStores.push({
        ...store,
        id: `${store.id}_PM`,
        name: `${store.name} [PM]`,
        _originalStoreId: store.id,
        _timeSlot: 'PM'
      });
      return;
    }

    processedStores.push(store);
  });

  return processedStores;
};