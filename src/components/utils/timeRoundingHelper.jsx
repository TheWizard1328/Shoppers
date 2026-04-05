import { base44 } from "@/api/base44Client";

/**
 * Determines if this is the first or last incomplete stop for the driver on this date
 * @param {Object} delivery - Current delivery being completed
 * @param {Array} allDeliveries - All deliveries for the driver
 * @param {Array} FINISHED_STATUSES - Array of finished status values
 * @returns {boolean} - true if this is the first or last stop
 */
export function isFirstOrLastStop(delivery, allDeliveries, FINISHED_STATUSES) {
  const allDriverDeliveries = allDeliveries.filter(d => 
    d && d.driver_id === delivery.driver_id && d.delivery_date === delivery.delivery_date
  ).sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
  
  if (allDriverDeliveries.length === 0) return false;
  
  const isFirstStop = allDriverDeliveries[0].id === delivery.id;
  const isLastStop = allDriverDeliveries[allDriverDeliveries.length - 1].id === delivery.id;
  
  return isFirstStop || isLastStop;
}

/**
 * Generates a local ISO timestamp string, rounding to the nearest 5 minutes
 * only if it's the first or last incomplete stop for the driver on the current date.
 *
 * @param {Object} delivery - The current delivery object.
 * @param {Array} allDeliveries - All deliveries for the driver.
 * @param {Array} FINISHED_STATUSES - Array of finished status values.
 * @returns {string} The formatted local ISO timestamp string.
 */
export const generateCompletionTimestamp = (delivery, allDeliveries, FINISHED_STATUSES) => {
  const currentTime = new Date();
  const shouldRound = isFirstOrLastStop(delivery, allDeliveries, FINISHED_STATUSES);
  let hours;
  let minutes;

  if (shouldRound) {
    let roundedMinutes = Math.round(currentTime.getMinutes() / 5) * 5;
    let roundedHours = currentTime.getHours();

    if (roundedMinutes === 60) {
      roundedMinutes = 0;
      roundedHours += 1;
    }

    if (roundedHours === 24) {
      roundedHours = 0;
    }

    hours = String(roundedHours).padStart(2, '0');
    minutes = String(roundedMinutes).padStart(2, '0');
  } else {
    hours = String(currentTime.getHours()).padStart(2, '0');
    minutes = String(currentTime.getMinutes()).padStart(2, '0');
  }

  const year = currentTime.getFullYear();
  const month = String(currentTime.getMonth() + 1).padStart(2, '0');
  const day = String(currentTime.getDate()).padStart(2, '0');
  const seconds = '00';

  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
};

const pad = (value) => String(value).padStart(2, '0');

const formatLocalTimestamp = (date) => {
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
};

export const parseLocalTimestamp = (value) => {
  if (!value || typeof value !== 'string') return null;
  const normalized = value.includes('T') ? value : `${value}T00:00:00`;
  const [datePart, timePartRaw = '00:00:00'] = normalized.split('T');
  const [year, month, day] = datePart.split('-').map(Number);
  const timePart = timePartRaw.replace(/(Z|[+-]\d{2}:?\d{2})$/, '');
  const [hours = 0, minutes = 0, seconds = 0] = timePart.split(':').map(Number);
  const date = new Date(year, (month || 1) - 1, day || 1, hours || 0, minutes || 0, seconds || 0, 0);
  return Number.isNaN(date.getTime()) ? null : date;
};

export const shouldUseRegularTiming = ({ deliveryDate, todayDateString }) => {
  if (!deliveryDate || !todayDateString) return false;
  return deliveryDate === todayDateString;
};

const parseDateTimeParts = (dateString, timeString = '09:00') => {
  const [year, month, day] = String(dateString || '').split('-').map(Number);
  const [hours, minutes] = String(timeString || '09:00').split(':').map(Number);
  const date = new Date(year, (month || 1) - 1, day || 1, hours || 0, minutes || 0, 0, 0);
  return Number.isNaN(date.getTime()) ? null : date;
};

