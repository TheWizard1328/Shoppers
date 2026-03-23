import { base44 } from '@/api/base44Client';
import { getPickupStopIdForDelivery } from '../utils/ampmUtils';

export const createPatientFromDraft = async ({
  formData,
  selectedPatient,
  createPatientLocal,
  setFormData
}) => {
  if (!selectedPatient) {
    throw new Error('Patient information missing for new patient creation.');
  }

  if (formData.patient_id) {
    return {
      patient: { id: formData.patient_id, full_name: formData.patient_name },
      isNewPatient: false
    };
  }

  const newPatientData = {
    full_name: formData.patient_name,
    address: selectedPatient.address || '',
    phone: formData.patient_phone || '',
    unit_number: formData.unit_number || '',
    store_id: formData.store_id,
    notes: formData.delivery_instructions || '',
    mailbox_ok: formData.mailbox_ok || false,
    call_upon_arrival: formData.call_upon_arrival || false,
    ring_bell: formData.ring_bell || false,
    dont_ring_bell: formData.dont_ring_bell || false,
    back_door: formData.back_door || false,
    signature_needed: formData.signature_needed || false,
    recurring: formData.recurring || false,
    recurring_daily: formData.recurring_daily || false,
    recurring_weekly_mon: formData.recurring_weekly_mon || false,
    recurring_weekly_tue: formData.recurring_weekly_tue || false,
    recurring_weekly_wed: formData.recurring_weekly_wed || false,
    recurring_weekly_thu: formData.recurring_weekly_thu || false,
    recurring_weekly_fri: formData.recurring_weekly_fri || false,
    recurring_weekly_sat: formData.recurring_weekly_sat || false,
    recurring_weekly_sun: formData.recurring_weekly_sun || false,
    recurring_biweekly: formData.recurring_biweekly || false,
    recurring_weekly_x4: formData.recurring_weekly_x4 || false,
    recurring_monthly: formData.recurring_monthly || false,
    recurring_bimonthly: formData.recurring_bimonthly || false,
    latitude: selectedPatient.latitude,
    longitude: selectedPatient.longitude,
    distance_from_store: selectedPatient.distance_from_store,
    status: 'active'
  };

  const patient = await createPatientLocal(newPatientData);
  setFormData((prev) => ({ ...prev, patient_id: patient.id }));

  return { patient, isNewPatient: true };
};

export const resolvePickupPuid = async ({
  stagedDeliveries,
  allDeliveries,
  storeId,
  deliveryDate,
  driverId,
  timeSlot,
  ensureMissingPickup,
  allowRecentlyCompleted = false
}) => {
  const stagedPickup = (stagedDeliveries || []).find((delivery) =>
    !delivery.patient_id &&
    delivery.store_id === storeId &&
    delivery.delivery_date === deliveryDate &&
    delivery.driver_id === driverId &&
    (delivery.ampm_deliveries || 'AM') === timeSlot
  );

  if (stagedPickup) {
    return stagedPickup.puid || stagedPickup.stop_id || null;
  }

  const existingPickup = (allDeliveries || []).find((delivery) =>
    delivery &&
    !delivery.patient_id &&
    delivery.store_id === storeId &&
    delivery.delivery_date === deliveryDate &&
    delivery.driver_id === driverId &&
    (delivery.ampm_deliveries || 'AM') === timeSlot
  );

  if (existingPickup) {
    const isReusable = allowRecentlyCompleted
      ? ['pending', 'en_route', 'in_transit'].includes(existingPickup.status) || (
          existingPickup.status === 'completed' &&
          existingPickup.actual_delivery_time &&
          (new Date() - new Date(existingPickup.actual_delivery_time) < 60 * 60 * 1000)
        )
      : ['pending', 'en_route', 'in_transit', 'Staged'].includes(existingPickup.status);

    if (isReusable) {
      return existingPickup.stop_id;
    }
  }

  const fallbackPuid = getPickupStopIdForDelivery(storeId, deliveryDate, timeSlot, allDeliveries);

  if (!ensureMissingPickup) {
    return fallbackPuid;
  }

  try {
    const response = await ensureMissingPickup();
    return response?.data?.puid || fallbackPuid;
  } catch {
    return fallbackPuid;
  }
};