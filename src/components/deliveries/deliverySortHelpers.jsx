export function sortStagedDeliveries({ stagedDeliveries, stores, selectedDriverId }) {
  let filtered = [...stagedDeliveries];

  if (selectedDriverId) {
    filtered = filtered.filter((delivery) => delivery.driver_id === selectedDriverId);
  }

  // Precompute store sort-order lookups once (compared multiple times in the comparator)
  const storeSortOrder = new Map();
  (stores || []).forEach((store) => {
    if (store?.id) storeSortOrder.set(store.id, store.sort_order ?? Infinity);
  });

  // Sort: driver (primary) → store sort order → distance from store → patient name (tie-breaker)
  return filtered.sort((a, b) => {
    // 1. Driver — group by driver first
    const driverA = a.driver_id || '';
    const driverB = b.driver_id || '';
    if (driverA !== driverB) return driverA.localeCompare(driverB);

    // 2. Store sort order (within driver)
    const sortOrderA = storeSortOrder.get(a.store_id) ?? Infinity;
    const sortOrderB = storeSortOrder.get(b.store_id) ?? Infinity;
    if (sortOrderA !== sortOrderB) return sortOrderA - sortOrderB;

    // 3. Distance from parent store, ascending (within store)
    const distA = a.distanceFromStore ?? Infinity;
    const distB = b.distanceFromStore ?? Infinity;
    if (distA !== distB) return distA - distB;

    // Tie-breakers
    // Sort pickups (no patient_id) by delivery_time_start
    const aIsPickup = !a.patient_id;
    const bIsPickup = !b.patient_id;
    if (aIsPickup || bIsPickup) {
      const timeA = a.delivery_time_start || a.ampm_deliveries || 'ZZ';
      const timeB = b.delivery_time_start || b.ampm_deliveries || 'ZZ';
      if (timeA !== timeB) return timeA.localeCompare(timeB);
    }

    return (a.patient_name || '').localeCompare(b.patient_name || '');
  });
}

export function sortDeliveriesByTime(deliveries) {
  if (!Array.isArray(deliveries)) return [];

  const finishedStatuses = ['completed', 'failed', 'cancelled'];

  // Build a store-group sort key: if the store has a completed pickup, use its actual_delivery_time;
  // otherwise fall back to the earliest delivery_time_start for that store's deliveries.
  const storePickupTime = {};
  const storeScheduledTime = {};
  deliveries.forEach((d) => {
    if (!d?.store_id) return;
    const isPickup = !d.patient_id || d.patient_id === '';
    if (isPickup && finishedStatuses.includes(d.status) && d.actual_delivery_time) {
      const t = d.actual_delivery_time;
      if (!storePickupTime[d.store_id] || t < storePickupTime[d.store_id]) {
        storePickupTime[d.store_id] = t;
      }
    }
    const sched = d.delivery_time_start || '';
    if (!storeScheduledTime[d.store_id] || (sched && sched < storeScheduledTime[d.store_id])) {
      storeScheduledTime[d.store_id] = sched;
    }
  });

  const getStoreSortKey = (storeId) =>
    storePickupTime[storeId] || storeScheduledTime[storeId] || 'ZZ';

  const incomplete = deliveries.filter((d) => d && !finishedStatuses.includes(d.status));
  const completed = deliveries.filter((d) => d && finishedStatuses.includes(d.status));

  incomplete.sort((a, b) => {
    if (!a || !b) return 0;
    if (a.isNextDelivery && !b.isNextDelivery) return -1;
    if (!a.isNextDelivery && b.isNextDelivery) return 1;
    const storeKeyA = getStoreSortKey(a.store_id);
    const storeKeyB = getStoreSortKey(b.store_id);
    if (storeKeyA !== storeKeyB) return storeKeyA.localeCompare(storeKeyB);
    const timeA = a.delivery_time_eta || a.delivery_time_start || '';
    const timeB = b.delivery_time_eta || b.delivery_time_start || '';
    if (timeA !== timeB) return timeA.localeCompare(timeB);
    return (a.stop_order ?? Infinity) - (b.stop_order ?? Infinity);
  });

  completed.sort((a, b) => {
    if (!a || !b) return 0;
    const storeKeyA = getStoreSortKey(a.store_id);
    const storeKeyB = getStoreSortKey(b.store_id);
    if (storeKeyA !== storeKeyB) return storeKeyA.localeCompare(storeKeyB);
    return (Date.parse(a.actual_delivery_time || '') || Infinity) - (Date.parse(b.actual_delivery_time || '') || Infinity) || (a.stop_order ?? Infinity) - (b.stop_order ?? Infinity);
  });

  return [...incomplete, ...completed];
}

export function sortProjectedDeliveries({ projectedDeliveries, allDeliveries, stores, patients, selectedDriverId, deliveryDate, isDispatcher = false, scheduledDriverMap = {}, calculateDistance }) {
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

  // Precompute patient + store lookups and per-projection address+unit + distance
  // (projections are bare patient summaries with no address/distance, so derive
  // those here to honor store sort order → distance from store).
  const patientMap = new Map((patients || []).filter(Boolean).map((p) => [p.id, p]));
  const storeMap = new Map((stores || []).filter(Boolean).map((s) => [s.id, s]));

  const enriched = filtered.map((p) => {
    const patient = patientMap.get(p.patient_id);
    const store = storeMap.get(p.store_id);
    const address = (patient?.address || '').trim().toLowerCase();
    const unit = (patient?.unit_number || '').trim().toLowerCase();
    let distance = p.distanceFromStore;
    if (distance == null && patient?.latitude && patient?.longitude && store?.latitude && store?.longitude && typeof calculateDistance === 'function') {
      distance = calculateDistance(store.latitude, store.longitude, patient.latitude, patient.longitude);
    }
    return {
      p,
      addressKey: `${address}|${unit}`,
      distance: distance ?? Infinity,
      sortOrder: store?.sort_order ?? Infinity
    };
  });

  // Sort: store sort order (primary) → distance from store (within store) → patient name (tie-breaker)
  enriched.sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    if (a.distance !== b.distance) return a.distance - b.distance;
    return (a.p.patient_name || '').localeCompare(b.p.patient_name || '');
  });

  return enriched.map((e) => e.p);
}