const getStopCoordinates = (delivery, patients = [], stores = []) => {
  const patient = delivery?.patient_id ? patients.find((item) => item?.id === delivery.patient_id || item?.patient_id === delivery.patient_id) : null;
  const store = stores.find((item) => item?.id === delivery?.store_id);
  const lat = delivery?.patient_id ? Number(patient?.latitude) : Number(store?.latitude);
  const lng = delivery?.patient_id ? Number(patient?.longitude) : Number(store?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
};

const getStoreFirstStopStartTime = (delivery, stores = []) => {
  const store = stores.find((item) => item?.id === delivery?.store_id);
  if (!store || !delivery?.delivery_date) return delivery?.delivery_time_start || '09:00';

  const dayOfWeek = new Date(`${delivery.delivery_date}T12:00:00`).getDay();
  const isPm = String(delivery?.ampm_deliveries || '').toUpperCase() === 'PM';

  if (dayOfWeek === 6) {
    return isPm ? (store.saturday_pm_start || delivery?.delivery_time_start || '09:00') : (store.saturday_am_start || delivery?.delivery_time_start || '09:00');
  }

  if (dayOfWeek === 0) {
    return isPm ? (store.sunday_pm_start || delivery?.delivery_time_start || '09:00') : (store.sunday_am_start || delivery?.delivery_time_start || '09:00');
  }

  return isPm ? (store.weekday_pm_start || delivery?.delivery_time_start || '09:00') : (store.weekday_am_start || delivery?.delivery_time_start || '09:00');
};

export const calculateRetroactiveStopTiming = async ({
  delivery,
  allDeliveries = [],
  patients = [],
  stores = [],
  todayDateString,
  allowSameDay = false
}) => {
  if (!delivery || !delivery.delivery_date || !todayDateString) return null;
  if (!allowSameDay && delivery.delivery_date === todayDateString) return null;
  if (delivery.delivery_date > todayDateString) return null;

  const routeStops = allDeliveries
    .filter((item) => item && item.driver_id === delivery.driver_id && item.delivery_date === delivery.delivery_date)
    .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));

  const currentIndex = routeStops.findIndex((item) => item?.id === delivery.id);
  if (currentIndex === -1) return null;

  const previousStop = currentIndex > 0 ? routeStops[currentIndex - 1] : null;
  const isFirstStop = !previousStop;
  let baseTime = null;
  let travelDistanceKm = Number(delivery?.travel_dist);

  console.warn('[RetroTiming] start', {
    deliveryId: delivery?.id,
    deliveryDate: delivery?.delivery_date,
    stopOrder: delivery?.stop_order,
    currentIndex,
    isFirstStop,
    previousStopId: previousStop?.id || null,
    previousStopActualDeliveryTime: previousStop?.actual_delivery_time || null,
    previousStopArrivalTime: previousStop?.arrival_time || null,
    previousStopDeliveryTimeStart: previousStop?.delivery_time_start || null,
    currentDeliveryTimeStart: delivery?.delivery_time_start || null
  });

  if (isFirstStop) {
    const firstStopStartTime = getStoreFirstStopStartTime(delivery, stores);
    baseTime = parseDateTimeParts(delivery.delivery_date, firstStopStartTime);
    console.warn('[RetroTiming] first stop base time', {
      deliveryId: delivery?.id,
      firstStopStartTime,
      parsedBaseTime: baseTime ? formatLocalTimestamp(baseTime) : null
    });
  } else {
    const parsedActualDeliveryTime = parseLocalTimestamp(previousStop.actual_delivery_time);
    const parsedArrivalTime = parseLocalTimestamp(previousStop.arrival_time);
    const parsedDeliveryTimeStart = parseDateTimeParts(previousStop.delivery_date, previousStop.delivery_time_start || '09:00');

    baseTime = parsedActualDeliveryTime
      || parsedArrivalTime
      || parsedDeliveryTimeStart;

    console.warn('[RetroTiming] previous stop time sources', {
      deliveryId: delivery?.id,
      previousStopId: previousStop?.id,
      rawActualDeliveryTime: previousStop?.actual_delivery_time || null,
      rawArrivalTime: previousStop?.arrival_time || null,
      rawDeliveryTimeStart: previousStop?.delivery_time_start || null,
      parsedActualDeliveryTime: parsedActualDeliveryTime ? formatLocalTimestamp(parsedActualDeliveryTime) : null,
      parsedArrivalTime: parsedArrivalTime ? formatLocalTimestamp(parsedArrivalTime) : null,
      parsedDeliveryTimeStart: parsedDeliveryTimeStart ? formatLocalTimestamp(parsedDeliveryTimeStart) : null,
      selectedBaseTime: baseTime ? formatLocalTimestamp(baseTime) : null
    });

    const origin = getStopCoordinates(previousStop, patients, stores);
    const destination = getStopCoordinates(delivery, patients, stores);

    if (baseTime && origin && destination) {
      const res = await base44.functions.invoke('getHereDirections', {
        origin: { lat: origin.lat, lng: origin.lng },
        destination: { lat: destination.lat, lng: destination.lng }
      });
      const data = res?.data || res || {};
      const travelMinutes = Number(data.estimated_duration_minutes) || 0;
      travelDistanceKm = Number(data.estimated_distance_km);
      console.warn('[RetroTiming] directions result', {
        deliveryId: delivery?.id,
        previousStopId: previousStop?.id,
        origin,
        destination,
        travelMinutes,
        travelDistanceKm,
        baseTimeBeforeTravel: formatLocalTimestamp(baseTime)
      });
      baseTime = new Date(baseTime.getTime() + travelMinutes * 60000);
      console.warn('[RetroTiming] base time after travel', {
        deliveryId: delivery?.id,
        computedBaseTime: formatLocalTimestamp(baseTime)
      });
    } else {
      console.warn('[RetroTiming] skipped directions', {
        deliveryId: delivery?.id,
        hasBaseTime: !!baseTime,
        origin,
        destination
      });
    }
  }

  if (!baseTime) {
    console.warn('[RetroTiming] no base time resolved', {
      deliveryId: delivery?.id,
      previousStopId: previousStop?.id || null
    });
    baseTime = parseDateTimeParts(delivery.delivery_date, delivery.delivery_time_start || '09:00');
  }

  if (!baseTime) {
    return null;
  }

  if (isFirstStop) {
    return {
      actual_delivery_time: formatLocalTimestamp(baseTime),
      arrival_time: formatLocalTimestamp(baseTime),
      ...(Number.isFinite(travelDistanceKm) ? { travel_dist: travelDistanceKm } : {})
    };
  }

  const arrivalTime = new Date(baseTime.getTime());
  const actualDeliveryTime = new Date(arrivalTime.getTime());

  return {
    actual_delivery_time: formatLocalTimestamp(actualDeliveryTime),
    arrival_time: formatLocalTimestamp(arrivalTime),
    ...(Number.isFinite(travelDistanceKm) ? { travel_dist: travelDistanceKm } : {})
  };
};