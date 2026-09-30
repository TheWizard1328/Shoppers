import { getStoreAssignedTimeSlotForDriver } from '../utils/ampmUtils';
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
        // Manual In Transit: attach to an existing pickup for this store/date/driver
        // (staged, first En Route, else most recent Completed, else any reusable) — but
        // NEVER create a brand-new pickup (owner rule, permanent, Sep 30 2026): a delivery
        // manually set to in_transit before Add/Done is almost always already pre-attached
        // to an earlier pickup that may or may not be complete yet. The old
        // ensureMissingPickup fallback called ensurePickupForDelivery with
        // allowCreateIfMissing: true, which minted a fresh pickup container whenever no
        // candidate was found — creating phantom pickups on already-running routes.
        // With no ensureMissingPickup passed, resolvePickupPuid resolves from existing
        // pickups only (lookup fallback, zero creation).
        dataToSave.puid = await resolvePickupPuid({
          stagedDeliveries,
          allDeliveries,
          storeId: patientStoreId,
          deliveryDate: dataToSave.delivery_date,
          driverId: dataToSave.driver_id,
          timeSlot,
          forceAttachToExisting: true
        });
      }
    }
  }

  return dataToSave;
}