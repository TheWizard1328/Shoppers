export function collectPhase3SingleDriverCoordinates({
  deliveriesWithStopOrder,
  selectedDateStr,
  patients,
  stores,
  isViewingTodayPhase3,
  getFabTargetDriverMapLocation,
  targetDriverId,
  currentUser,
  isDriver,
  appUsers,
  driverLocation,
  allDriverLocations,
  isPrimaryDevice,
}) {
  const allCoordinatesPhase3 = [];
  const finishedStatuses = ['completed', 'failed', 'cancelled'];

  const incompleteAndPendingActiveDriver = deliveriesWithStopOrder.filter((d) => {
    if (!d || d.delivery_date !== selectedDateStr) return false;
    if (finishedStatuses.includes(d.status)) return false;
    return true;
  });

  incompleteAndPendingActiveDriver.forEach((delivery) => {
    // Cycling start markers use dedicated coordinates — include them in bounds directly
    if (delivery.is_cycling_start_marker) {
      if (delivery.cycling_start_latitude && delivery.cycling_start_longitude) {
        allCoordinatesPhase3.push([delivery.cycling_start_latitude, delivery.cycling_start_longitude]);
      }
      return;
    }
    if (delivery.patient_id) {
      const patient = patients.find((p) => p?.id === delivery.patient_id);
      if (patient?.latitude && patient?.longitude) {
        allCoordinatesPhase3.push([patient.latitude, patient.longitude]);
      }
    } else if (delivery.store_id) {
      const store = stores.find((s) => s?.id === delivery.store_id);
      if (store?.latitude && store?.longitude) {
        allCoordinatesPhase3.push([store.latitude, store.longitude]);
      }
    }
  });

  if (isViewingTodayPhase3) {
    const targetDriverLocation = getFabTargetDriverMapLocation({
      selectedDriverId: targetDriverId,
      currentUser,
      isDriver,
      appUsers,
      driverLocation,
      allDriverLocations,
      isPrimaryDevice
    });

    if (targetDriverLocation?.latitude && targetDriverLocation?.longitude) {
      allCoordinatesPhase3.push([targetDriverLocation.latitude, targetDriverLocation.longitude]);
    }
  }

  return allCoordinatesPhase3;
}