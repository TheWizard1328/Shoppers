import { format } from 'date-fns';
import { getDriverDisplayName } from '../utils/driverUtils';
import { sortUsers } from '../utils/sorting';
import { userHasRole } from '../utils/userRoles';

export function getRouteScopedStoreOptions(selectedDateDeliveries = [], stores = []) {
  const counts = (selectedDateDeliveries || []).reduce((acc, delivery) => {
    if (delivery?.store_id && delivery?.patient_id) acc[delivery.store_id] = (acc[delivery.store_id] || 0) + 1;
    return acc;
  }, {});

  return (stores || [])
    .filter((store) => counts[store.id])
    .sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity) || (a.name || '').localeCompare(b.name || ''))
    .map((store) => ({
      ...store,
      deliveryCount: counts[store.id] || 0,
      label: `${store.name} (${counts[store.id] || 0})`
    }));
}

export function getDriverFilterOptions({ effectiveDrivers = [], effectiveDeliveries = [], selectedDate, currentUser, driverFilter }) {
  return sortUsers(
    (effectiveDrivers || []).filter((d) => userHasRole(d, 'driver') && (() => {
      // Always include the currently selected driver so it doesn't vanish from the dropdown
      if (driverFilter !== 'all' && d.id === driverFilter) return true;
      const selectedDateString = selectedDate ? format(selectedDate, 'yyyy-MM-dd') : null;
      if (!selectedDateString) return true;
      const isDispatcher = userHasRole(currentUser, 'dispatcher') && !userHasRole(currentUser, 'admin');
      const dispatcherStoreIds = isDispatcher ? new Set(currentUser.store_ids || []) : null;
      // When viewing all drivers, include any driver who has deliveries in the full loaded dataset
      // (not just selected date) so switching drivers doesn't clear the list
      return (effectiveDeliveries || []).some((delivery) =>
        delivery &&
        (!dispatcherStoreIds || !delivery.store_id || dispatcherStoreIds.has(delivery.store_id)) &&
        ((delivery.driver_id && (delivery.driver_id === d.id || delivery.driver_id === d.appUserId)) ||
          (delivery.driver_name && (delivery.driver_name === d.full_name || delivery.driver_name === d.user_name)))
      );
    })())
  ).map((driver) => {
    const duplicateNames = (effectiveDrivers || []).filter((d) => getDriverDisplayName(d) === getDriverDisplayName(driver));
    return {
      id: driver.id,
      label: duplicateNames.length > 1 ? `${getDriverDisplayName(driver)} (${driver.id.slice(-4)})` : getDriverDisplayName(driver)
    };
  });
}

export function applyRouteToolbarFilters({ selectedDateDeliveries = [], storeFilter = 'all', statusFilter = 'all', searchTerm = '', effectivePatients = [], stores = [], sortDeliveriesByTime }) {
  let filtered = selectedDateDeliveries;

  if (storeFilter && storeFilter !== 'all') {
    filtered = filtered.filter((delivery) => delivery.store_id === storeFilter);
  }

  if (statusFilter && statusFilter !== 'all') {
    filtered = filtered.filter((delivery) => delivery.status === statusFilter);
  }

  if (searchTerm) {
    const lowerSearch = searchTerm.toLowerCase();
    filtered = filtered.filter((delivery) => {
      const patient = effectivePatients.find((p) => p.id === delivery.patient_id);
      const store = stores.find((s) => s.id === delivery.store_id);
      return (
        (patient?.full_name || '').toLowerCase().includes(lowerSearch) ||
        (patient?.address || '').toLowerCase().includes(lowerSearch) ||
        (delivery.driver_name || '').toLowerCase().includes(lowerSearch) ||
        (store?.name || '').toLowerCase().includes(lowerSearch) ||
        (delivery.prescription_number || '').toLowerCase().includes(lowerSearch)
      );
    });
  }

  return sortDeliveriesByTime(filtered).map((delivery, index) => ({
    ...delivery,
    stopOrder: index + 1
  }));
}