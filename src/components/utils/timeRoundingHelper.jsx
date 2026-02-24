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