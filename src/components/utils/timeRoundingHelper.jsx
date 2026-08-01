import { base44 } from "@/api/base44Client";

/**
 * Determines if this is the first or last FINISHED stop for the driver on this date.
 *
 * "First finished" = no other stops are already in a finished state (completed/failed/cancelled)
 * "Last finished" = no remaining active/pending stops after this completion
 *
 * This is based on COMPLETION ORDER, not stop_order position in the route.
 *
 * @param {Object} delivery - Current delivery being completed/failed/cancelled
 * @param {Array} allDeliveries - All deliveries for the driver
 * @param {Array} FINISHED_STATUSES - Array of finished status values
 * @returns {{ isFirstFinished: boolean, isLastFinished: boolean }}
 */
export function getFirstLastFinished(delivery, allDeliveries, FINISHED_STATUSES) {
  const allDriverDeliveries = allDeliveries.filter(d =>
    d && d.driver_id === delivery.driver_id && d.delivery_date === delivery.delivery_date
  );

  // Already-finished stops (excluding the current delivery being completed)
  const alreadyFinished = allDriverDeliveries.filter(d =>
    d.id !== delivery.id && FINISHED_STATUSES.includes(d.status)
  );

  // Remaining active/pending stops (excluding the current delivery)
  const remainingActive = allDriverDeliveries.filter(d =>
    d.id !== delivery.id && !FINISHED_STATUSES.includes(d.status)
  );

  return {
    isFirstFinished: alreadyFinished.length === 0,
    isLastFinished: remainingActive.length === 0,
  };
}

/**
 * Generates a local ISO timestamp string, rounding to 5-minute marks
 * for the first or last finished stop.
 *
 * Rounding rules:
 *   First finished stop → floor (round DOWN to previous 5-min mark)
 *   Last finished stop  → ceil  (round UP to next 5-min mark)
 *   Middle stops         → no rounding (exact time)
 *
 * If this is both the first AND last finished stop (only one stop),
 * first-finished rounding (floor) takes precedence.
 *
 * @param {Object} delivery - The current delivery object.
 * @param {Array} allDeliveries - All deliveries for the driver.
 * @param {Array} FINISHED_STATUSES - Array of finished status values.
 * @returns {string} The formatted local ISO timestamp string.
 */
export const generateCompletionTimestamp = (delivery, allDeliveries, FINISHED_STATUSES) => {
  const now = new Date();
  const currentTime = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    now.getHours(),
    now.getMinutes(),
    now.getSeconds(),
    0
  );

  const { isFirstFinished, isLastFinished } = getFirstLastFinished(delivery, allDeliveries, FINISHED_STATUSES);

  if (isFirstFinished || isLastFinished) {
    const fiveMin = 5 * 60 * 1000;
    const ms = currentTime.getTime();
    let roundedMs;

    if (isFirstFinished) {
      // First finished stop → floor to previous 5-min mark
      roundedMs = Math.floor(ms / fiveMin) * fiveMin;
    } else {
      // Last finished stop → ceil to next 5-min mark
      // If already exactly on a 5-min mark, don't round up
      if (ms % fiveMin === 0) {
        roundedMs = ms;
      } else {
        roundedMs = Math.ceil(ms / fiveMin) * fiveMin;
      }
    }

    currentTime.setTime(roundedMs);
  }

  return formatLocalTimestamp(currentTime);
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
  const cleaned = normalized.replace(/(Z|[+-]\d{2}:?\d{2})$/, '');
  const match = cleaned.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  const [, yearStr, monthStr, dayStr, hourStr, minuteStr, secondStr = '00'] = match;
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const hours = Number(hourStr);
  const minutes = Number(minuteStr);
  const seconds = Number(secondStr);
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(hours, minutes, seconds, 0);
  return Number.isNaN(date.getTime()) ? null : date;
};

