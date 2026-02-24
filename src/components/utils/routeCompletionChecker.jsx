import { startOfDay } from 'date-fns';

const FINISHED_STATUSES = ['completed', 'failed', 'cancelled'];

export function isRouteCompleted(delivery, allDeliveries) {
  if (!delivery || !allDeliveries || !Array.isArray(allDeliveries)) return false;

  const driverDeliveriesForDate = allDeliveries.filter((d) => {
    if (!d) return false;
    return d.delivery_date === delivery.delivery_date && d.driver_id === delivery.driver_id;
  });

  if (driverDeliveriesForDate.length === 0) return false;

  const allFinished = driverDeliveriesForDate.every((d) => FINISHED_STATUSES.includes(d.status));
  if (!allFinished) return false;

  // Route is complete if all stops are finished AND:
  // 1. Current local time is after 20:00, OR
  // 2. The route date is in the past
  const now = new Date();
  const currentHour = now.getHours();
  const routeDate = startOfDay(new Date(delivery.delivery_date + 'T00:00:00'));
  const today = startOfDay(now);

  const isAfter8PM = currentHour >= 20;
  const isRouteDateInPast = routeDate.getTime() < today.getTime();

  return isAfter8PM || isRouteDateInPast;
}