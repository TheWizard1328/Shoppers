/**
 * Determines completion time - rounds only first and last stops
 * @param {Date} currentTime - Current time
 * @param {Object} delivery - Current delivery being completed
 * @param {Array} allDeliveries - All deliveries for the driver
 * @param {Array} FINISHED_STATUSES - Array of finished status values
 * @returns {Object} - { hours, minutes, shouldRound }
 */
export function getCompletionTime(currentTime, delivery, allDeliveries, FINISHED_STATUSES) {
  const allDriverDeliveries = allDeliveries.filter(d => 
    d && d.driver_id === delivery.driver_id && d.delivery_date === delivery.delivery_date
  );
  
  const incompleteStopsForDriver = allDriverDeliveries.filter(d => 
    !FINISHED_STATUSES.includes(d.status) && d.status !== 'pending'
  ).sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
  
  const isFirstStop = incompleteStopsForDriver.length > 0 && incompleteStopsForDriver[0].id === delivery.id;
  const isLastStop = incompleteStopsForDriver.length > 0 && incompleteStopsForDriver[incompleteStopsForDriver.length - 1].id === delivery.id;
  const shouldRound = isFirstStop || isLastStop;

  let hours, minutes;
  if (shouldRound) {
    const totalMinutes = currentTime.getHours() * 60 + currentTime.getMinutes();
    const roundedMinutes = Math.round(totalMinutes / 5) * 5;
    const roundedHours = Math.floor(roundedMinutes / 60);
    const roundedMins = roundedMinutes % 60;
    hours = String(roundedHours).padStart(2, '0');
    minutes = String(roundedMins).padStart(2, '0');
  } else {
    hours = String(currentTime.getHours()).padStart(2, '0');
    minutes = String(currentTime.getMinutes()).padStart(2, '0');
  }

  return { hours, minutes, shouldRound };
}