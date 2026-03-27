import { getStoreAssignedTimeSlotForDriver } from '../utils/ampmUtils';
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

  if (!delivery?.id && dataToSave.status === 'in_transit' && dataToSave.patient_id) {
    const patientStoreId = selectedPatient?.store_id || dataToSave.store_id;
    if (patientStoreId) {
      const patientStore = stores?.find((store) => store && store.id === patientStoreId);
      const timeSlot = dataToSave.ampm_deliveries || getStoreAssignedTimeSlotForDriver(patientStore, dataToSave.delivery_date, dataToSave.driver_id, allDeliveries) || 'AM';
      dataToSave.puid = await resolvePickupPuid({
        stagedDeliveries,
        allDeliveries,
        storeId: patientStoreId,
        deliveryDate: dataToSave.delivery_date,
        driverId: dataToSave.driver_id,
        timeSlot,
        reuseLatestCompleted: true
      });
    }
  }

  return dataToSave;
}