export const shouldUseRegularTiming = ({ deliveryDate, todayDateString, currentTimeString }) => {
  if (!deliveryDate || !todayDateString) return false;
  if (deliveryDate !== todayDateString) return false;
  if (!currentTimeString) return true;

  const [hours = 0, minutes = 0] = String(currentTimeString).split(':').map(Number);
  const currentMinutes = hours * 60 + minutes;
  const retroCutoffMinutes = 21 * 60;

  return currentMinutes < retroCutoffMinutes;
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
  // DEBUG: Retro timing trace is intentionally verbose to diagnose local-vs-UTC drift

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

  // Use the most recently FINISHED stop (by actual_delivery_time) as the base,
  // not the previous stop by stop_order. This handles out-of-order completions
  // (e.g. completing stop #5 when stop #3 was the last finished stop).
  const finishedStatuses = ['completed', 'failed', 'cancelled'];
  const finishedStops = routeStops.filter(
    (item) => item?.id !== delivery.id && finishedStatuses.includes(item?.status) && item?.actual_delivery_time
  );
  const mostRecentFinished = finishedStops.length > 0
    ? finishedStops.reduce((latest, item) => {
        const t = parseLocalTimestamp(item.actual_delivery_time);
        const latestT = parseLocalTimestamp(latest.actual_delivery_time);
        return t && latestT && t > latestT ? item : latest;
      })
    : null;

  // Fall back to previous stop by stop_order if no finished stops exist
  const previousStop = mostRecentFinished || (currentIndex > 0 ? routeStops[currentIndex - 1] : null);
  const isFirstStop = !previousStop;
  let baseTime = null;
  let travelDistanceKm = Number(delivery?.travel_dist);

  if (isFirstStop) {
    const firstStopStartTime = getStoreFirstStopStartTime(delivery, stores);
    baseTime = parseDateTimeParts(delivery.delivery_date, firstStopStartTime);
  } else {
    const parsedActualDeliveryTime = parseLocalTimestamp(previousStop.actual_delivery_time);
    const parsedArrivalTime = parseLocalTimestamp(previousStop.arrival_time);
    const parsedDeliveryTimeStart = parseDateTimeParts(previousStop.delivery_date, previousStop.delivery_time_start || '09:00');

    baseTime = parsedActualDeliveryTime
      || parsedArrivalTime
      || parsedDeliveryTimeStart;

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
      baseTime = new Date(baseTime.getTime() + travelMinutes * 60000);
    }
  }

  if (!baseTime) return null;

  // Apply 5-min rounding for first/last finished stops (retroactive path)
  const { isFirstFinished, isLastFinished } = getFirstLastFinished(delivery, allDeliveries, ['completed', 'failed', 'cancelled']);
  if (isFirstFinished || isLastFinished) {
    const fiveMin = 5 * 60 * 1000;
    const ms = baseTime.getTime();
    let roundedMs;
    if (isFirstFinished) {
      roundedMs = Math.floor(ms / fiveMin) * fiveMin;
    } else {
      if (ms % fiveMin === 0) {
        roundedMs = ms;
      } else {
        roundedMs = Math.ceil(ms / fiveMin) * fiveMin;
      }
    }
    baseTime = new Date(roundedMs);
  }

  // baseTime = when driver arrives at the stop (end of travel)
  // actual_delivery_time = arrival + random 1-5 min (time spent at the door)
  const randomDwellMinutes = Math.floor(Math.random() * 5) + 1;
  const actualDeliveryTime = new Date(baseTime.getTime() + randomDwellMinutes * 60000);
  return {
    arrival_time: formatLocalTimestamp(baseTime),
    actual_delivery_time: formatLocalTimestamp(actualDeliveryTime),
    travel_dist: Number.isFinite(travelDistanceKm) ? travelDistanceKm : undefined,
  };
};

// Backward compatibility — some code imports isFirstOrLastStop
export function isFirstOrLastStop(delivery, allDeliveries, FINISHED_STATUSES) {
  const { isFirstFinished, isLastFinished } = getFirstLastFinished(delivery, allDeliveries, FINISHED_STATUSES);
  return isFirstFinished || isLastFinished;
}