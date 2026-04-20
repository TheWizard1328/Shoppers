import { format, subDays } from 'date-fns';
import { offlineDB } from './offlineDatabase';
import { entities } from './dataManagerEntities';
import { waitForRateLimit } from './dataManagerRateLimit';

export const getDeliveriesForDateRange = async (startDate, endDate, filters = {}, forceRefresh = false) => {
  try {
    const allOfflineDeliveries = await offlineDB.getAll(offlineDB.STORES.DELIVERIES);
    const filtered = allOfflineDeliveries.filter((d) => {
      if (!d?.delivery_date) return false;
      if (d.delivery_date < startDate || d.delivery_date > endDate) return false;
      for (const [key, value] of Object.entries(filters)) {
        if (d[key] !== value) return false;
      }
      return true;
    });

    if (filtered.length > 0) {
      return filtered;
    }
  } catch {}

  const rangeFilters = {
    ...filters,
    delivery_date: {
      $gte: startDate,
      $lte: endDate
    }
  };

  try {
    await waitForRateLimit();
    const deliveries = await entities.Delivery.filter(rangeFilters, '-updated_date');
    if (Array.isArray(deliveries) && deliveries.length > 0) {
      await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, deliveries);
    }
    return deliveries;
  } catch {
    try {
      const allOfflineDeliveries = await offlineDB.getAll(offlineDB.STORES.DELIVERIES);
      return allOfflineDeliveries.filter((d) => {
        if (!d?.delivery_date) return false;
        return d.delivery_date >= startDate && d.delivery_date <= endDate;
      });
    } catch {
      return [];
    }
  }
};

export const loadDeliveriesForDate = async (dateStr, filters = {}, forceRefresh = false) => {
  const { driver_id, ...filtersWithoutDriver } = filters;

  try {
    let offlineData = await offlineDB.getByIndex(offlineDB.STORES.DELIVERIES, 'delivery_date', dateStr);
    if (filtersWithoutDriver.store_id) {
      const storeIds = filtersWithoutDriver.store_id.$in || [filtersWithoutDriver.store_id];
      offlineData = offlineData.filter((d) => storeIds.includes(d.store_id));
    }
    if (offlineData && offlineData.length > 0 && !forceRefresh) {
      return offlineData;
    }
  } catch {}

  const dateFilters = {
    ...filtersWithoutDriver,
    delivery_date: dateStr
  };

  try {
    await waitForRateLimit();
    const deliveries = await entities.Delivery.filter(dateFilters, '-updated_date');
    if (Array.isArray(deliveries) && deliveries.length > 0) {
      await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, deliveries);
      await offlineDB.updateSyncMetadata('Delivery', new Date().toISOString());
    }
    return deliveries;
  } catch (error) {
    try {
      const offlineData = await offlineDB.getByIndex(offlineDB.STORES.DELIVERIES, 'delivery_date', dateStr);
      if (offlineData && offlineData.length > 0) {
        return offlineData;
      }
    } catch {}

    if (error.message?.includes('WebSocket') || error.message?.includes('closed without opened') || error.response?.status === 429 || error.message?.includes('429')) {
      return [];
    }

    throw error;
  }
};

export const loadPriorityDeliveriesForSelection = async (dateStr, selectedDriverId = 'all', forceRefresh = true, extraFilters = {}) => {
  const apiFilters = { delivery_date: dateStr, ...extraFilters };
  const deliveries = await loadDeliveriesForDate(dateStr, apiFilters, forceRefresh);
  await offlineDB.updateCacheSnapshot('Delivery', deliveries || [], {
    scopeKey: `selection:${dateStr}:all`,
    syncType: 'selection_priority'
  });
  return deliveries || [];
};

export const loadDeliveries = async (
  selectedDateStr,
  priorityFilters = {},
  backgroundFilters = {},
  forceRefresh = false,
  onInitialLoadComplete = () => {},
  onFullMonthLoadComplete = () => {}
) => {
  let initialDeliveries = [];

  if (!forceRefresh) {
    try {
      const offlineDeliveries = await offlineDB.getByIndex(offlineDB.STORES.DELIVERIES, 'delivery_date', selectedDateStr);
      if (offlineDeliveries && offlineDeliveries.length > 0) {
        initialDeliveries = offlineDeliveries;
        setTimeout(() => {
          onInitialLoadComplete(offlineDeliveries);
        }, 0);
      }
    } catch {}
  }

  const shouldRefreshSelectedDate = forceRefresh || initialDeliveries.length === 0;

  if (shouldRefreshSelectedDate) {
    const selectedDateDeliveries = await loadDeliveriesForDate(selectedDateStr, priorityFilters, forceRefresh);
    if (Array.isArray(selectedDateDeliveries) && selectedDateDeliveries.length > 0) {
      initialDeliveries = selectedDateDeliveries;
      setTimeout(() => {
        onInitialLoadComplete(selectedDateDeliveries);
      }, 0);
    } else if (initialDeliveries.length > 0) {
      setTimeout(() => {
        onInitialLoadComplete(initialDeliveries);
      }, 0);
    }
  } else {
    loadDeliveriesForDate(selectedDateStr, priorityFilters, true)
      .then((freshDeliveries) => {
        if (Array.isArray(freshDeliveries) && freshDeliveries.length > 0) {
          onInitialLoadComplete(freshDeliveries);
        }
      })
      .catch(() => {});
  }

  return initialDeliveries;
};

export const loadFullMonthDeliveries = async (filters = {}, forceRefresh = false) => {
  const today = new Date();
  const deliveryMap = new Map();

  const past30Start = subDays(today, 30);
  const chunk1 = await getDeliveriesForDateRange(
    format(past30Start, 'yyyy-MM-dd'),
    format(today, 'yyyy-MM-dd'),
    filters,
    forceRefresh
  );
  chunk1.forEach((d) => deliveryMap.set(d.id, d));

  await new Promise((resolve) => setTimeout(resolve, 2000));

  const past60Start = subDays(today, 60);
  const past31Day = subDays(today, 31);
  const chunk2 = await getDeliveriesForDateRange(
    format(past60Start, 'yyyy-MM-dd'),
    format(past31Day, 'yyyy-MM-dd'),
    filters,
    forceRefresh
  );
  chunk2.forEach((d) => deliveryMap.set(d.id, d));

  await new Promise((resolve) => setTimeout(resolve, 2000));

  const past90Start = subDays(today, 90);
  const past61Day = subDays(today, 61);
  const chunk3 = await getDeliveriesForDateRange(
    format(past90Start, 'yyyy-MM-dd'),
    format(past61Day, 'yyyy-MM-dd'),
    filters,
    forceRefresh
  );
  chunk3.forEach((d) => deliveryMap.set(d.id, d));

  return Array.from(deliveryMap.values());
};