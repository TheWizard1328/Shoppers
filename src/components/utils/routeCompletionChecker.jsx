const FINISHED_STATUSES = ['completed', 'failed', 'cancelled'];

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

  const allFinished = driverDeliveriesForDate.every((d) => FINISHED_STATUSES.includes(d.status));
  if (!allFinished) return false;

  const now = new Date();
  const currentHour = now.getHours();
  const todayDateString = getLocalDateString();
  const isAfter8PM = currentHour >= 20;
  const isRouteDateInPast = String(delivery.delivery_date || '') < todayDateString;

  return isAfter8PM || isRouteDateInPast;
}