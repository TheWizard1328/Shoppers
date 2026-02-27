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
  );
  
  const incompleteStopsForDriver = allDriverDeliveries.filter(d => 
    !FINISHED_STATUSES.includes(d.status) && d.status !== 'pending'
  ).sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
  
  if (incompleteStopsForDriver.length === 0) return false;
  
  const isFirstStop = incompleteStopsForDriver[0].id === delivery.id;
  const isLastStop = incompleteStopsForDriver[incompleteStopsForDriver.length - 1].id === delivery.id;
  
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
  let hours, minutes;

  if (shouldRound) {
    const totalMinutes = currentTime.getHours() * 60 + currentTime.getMinutes();
    const roundedMinutes = Math.round(totalMinutes / 5) * 5;
    hours = String(Math.floor(roundedMinutes / 60)).padStart(2, '0');
    minutes = String(roundedMinutes % 60).padStart(2, '0');
  } else {
    hours = String(currentTime.getHours()).padStart(2, '0');
    minutes = String(currentTime.getMinutes()).padStart(2, '0');
  }

  const year = currentTime.getFullYear();
  const month = String(currentTime.getMonth() + 1).padStart(2, '0');
  const day = String(currentTime.getDate()).padStart(2, '0');
  const seconds = '00'; // Always '00' for consistency with 5-minute rounding

  // Return LOCAL timestamp without any timezone offset suffix (e.g., 2026-02-26T16:36:00)
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
}