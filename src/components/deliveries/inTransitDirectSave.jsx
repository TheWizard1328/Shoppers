import { getStoreAssignedTimeSlotForDriver } from '../utils/ampmUtils';
import { base44 } from '@/api/base44Client';
import { resolvePickupPuid } from './deliveryAddHelpers';

export async function buildInTransitDirectSaveData({
  prepareDeliverySaveData,
  formData,
  delivery,
  isCompletionStatus,
  completionTime,
  selectedPatient,
  stores,
  allDeliveries,
  stagedDeliveries
}) {
  const dataToSave = prepareDeliverySaveData({
    formData,
    delivery,
    isCompletionStatus,
    completionTime
  });

  // Detect interstore deliveries (ISP pickup or ISD drop-off) — never create an originating pickup for these
  const isInterstore = (() => {
    const checkStr = (v) => {
      const s = String(v || '').toLowerCase();
      return s.includes('(isp)') || s.includes(' isp') || s.includes('interstore drop') || s.includes('(isd)') || s.includes(' isd');
    };
    return (
      checkStr(selectedPatient?.full_name) ||
      checkStr(selectedPatient?.address) ||
      checkStr(selectedPatient?.notes) ||
      checkStr(dataToSave.delivery_notes) ||
      checkStr(dataToSave.delivery_instructions)
    );
  })();

  if (!delivery?.id && dataToSave.status === 'in_transit' && dataToSave.patient_id && !isInterstore) {
    const patientStoreId = selectedPatient?.store_id || dataToSave.store_id;
    if (patientStoreId) {
      const patientStore = stores?.find((store) => store && store.id === patientStoreId);
      const timeSlot = dataToSave.ampm_deliveries || getStoreAssignedTimeSlotForDriver(patientStore, dataToSave.delivery_date, dataToSave.driver_id, allDeliveries) || 'AM';
      const specialStoreNames = ['Lakeland Ridge', 'Sherwood Pk Mall', 'WestPark', 'SouthPoint'];
      const isSpecialStore = specialStoreNames.includes(patientStore?.name || '');

      // Only resolve puid if it's not already set — puid is immutable after creation
      if (!dataToSave.puid) {
        dataToSave.puid = await resolvePickupPuid({
          stagedDeliveries,
          allDeliveries,
          storeId: patientStoreId,
          deliveryDate: dataToSave.delivery_date,
          driverId: dataToSave.driver_id,
          timeSlot,
          reuseLatestCompleted: !isSpecialStore,
          ensureMissingPickup: () => base44.functions.invoke('ensurePickupForDelivery', {
            storeId: patientStoreId,
            deliveryDate: dataToSave.delivery_date,
            driverId: dataToSave.driver_id,
            ampmDeliveries: timeSlot,
            allowCreateIfMissing: true,
            skipReuseCheck: isSpecialStore
          })
        });
      }
    }
  }

  return dataToSave;
}