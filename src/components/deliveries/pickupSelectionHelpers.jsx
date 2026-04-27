const FINISHED_PICKUP_STATUSES = ['completed', 'failed', 'cancelled', 'returned', 'picked_up'];

const isSameStore = (pickup, storeId) => pickup && pickup.store_id === storeId;
const isSameDriver = (pickup, driverId) => pickup && pickup.driver_id === driverId;
const isSameDate = (pickup, deliveryDate) => pickup && pickup.delivery_date === deliveryDate;
const isPickup = (delivery) => delivery && !delivery.patient_id;
const normalizeTimeSlot = (pickup) => pickup?.ampm_deliveries || 'AM';
const buildPickupOptionId = (pickup) => pickup?.id || pickup?.stop_id || pickup?.puid || pickup?._tempId || '';
const FINISHED_PICKUP_STATUSES = ['completed', 'failed', 'cancelled', 'returned', 'picked_up'];

const formatPickupTime = (value) => {
  if (!value) return '';
  if (/^\d{2}:\d{2}$/.test(value)) return value;
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  const match = String(value).match(/(\d{2}:\d{2})/);
  return match ? match[1] : '';
};

const buildPickupOptionLabel = (storeName, timeSlot, pickup) => {
  const status = String(pickup?.status || '').toLowerCase();
  const timeValue = FINISHED_PICKUP_STATUSES.includes(status)
    ? pickup?.actual_delivery_time
    : status === 'en_route'
      ? pickup?.delivery_time_eta
      : '';
  const timeLabel = formatPickupTime(timeValue);
  return timeLabel
    ? `${storeName} [${timeSlot}] (${timeLabel})`
    : `${storeName} [${timeSlot}]`;
};

export const getStorePickupOptions = ({
  store,
  allDeliveries = [],
  stagedDeliveries = [],
  driverId,
  deliveryDate,
  officialStoreOptions = []
}) => {
  if (!store?.id || !deliveryDate) return officialStoreOptions;

  const existingPickups = [...allDeliveries, ...stagedDeliveries]
    .filter((delivery) =>
      isPickup(delivery) &&
      isSameStore(delivery, store.id) &&
      isSameDate(delivery, deliveryDate) &&
      (!driverId || isSameDriver(delivery, driverId))
    )
    .sort((a, b) => {
      const aFinished = FINISHED_PICKUP_STATUSES.includes(String(a?.status || '').toLowerCase());
      const bFinished = FINISHED_PICKUP_STATUSES.includes(String(b?.status || '').toLowerCase());
      if (aFinished !== bFinished) return aFinished ? 1 : -1;
      const slotOrder = { AM: 0, PM: 1 };
      const slotDiff = (slotOrder[normalizeTimeSlot(a)] ?? 99) - (slotOrder[normalizeTimeSlot(b)] ?? 99);
      if (slotDiff !== 0) return slotDiff;
      const aUpdated = new Date(a?.updated_date || a?.created_date || 0).getTime();
      const bUpdated = new Date(b?.updated_date || b?.created_date || 0).getTime();
      return bUpdated - aUpdated;
    });

  const optionMap = new Map();

  existingPickups.forEach((pickup) => {
    const optionId = buildPickupOptionId(pickup);
    if (!optionId) return;
    optionMap.set(optionId, {
      ...store,
      id: optionId,
      name: buildPickupOptionLabel(store.name, normalizeTimeSlot(pickup), pickup),
      _originalStoreId: store.id,
      _timeSlot: normalizeTimeSlot(pickup),
      _pickupStatus: pickup.status,
      _pickupId: pickup.id,
      _pickupStopId: pickup.stop_id,
      _pickupPuid: pickup.puid
    });
  });

  const existingPickupBaseStoreIds = new Set(existingPickups.map((pickup) => pickup?.store_id).filter(Boolean));

  officialStoreOptions.forEach((option) => {
    if (!option?.id) return;
    const optionBaseStoreId = option._originalStoreId || option.id;
    const isBaseStoreOption = !option._timeSlot && option.id === optionBaseStoreId;
    if (isBaseStoreOption && existingPickupBaseStoreIds.has(optionBaseStoreId)) return;
    if (!optionMap.has(option.id)) {
      optionMap.set(option.id, option);
    }
  });

  return Array.from(optionMap.values());
};

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
  const firstEnRoutePickup = pickups.find((pickup) => String(pickup?.status || '').toLowerCase() === 'en_route');
  if (firstEnRoutePickup) return firstEnRoutePickup;

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