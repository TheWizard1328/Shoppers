import { getPickupStopIdForDelivery } from '../utils/ampmUtils';
import { addMinutes, format } from 'date-fns';

const toMinutes = (value) => {
  if (!value || typeof value !== 'string' || !value.includes(':')) return null;
  const [hours, minutes] = value.split(':').map(Number);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
  return hours * 60 + minutes;
};

const getStoreSlotWindow = (store, deliveryDate, timeSlot) => {
  const dayOfWeek = new Date(`${deliveryDate}T00:00:00`).getDay();
  const isSaturday = dayOfWeek === 6;
  const isSunday = dayOfWeek === 0;

  if (timeSlot === 'PM') {
    if (isSaturday) return { start: store?.saturday_pm_start || '', end: store?.saturday_pm_end || '' };
    if (isSunday) return { start: store?.sunday_pm_start || '', end: store?.sunday_pm_end || '' };
    return { start: store?.weekday_pm_start || '', end: store?.weekday_pm_end || '' };
  }

  if (isSaturday) return { start: store?.saturday_am_start || '', end: store?.saturday_am_end || '' };
  if (isSunday) return { start: store?.sunday_am_start || '', end: store?.sunday_am_end || '' };
  return { start: store?.weekday_am_start || '', end: store?.weekday_am_end || '' };
};

export const resolvePickupTimeWindow = ({ store, deliveryDate, timeSlot, now = new Date() }) => {
  const slotWindow = getStoreSlotWindow(store, deliveryDate, timeSlot);

  // CRITICAL: Always use the configured store time window for delivery_time_start/end.
  // If the slot has no configured times, fall back to a reasonable default.
  if (slotWindow.start) {
    return {
      delivery_time_start: slotWindow.start,
      delivery_time_end: slotWindow.end || ''
    };
  }

  // No configured window — use current time + buffer as fallback
  return {
    delivery_time_start: format(addMinutes(now, 30), 'HH:mm'),
    delivery_time_end: format(addMinutes(now, 60), 'HH:mm')
  };
};

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
  allowRecentlyCompleted = false,
  reuseLatestCompleted = false
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
      return existingPickup.puid || existingPickup.stop_id;
    }
  }

  if (reuseLatestCompleted) {
    const latestCompletedPickup = [...(allDeliveries || [])]
      .filter((delivery) =>
        delivery &&
        !delivery.patient_id &&
        delivery.store_id === storeId &&
        delivery.status === 'completed' &&
        delivery.stop_id
      )
      .sort((a, b) => {
        const aTime = new Date(a.actual_delivery_time || a.updated_date || a.created_date || 0).getTime();
        const bTime = new Date(b.actual_delivery_time || b.updated_date || b.created_date || 0).getTime();
        return bTime - aTime;
      })[0];

    if (latestCompletedPickup) {
      return latestCompletedPickup.stop_id;
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