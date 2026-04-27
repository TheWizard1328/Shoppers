const FINISHED_PICKUP_STATUSES = ['completed', 'failed', 'cancelled', 'returned', 'picked_up'];

const isSameStore = (pickup, storeId) => pickup && pickup.store_id === storeId;
const isSameDriver = (pickup, driverId) => pickup && pickup.driver_id === driverId;
const isSameDate = (pickup, deliveryDate) => pickup && pickup.delivery_date === deliveryDate;
const isPickup = (delivery) => delivery && !delivery.patient_id;

export const getRoutePickupsForStore = ({ allDeliveries = [], stagedDeliveries = [], storeId, driverId, deliveryDate }) => {
  return [...allDeliveries, ...stagedDeliveries]
    .filter((delivery) =>
      isPickup(delivery) &&
      isSameStore(delivery, storeId) &&
      isSameDriver(delivery, driverId) &&
      isSameDate(delivery, deliveryDate)
    )
    .sort((a, b) => {
      const aFinished = FINISHED_PICKUP_STATUSES.includes(String(a?.status || '').toLowerCase());
      const bFinished = FINISHED_PICKUP_STATUSES.includes(String(b?.status || '').toLowerCase());
      if (aFinished !== bFinished) return aFinished ? 1 : -1;
      const aUpdated = new Date(a?.updated_date || a?.created_date || 0).getTime();
      const bUpdated = new Date(b?.updated_date || b?.created_date || 0).getTime();
      return bUpdated - aUpdated;
    });
};

export const choosePickupForNewDelivery = ({ pickups = [], fallbackPickup }) => {
  const activePickup = pickups.find((pickup) => !FINISHED_PICKUP_STATUSES.includes(String(pickup?.status || '').toLowerCase()));
  return activePickup || fallbackPickup || null;
};

export const buildPickupSelectValue = (pickup) => {
  if (!pickup) return '';
  return pickup.id || pickup.stop_id || pickup.puid || pickup._tempId || '';
};

export const buildPendingNewPickup = ({ store, formData, driverName, stopId }) => ({
  patient_id: '',
  patient_name: 'Pickup',
  store_id: store.id,
  store_name: store.name,
  store_abbreviation: store.abbreviation,
  store_phone: store.phone || '',
  delivery_date: formData.delivery_date,
  driver_id: formData.driver_id,
  driver_name: driverName || formData.driver_name || '',
  ampm_deliveries: formData.ampm_deliveries || 'AM',
  status: 'en_route',
  stop_id: stopId,
  puid: stopId,
  delivery_address: store.address,
  latitude: store.latitude,
  longitude: store.longitude,
  extra_time: formData.extra_time || 15,
  _tempId: `pending-pickup-${stopId}`,
  _pendingCreate: true
});