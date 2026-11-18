const FINISHED_STATUSES = ['completed', 'failed', 'cancelled'];
const ACTIVE_STATUSES = ['in_transit', 'en_route'];

// Local hour (24h) at which a finished route locks: Edit/Restart/Delete stop
// being offered to the driver for that day. App Owner and admin are exempt.
const ROUTE_LOCK_HOUR_LOCAL = 21;

const getLocalDateString = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};

export function isRouteCompleted(delivery, allDeliveries) {
  if (!delivery || !allDeliveries || !Array.isArray(allDeliveries)) return false;
  if (!FINISHED_STATUSES.includes(delivery.status)) return false;

  const driverDeliveriesForDate = allDeliveries.filter((d) => {
    if (!d) return false;
    return d.delivery_date === delivery.delivery_date && d.driver_id === delivery.driver_id;
  });

  if (driverDeliveriesForDate.length === 0) return false;

  const hasActiveStops = driverDeliveriesForDate.some((d) => ACTIVE_STATUSES.includes(d.status));
  if (hasActiveStops) return false;

  const now = new Date();
  const currentHour = now.getHours();
  const todayDateString = getLocalDateString();
  // OWNER RULE (Nov 17 2026): the route locks for the driver at 9:00 PM local,
  // not 8:00 PM. Until that hour the driver can still edit finished stops even
  // after the last one is completed.
  const isAfterLockHour = currentHour >= ROUTE_LOCK_HOUR_LOCAL;
  const isRouteDateInPast = String(delivery.delivery_date || '') < todayDateString;

  return isAfterLockHour || isRouteDateInPast;
}