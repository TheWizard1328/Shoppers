export function sortStagedDeliveries({ stagedDeliveries, stores, selectedDriverId }) {
  let filtered = [...stagedDeliveries];

  if (selectedDriverId) {
    filtered = filtered.filter((delivery) => delivery.driver_id === selectedDriverId);
  }

  return filtered.sort((a, b) => {
    const aIsPending = !!a.id;
    const bIsPending = !!b.id;
    if (!aIsPending && bIsPending) return -1;
    if (aIsPending && !bIsPending) return 1;

    const storeA = stores?.find((store) => store && store.id === a.store_id);
    const storeB = stores?.find((store) => store && store.id === b.store_id);
    const sortOrderA = storeA?.sort_order ?? Infinity;
    const sortOrderB = storeB?.sort_order ?? Infinity;
    if (sortOrderA !== sortOrderB) return sortOrderA - sortOrderB;

    // Sort pickups (no patient_id) by delivery_time_start
    const aIsPickup = !a.patient_id;
    const bIsPickup = !b.patient_id;
    if (aIsPickup || bIsPickup) {
      const timeA = a.delivery_time_start || a.ampm_deliveries || 'ZZ';
      const timeB = b.delivery_time_start || b.ampm_deliveries || 'ZZ';
      if (timeA !== timeB) return timeA.localeCompare(timeB);
    }

    const ampmA = a.ampm_deliveries || 'ZZ';
    const ampmB = b.ampm_deliveries || 'ZZ';
    if (ampmA !== ampmB) return ampmA.localeCompare(ampmB);

    const distA = a.distanceFromStore ?? Infinity;
    const distB = b.distanceFromStore ?? Infinity;
    if (distA !== distB) return distA - distB;

    return 0;
  });
}

export function sortProjectedDeliveries({ projectedDeliveries, allDeliveries, stores, selectedDriverId, deliveryDate, isDispatcher = false, scheduledDriverMap = {} }) {
  const scheduledPatientIds = new Set(
    (allDeliveries || [])
      .filter((delivery) => delivery && delivery.delivery_date === deliveryDate && delivery.patient_id)
      .map((delivery) => delivery.patient_id)
  );

  let filtered = projectedDeliveries.filter((projected) => !scheduledPatientIds.has(projected.patient_id));

  // Dispatchers see all projections for their store regardless of which driver is selected
  if (selectedDriverId && !isDispatcher) {
    filtered = filtered.filter((projected) => {
      const store = stores?.find((item) => item && item.id === projected.store_id);
      if (!store) return false;

      // Check scheduledDriverMap first (override → store default already resolved)
      if (scheduledDriverMap && scheduledDriverMap[store.id]) {
        return scheduledDriverMap[store.id] === selectedDriverId;
      }

      // Fall back to store default driver fields
      const selectedDate = deliveryDate ? new Date(`${deliveryDate}T00:00:00`) : new Date();
      const dayOfWeek = selectedDate.getDay();
      const amDriverId = dayOfWeek === 6
        ? store.saturday_am_driver_id
        : dayOfWeek === 0
          ? store.sunday_am_driver_id
          : store.weekday_am_driver_id;
      const pmDriverId = dayOfWeek === 6
        ? store.saturday_pm_driver_id
        : dayOfWeek === 0
          ? store.sunday_pm_driver_id
          : store.weekday_pm_driver_id;

      return amDriverId === selectedDriverId || pmDriverId === selectedDriverId;
    });
  }

  return filtered.sort((a, b) => {
    const storeA = stores?.find((store) => store && store.id === a.store_id);
    const storeB = stores?.find((store) => store && store.id === b.store_id);
    const sortOrderA = storeA?.sort_order ?? Infinity;
    const sortOrderB = storeB?.sort_order ?? Infinity;
    if (sortOrderA !== sortOrderB) return sortOrderA - sortOrderB;
    return (a.patient_name || '').localeCompare(b.patient_name || '');
  });
}