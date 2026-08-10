import { getLastDeliveryDate } from '@/components/utils/patientHistoryUtils';
export function sortFilteredPatients(results, { currentUser, userHasRole, stores, stagedPatientIds, calculateDistance }) {
  return [...results].sort((a, b) => {
    const aIsInactive = a.status === 'inactive';
    const bIsInactive = b.status === 'inactive';
    if (aIsInactive !== bIsInactive) return aIsInactive ? 1 : -1;

    const aIsStaged = stagedPatientIds.has(a.id);
    const bIsStaged = stagedPatientIds.has(b.id);
    if (aIsStaged !== bIsStaged) return aIsStaged ? 1 : -1;

    const aIsTemp = a.full_name?.toLowerCase().includes('(temp') || false;
    const bIsTemp = b.full_name?.toLowerCase().includes('(temp') || false;
    if (aIsTemp !== bIsTemp) return aIsTemp ? 1 : -1;

    if (userHasRole(currentUser, 'admin')) {
      const getNearestStoreDistance = (patient) => (stores || []).reduce((nearest, store) => {
        const distance = store && store.status !== 'inactive'
          ? calculateDistance(patient?.latitude, patient?.longitude, store?.latitude, store?.longitude)
          : null;
        return distance === null ? nearest : Math.min(nearest, distance);
      }, Infinity);
      const distanceDiff = getNearestStoreDistance(a) - getNearestStoreDistance(b);
      if (distanceDiff !== 0) return distanceDiff;
    }

    const aLastDate = getLastDeliveryDate(a); const aDate = aLastDate ? new Date(aLastDate).getTime() : 0;
    const bLastDate = getLastDeliveryDate(b); const bDate = bLastDate ? new Date(bLastDate).getTime() : 0;
    return bDate - aDate;
  });
}