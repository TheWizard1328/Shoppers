import { useState, useEffect, useCallback } from 'react';
import { base44 } from "@/api/base44Client";
import { edmontonWallString, parseAnyTimestamp } from './albertaTime';

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
  // Device-timezone-independent completion timestamp.
  // OLD BUG: this built the wall components from system-local Date getters
  // (getFullYear/getHours...). Devices with a broken or premature timezone
  // engine (e.g. a Windows tz update putting Alberta at UTC-7 before the
  // legislated change) generated timestamps a full hour off, which then got
  // stored as actual_delivery_time and activity-segment anchors.
  // NEW: take the true instant (clock is correct on every device; only the
  // tz ENGINE is unreliable) and convert to Edmonton wall time via pure UTC
  // math. Output format is unchanged: naive "YYYY-MM-DDTHH:mm:ss".
  const now = new Date();

  const { isFirstFinished, isLastFinished } = getFirstLastFinished(delivery, allDeliveries, FINISHED_STATUSES);

  let ms = now.getTime();
  if (isFirstFinished || isLastFinished) {
    const fiveMin = 5 * 60 * 1000;
    if (isFirstFinished) {
      // First finished stop → floor to previous 5-min mark
      ms = Math.floor(ms / fiveMin) * fiveMin;
    } else {
      // Last finished stop → ceil to next 5-min mark
      // If already exactly on a 5-min mark, don't round up
      if (ms % fiveMin === 0) {
        // keep
      } else {
        ms = Math.ceil(ms / fiveMin) * fiveMin;
      }
    }
  }

  return edmontonWallString(new Date(ms));
};

const pad = (value) => String(value).padStart(2, '0');

// Naive Edmonton wall string from a true UTC instant — pure math, no system-local
// getters (devices with premature tz data misreported local hours by 1).
const formatLocalTimestamp = (date) => edmontonWallString(date);

export const parseLocalTimestamp = (value) => {
  // Device-timezone-independent parse. Naive strings (no Z/offset) are Edmonton
  // wall time by storage convention — previously parsed via setHours/setFullYear
  // (device-local), which skewed by an hour on machines with premature tz data.
  if (!value) return null;
  const d = parseAnyTimestamp(typeof value === 'string' && !value.includes('T') ? `${value}T00:00:00` : value);
  return d && !Number.isNaN(d.getTime()) ? d : null;
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
      // OWNER REPORT (Oct 15 2026): last-stop retro completions were stamping
      // REAL times. The backdate chain needs travel minutes to the stop, and
      // this block made a LIVE getHereDirections call for it — a 429/timeout
      // THREW out of the whole calculator, and the completion flow's catch
      // silently fell back to the real wall clock. Resilience ladder, no
      // throw possible: (1) the route optimizer's stored leg duration
      // (estimated_duration_minutes — zero API calls, zero rate-limit
      // exposure, exactly what the leg was sequenced with); (2) live HERE
      // directions ONLY when the stored estimate is missing (failures
      // swallowed); (3) distance-based estimate from stored travel_dist
      // (~35 km/h city) or a 5-minute default.
      let travelMinutes = null;
      const _storedMinutes = Number(delivery?.estimated_duration_minutes);
      if (Number.isFinite(_storedMinutes) && _storedMinutes > 0) {
        travelMinutes = _storedMinutes;
      } else {
        try {
          const res = await base44.functions.invoke('getHereDirections', {
            origin: { lat: origin.lat, lng: origin.lng },
            destination: { lat: destination.lat, lng: destination.lng }
          });
          const data = res?.data || res || {};
          const _hereMinutes = Number(data.estimated_duration_minutes);
          if (Number.isFinite(_hereMinutes) && _hereMinutes > 0) travelMinutes = _hereMinutes;
          const _hereKm = Number(data.estimated_distance_km);
          if (Number.isFinite(_hereKm)) travelDistanceKm = _hereKm;
        } catch (_) { /* fall through to distance estimate */ }
      }
      if (travelMinutes == null) {
        const _km = Number(travelDistanceKm ?? delivery?.travel_dist);
        travelMinutes = Number.isFinite(_km) && _km > 0
          ? Math.max(2, Math.round((_km / 35) * 60))
          : 5;
      }
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

  // OWNER DIRECTIVE (Oct 14 2026): same finishing rounding as regular time.
  // generateCompletionTimestamp applies the 5-min first/last rounding to the
  // ACTUAL completion time; the retro path previously rounded only the arrival
  // base and then added an unrounded 1-5 min dwell, so a retro last stop never
  // landed on the 5-min grid (and the off-duty anchor inherited the off-grid
  // time). Round the post-dwell actual with the identical rules:
  // first finished -> floor, last finished -> ceil, middle -> exact.
  // (isFirst/isLast already computed above; reuse the same flags.)
  if (isFirstFinished || isLastFinished) {
    const fiveMinActual = 5 * 60 * 1000;
    const msActual = actualDeliveryTime.getTime();
    let roundedActualMs;
    if (isFirstFinished) {
      roundedActualMs = Math.floor(msActual / fiveMinActual) * fiveMinActual;
    } else if (msActual % fiveMinActual === 0) {
      roundedActualMs = msActual;
    } else {
      roundedActualMs = Math.ceil(msActual / fiveMinActual) * fiveMinActual;
    }
    actualDeliveryTime = new Date(roundedActualMs);
  }
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
// ── Retro-timing live flag (owner directive Oct 14 2026) ────────────────────
// The Complete-button arrival gate (footer + popup menu) must NEVER hold during
// retro times: retro completion backdates arrival_time itself, so the gate is
// bypassed entirely (today after 21:00, or any past-due date). The flag used
// to be computed once at render time — a memoized stop card rendered before
// 21:00 kept its stale "not retro" value after 21:00, leaving Complete dead
// during retro hours until an unrelated re-render. computeRetroTiming() is
// the pure core; useRetroTiming() re-evaluates it on a light 30s tick that
// only triggers a re-render when the flag actually flips (React bails on the
// identical setState, so the steady state costs nothing).
export const computeRetroTiming = (deliveryDate, now = new Date()) => {
  const todayDateString = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const currentTimeString = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const isFutureDate = !!deliveryDate && deliveryDate > todayDateString;
  const isRetroTiming = !!deliveryDate && !isFutureDate &&
    !shouldUseRegularTiming({ deliveryDate, todayDateString, currentTimeString });
  return { isFutureDate, isRetroTiming, todayDateString };
};

export const useRetroTiming = (deliveryDate) => {
  const compute = useCallback(() => computeRetroTiming(deliveryDate).isRetroTiming, [deliveryDate]);
  const [isRetroTiming, setIsRetroTiming] = useState(compute);
  useEffect(() => {
    const next = compute();
    setIsRetroTiming((prev) => (prev === next ? prev : next));
    const id = setInterval(() => {
      const cur = compute();
      setIsRetroTiming((prev) => (prev === cur ? prev : cur));
    }, 30000);
    return () => clearInterval(id);
  }, [compute]);
  return isRetroTiming;
};
