/**
 * interStoreDriverResolver.jsx
 * Auto-selects the driver for an InterStore (ISP/ISD) transfer by checking the
 * DriverScheduleOverride-aware scheduledDriverMap for the From (source) store,
 * falling back to the To (destination) store.
 *
 * Priority:
 *   1. From store's scheduled override / default driver (scheduledDriverMap[storeId])
 *      — slot-specific keys (storeId_AM / storeId_PM) are consulted if the base
 *        key has no entry.
 *   2. To store's scheduled override / default driver (same lookup).
 *   3. Current user, if they are a pure driver (sole driver auto-selects themselves).
 *
 * Respects the From store first because the driver physically originates at the
 * From store (e.g. Robert picks up at Hamptons → delivers to Callingwood, even if
 * Callingwood's scheduled driver for the day is someone else).
 */

/**
 * @param {object} args
 * @param {object} args.formData
 * @param {Array}  args.stores        — app Store entities
 * @param {Array}  args.allDrivers    — driver user records
 * @param {object} args.scheduledDriverMap — storeId[_AM|_PM] -> driverId (built from DriverScheduleOverride)
 * @param {object} args.currentUser
 * @param {function} args.getDriverNameForStorage
 * @param {function} args.userHasRole
 * @returns {{ driverId: string, driverName: string }}
 */
export function resolveInterStoreDriver({
  formData,
  stores,
  allDrivers,
  scheduledDriverMap,
  currentUser,
  getDriverNameForStorage,
  userHasRole,
}) {
  const findStoreByName = (name) => {
    if (!name || !stores?.length) return null;
    const lower = name.toLowerCase().trim();
    return stores.find((s) => s && s.name && s.name.toLowerCase().trim() === lower)
      || stores.find((s) => s && s.name && s.name.toLowerCase().includes(lower))
      || null;
  };

  const findDriverById = (driverId) => {
    if (!driverId) return null;
    return (allDrivers || []).find((d) => d && (d.id === driverId || d.user_id === driverId)) || null;
  };

  // Pick the driver for a store from the scheduled-override map.
  // Base key (storeId) holds the override-or-AM-default driver; fall back to slot keys.
  const driverForStore = (store) => {
    if (!store?.id) return null;
    const baseId = scheduledDriverMap?.[store.id];
    const amId = scheduledDriverMap?.[`${store.id}_AM`];
    const pmId = scheduledDriverMap?.[`${store.id}_PM`];
    const resolvedId = baseId || amId || pmId;
    return findDriverById(resolvedId);
  };

  const fromStore = findStoreByName(formData._interstore_source_name);
  const toStore = findStoreByName(formData._interstore_dest_name);

  const fromDriver = driverForStore(fromStore);
  if (fromDriver) {
    return { driverId: fromDriver.id, driverName: getDriverNameForStorage(fromDriver) };
  }
  const toDriver = driverForStore(toStore);
  if (toDriver) {
    return { driverId: toDriver.id, driverName: getDriverNameForStorage(toDriver) };
  }

  // Sole drivers always auto-select themselves.
  const isSoleDriver = userHasRole?.(currentUser, 'driver')
    && !userHasRole?.(currentUser, 'admin')
    && !userHasRole?.(currentUser, 'dispatcher');
  if (isSoleDriver && currentUser?.id) {
    const self = findDriverById(currentUser.id);
    if (self) return { driverId: self.id, driverName: getDriverNameForStorage(self) };
  }

  return { driverId: '', driverName: '' };
}