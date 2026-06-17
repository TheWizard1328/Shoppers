/**
 * Route change detection utilities
 * Determines if optimization will change route order or require polyline regeneration
 */

export const wouldRouteOrderChange = (currentRoute, optimizeResponse) => {
  if (!optimizeResponse || !Array.isArray(optimizeResponse.orderedDeliveryIds)) {
    return false;
  }

  const currentOrder = currentRoute.map((d) => d?.id);
  const newOrder = optimizeResponse.orderedDeliveryIds;

  if (currentOrder.length !== newOrder.length) {
    return true;
  }

  return !currentOrder.every((id, index) => id === newOrder[index]);
};

export const wouldOptimizationChangeOrder = (deliveries, driverId, deliveryDate) => {
  const routeDeliveries = deliveries.filter(
    (d) => d && d.driver_id === driverId && d.delivery_date === deliveryDate
  );

  if (routeDeliveries.length === 0) return false;

  // If there are pending deliveries mixed with active ones, optimization might reorder
  const hasPending = routeDeliveries.some((d) => d?.status === 'pending');
  const hasActive = routeDeliveries.some((d) => ['in_transit', 'en_route'].includes(d?.status));

  return hasPending && hasActive;
};

export const shouldRegeneratePolylines = (routeChanged, orderedDeliveryIds = []) => {
  // Only regenerate if the route order actually changed
  return routeChanged === true && Array.isArray(orderedDeliveryIds) && orderedDeliveryIds.length > 0;
};