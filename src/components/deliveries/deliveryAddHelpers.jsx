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

  if (slotWindow.start) {
    // Only apply the late-window override when the pickup is being added on TODAY's route.
    // If the delivery is for a future date we always use the store's configured window.
    const todayStr = format(now, 'yyyy-MM-dd');
    const isToday = deliveryDate === todayStr;

    if (isToday) {
      const windowEndMinutes = toMinutes(slotWindow.end);
      const nowMinutes = now.getHours() * 60 + now.getMinutes();
      const isPastWindow = windowEndMinutes !== null && nowMinutes > windowEndMinutes;

      if (isPastWindow) {
        return {
          delivery_time_start: format(addMinutes(now, 30), 'HH:mm'),
          delivery_time_end: format(addMinutes(now, 90), 'HH:mm'),
        };
      }
    }

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

// Unified pickup-attachment policy for any newly created delivery (Staged, Pending, or In Transit):
//   1. Attach to the first existing En Route pickup for the same store/date/driver (matching slot preferred).
//   2. Otherwise attach to a same-date + driver Completed pickup — but only if it was completed within
//      the last hour, UNLESS forceAttachToExisting is set (manual In Transit), in which case the most
//      recent Completed pickup is reused regardless of how long ago it finished.
//   3. Otherwise reuse any other in-progress pickup (pending/in_transit/Staged) already on this route.
//   4. forceAttachToExisting must always attach to *something* if anything at all exists for this
//      store/date/driver, even a non-matching-slot record, rather than spawn a new pickup.
//   5. Otherwise (Staged/Pending with nothing to reuse) fall through to create a brand-new pickup.
export const resolvePickupPuid = async ({
  stagedDeliveries,
  allDeliveries,
  storeId,
  deliveryDate,
  driverId,
  timeSlot,
  ensureMissingPickup,
  forceAttachToExisting = false
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

  // All already-persisted pickup records (patient_id null) for this exact store + date + driver
  const candidatePickups = (allDeliveries || []).filter((delivery) =>
    delivery &&
    !delivery.patient_id &&
    delivery.store_id === storeId &&
    delivery.delivery_date === deliveryDate &&
    delivery.driver_id === driverId
  );

  // 1. First existing En Route pickup for this store — prefer the matching AM/PM slot, else any slot
  const enRoutePickup =
    candidatePickups.find((p) => p.status === 'en_route' && (p.ampm_deliveries || 'AM') === timeSlot) ||
    candidatePickups.find((p) => p.status === 'en_route');
  if (enRoutePickup) {
    return enRoutePickup.puid || enRoutePickup.stop_id;
  }

  // 2. A same-date + driver Completed pickup
  const completedPickups = candidatePickups
    .filter((p) => p.status === 'completed' && p.actual_delivery_time)
    .sort((a, b) => new Date(b.actual_delivery_time) - new Date(a.actual_delivery_time));

  if (completedPickups.length > 0) {
    if (forceAttachToExisting) {
      return completedPickups[0].puid || completedPickups[0].stop_id;
    }
    const ONE_HOUR_MS = 60 * 60 * 1000;
    const recentCompleted = completedPickups.find(
      (p) => (Date.now() - new Date(p.actual_delivery_time).getTime()) < ONE_HOUR_MS
    );
    if (recentCompleted) {
      return recentCompleted.puid || recentCompleted.stop_id;
    }
  }

  // 3. Other non-terminal pickups already in progress for this store/date/driver
  const otherReusable =
    candidatePickups.find((p) => ['pending', 'in_transit', 'Staged'].includes(p.status) && (p.ampm_deliveries || 'AM') === timeSlot) ||
    candidatePickups.find((p) => ['pending', 'in_transit', 'Staged'].includes(p.status));
  if (otherReusable) {
    return otherReusable.puid || otherReusable.stop_id;
  }

  // 4. Manual In Transit must attach to *something* if anything at all exists for this store/date/driver
  if (forceAttachToExisting && candidatePickups.length > 0) {
    const mostRecent = [...candidatePickups].sort(
      (a, b) => new Date(b.updated_date || b.created_date || 0) - new Date(a.updated_date || a.created_date || 0)
    )[0];
    if (mostRecent) {
      return mostRecent.puid || mostRecent.stop_id;
    }
  }

  // 5. Nothing to reuse — fall back to computing a fresh id / creating a new pickup via the backend
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