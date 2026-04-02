import { offlineDB } from './offlineDatabase';
import { globalFilters } from './globalFilters';
import { base44 } from '@/api/base44Client';

export const OUTRAGEOUS_DRIVER_DAY_DELIVERY_COUNT = 100;

export async function getSelectedDriverDateDeliveryCount() {
  const selectedDate = globalFilters.getSelectedDate();
  const selectedDriverId = globalFilters.getSelectedDriverId();

  if (!selectedDate || !selectedDriverId || selectedDriverId === 'all') {
    return { selectedDate, selectedDriverId, count: 0, deliveries: [] };
  }

  const deliveries = await offlineDB.getByCompoundIndex(
    offlineDB.STORES.DELIVERIES,
    'date_driver',
    [selectedDate, selectedDriverId]
  );

  return {
    selectedDate,
    selectedDriverId,
    count: deliveries?.length || 0,
    deliveries: deliveries || []
  };
}

export async function purgeSelectedDriverDateDeliveries(driverId, selectedDate) {
  const deliveries = await offlineDB.getByCompoundIndex(
    offlineDB.STORES.DELIVERIES,
    'date_driver',
    [selectedDate, driverId]
  );

  if (!deliveries?.length) {
    return { deleted: 0 };
  }

  await Promise.all(
    deliveries.map((delivery) => offlineDB.deleteRecord(offlineDB.STORES.DELIVERIES, delivery.id))
  );

  return { deleted: deliveries.length };
}

export async function reconcileSelectedDriverDateDeliveries(driverId, selectedDate) {
  if (!driverId || !selectedDate) return { skipped: true };

  const response = await base44.functions.invoke('cleanDriverDeliveriesForDate', {
    driverId,
    deliveryDate: selectedDate,
    threshold: OUTRAGEOUS_DRIVER_DAY_DELIVERY_COUNT
  });

  const onlineDeliveries = await base44.entities.Delivery.filter({
    driver_id: driverId,
    delivery_date: selectedDate
  }, '-created_date', 1000);

  await Promise.all(
    (onlineDeliveries || []).map((delivery) => offlineDB.save(offlineDB.STORES.DELIVERIES, delivery))
  );

  return {
    cleaned: response?.data || response,
    restoredCount: onlineDeliveries?.length || 0
  };
}

export async function recoverIfSelectedDriverDateIsOutrageous() {
  const { selectedDate, selectedDriverId, count } = await getSelectedDriverDateDeliveryCount();

  if (!selectedDate || !selectedDriverId || selectedDriverId === 'all') {
    return { skipped: true, reason: 'no_specific_driver_selected' };
  }

  if (count <= OUTRAGEOUS_DRIVER_DAY_DELIVERY_COUNT) {
    return { skipped: true, reason: 'within_threshold', count };
  }

  const purgeResult = await purgeSelectedDriverDateDeliveries(selectedDriverId, selectedDate);
  const reconcileResult = await reconcileSelectedDriverDateDeliveries(selectedDriverId, selectedDate);

  return {
    recovered: true,
    selectedDate,
    selectedDriverId,
    originalCount: count,
    purged: purgeResult.deleted,
    restored: reconcileResult.restoredCount
  };
}