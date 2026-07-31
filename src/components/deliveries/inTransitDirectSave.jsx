import { getStoreAssignedTimeSlotForDriver } from '../utils/ampmUtils';
import { base44 } from '@/api/base44Client';
import { resolvePickupPuid } from './deliveryAddHelpers';
import { isInterStoreDelivery } from '../utils/interStoreDisplayName';

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

  // Detect interstore deliveries via delivery_id prefix (ISP-/ISD-).
  // Never create an originating regular pickup for these — they are their own stops.
  const isInterstore = isInterStoreDelivery(dataToSave.delivery_id);

  if (!delivery?.id && dataToSave.status === 'in_transit' && dataToSave.patient_id && !isInterstore) {
    const patientStoreId = selectedPatient?.store_id || dataToSave.store_id;
    if (patientStoreId) {
      const patientStore = stores?.find((store) => store && store.id === patientStoreId);
      const timeSlot = dataToSave.ampm_deliveries || getStoreAssignedTimeSlotForDriver(patientStore, dataToSave.delivery_date, dataToSave.driver_id, allDeliveries) || 'AM';

      // Only resolve puid if it's not already set — puid is immutable after creation
      if (!dataToSave.puid) {
        // Manual In Transit: always attach to an existing pickup for this store/date/driver
        // (first En Route, else most recent Completed regardless of how long ago) rather than
        // creating a brand-new pickup — the driver already has the item in hand right now.
        dataToSave.puid = await resolvePickupPuid({
          stagedDeliveries,
          allDeliveries,
          storeId: patientStoreId,
          deliveryDate: dataToSave.delivery_date,
          driverId: dataToSave.driver_id,
          timeSlot,
          forceAttachToExisting: true,
          ensureMissingPickup: () => base44.functions.invoke('ensurePickupForDelivery', {
            storeId: patientStoreId,
            deliveryDate: dataToSave.delivery_date,
            driverId: dataToSave.driver_id,
            ampmDeliveries: timeSlot,
            allowCreateIfMissing: true,
            forceAttachIfInTransit: true
          })
        });
      }
    }
  }

  return dataToSave;
}