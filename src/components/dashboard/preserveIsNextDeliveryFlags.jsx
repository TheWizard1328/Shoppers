/**
 * Merges fresh API deliveries with locally-set isNextDelivery flags.
 *
 * When a stop is completed, we optimistically set isNextDelivery=true on the
 * next stop LOCALLY (Step 1 in handleStatusUpdate). The backend's setNextDeliveryFlag
 * runs asynchronously, so the API data fetched immediately after still has the OLD
 * (stale) isNextDelivery values. Without this helper, Step 9's bulkSave would
 * overwrite the correct optimistic flags, causing the "next delivery" badge to
 * visually revert until the WebSocket event arrives seconds later.
 *
 * @param {Array} freshDeliveries - Raw deliveries from API
 * @param {Array} localDeliveries - Current in-memory deliveries (deliveriesWithStopOrder)
 * @param {string} driverId - The driver whose route was updated
 * @param {string} deliveryDate - The delivery date
 * @returns {Array} freshDeliveries with isNextDelivery flags preserved from local state
 */
export function mergeWithLocalIsNextDeliveryFlags(freshDeliveries, localDeliveries, driverId, deliveryDate) {
  if (!Array.isArray(freshDeliveries) || !Array.isArray(localDeliveries)) {
    return freshDeliveries;
  }

  // Build a map of local isNextDelivery values for this driver/date
  const localFlagMap = new Map(
    localDeliveries
      .filter((d) => d && d.driver_id === driverId && d.delivery_date === deliveryDate)
      .map((d) => [d.id, d.isNextDelivery])
  );

  return freshDeliveries.map((d) => {
    if (!d?.id) return d;
    const localFlag = localFlagMap.get(d.id);
    // Only override if we have an explicit local value
    if (localFlag === undefined) return d;
    return { ...d, isNextDelivery: localFlag };
  });
}