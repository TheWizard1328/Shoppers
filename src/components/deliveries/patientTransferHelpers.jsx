/**
 * patientTransferHelpers.jsx
 *
 * CROSS-STORE PATIENT TRANSFER (owner spec, Nov 24 2026)
 *
 * When a dispatcher's or driver's own-store patient search comes up empty, the
 * patient-search dropdown offers an "Other Stores" peek. A match found at another
 * store in the same company gets a TRANSFER button instead of Duplicate/Change.
 *
 * What a transfer does, exactly as the owner specified:
 *  - the ORIGINAL record is never deleted: it is set to `inactive`, so the
 *    originating store keeps its history and its pharmacy identifier;
 *  - a NEW record is created in the destination store, `active`, carrying the
 *    person's name, phone, address, unit, coordinates and delivery preferences;
 *  - the new record links back to the original (`source_patient_id`,
 *    `source_store_id`, `transferred_at`);
 *  - `distance_from_store` is recalculated from the DESTINATION store, first as a
 *    straight-line stamp and then healed to the real road distance;
 *  - nothing needs to be transferred back: if a delivery later arrives at the
 *    originating store, accepting it reactivates that store's own record.
 *
 * Identity fields that must NOT be copied: the patient_id (pharmacy system key,
 * unique per store), portal identity/email, login counters, signature image and
 * delivery history. A transferred patient is the same person, not the same
 * portal account, and copying those caused ambiguous logins.
 */

import { haversineKm } from '@/components/utils/geoUtils';

const COPIED_FIELDS = [
  'full_name',
  'phone',
  'phone_secondary',
  'unit_number',
  'address',
  'latitude',
  'longitude',
  'notes',
  'time_window_start',
  'time_window_end',
  'mailbox_ok',
  'call_upon_arrival',
  'ring_bell',
  'dont_ring_bell',
  'back_door',
  'care_pros',
  'cp_name',
  'cp_envelopes',
  'recurring',
  'recurring_daily',
  'recurring_weekly_mon',
  'recurring_weekly_tue',
  'recurring_weekly_wed',
  'recurring_weekly_thu',
  'recurring_weekly_fri',
  'recurring_weekly_sat',
  'recurring_weekly_sun',
  'recurring_biweekly',
  'recurring_weekly_x4',
  'recurring_weekly_x4_day',
  'recurring_bimonthly',
  'recurring_monthly',
];

/** The store ids a user's own patient search is scoped to. */
export const getUserStoreIds = (currentUser, scheduledDriverMap = {}, allDeliveries = [], deliveryDate = null) => {
  const ids = new Set();
  (currentUser?.store_ids || []).forEach((id) => id && ids.add(id));
  if (currentUser?.store_id) ids.add(currentUser.store_id);
  Object.entries(scheduledDriverMap || {}).forEach(([key, driverId]) => {
    if (driverId && driverId === currentUser?.id) {
      const base = String(key).replace(/_AM$|_PM$/, '');
      if (base) ids.add(base);
    }
  });
  (allDeliveries || []).forEach((d) => {
    if (
      d && d.driver_id === currentUser?.id && d.puid && !d.patient_id &&
      d.status === 'en_route' && (!deliveryDate || d.delivery_date === deliveryDate) && d.store_id
    ) ids.add(d.store_id);
  });
  return ids;
};

/**
 * Is this patient a record the user cannot act on as a same-store duplicate?
 * True when the patient belongs to a store outside the user's own store list.
 */
export const isCrossStorePatient = (patient, ownStoreIds) => {
  if (!patient?.store_id) return false;
  const ids = ownStoreIds instanceof Set ? ownStoreIds : new Set(ownStoreIds || []);
  return ids.size > 0 && !ids.has(patient.store_id);
};

/** Stores eligible to be searched by the peek: same company, not one of ours. */
export const getOtherCompanyStores = ({ stores = [], ownStoreIds, currentUser }) => {
  const own = ownStoreIds instanceof Set ? ownStoreIds : new Set(ownStoreIds || []);
  const ownStore = (stores || []).find((s) => s && own.has(s.id));
  const companyId = ownStore?.company_id || currentUser?.company_id || null;
  return (stores || []).filter((s) => {
    if (!s?.id || own.has(s.id)) return false;
    if (String(s.status || 'active').toLowerCase() !== 'active') return false;
    if (companyId && s.company_id && s.company_id !== companyId) return false;
    return true;
  });
};

/** Build the new-store record for a transfer. */
export const buildTransferPatientPayload = ({ source, targetStore }) => {
  if (!source || !targetStore?.id) return null;
  const payload = {
    store_id: targetStore.id,
    status: 'active',
    source_patient_id: source.id,
    source_store_id: source.store_id || null,
    transferred_at: new Date().toISOString(),
  };
  COPIED_FIELDS.forEach((field) => {
    if (source[field] !== undefined) payload[field] = source[field];
  });
  const pLat = Number(source.latitude);
  const pLng = Number(source.longitude);
  const sLat = Number(targetStore.latitude);
  const sLng = Number(targetStore.longitude);
  if ([pLat, pLng, sLat, sLng].every(Number.isFinite)) {
    payload.distance_from_store = Math.round(haversineKm(sLat, sLng, pLat, pLng) * 100) / 100;
  } else {
    payload.distance_from_store = null;
  }
  return payload;
};

/**
 * Create the destination record and deactivate the source. Returns the created
 * patient (local id first; the server id lands through the normal queue).
 */
export const transferPatientToStore = async ({ source, targetStore }) => {
  const payload = buildTransferPatientPayload({ source, targetStore });
  if (!payload) throw new Error('transfer: missing source patient or target store');
  const { createPatientLocal, updatePatientLocal } = await import('@/components/utils/offlineMutations');

  const created = await createPatientLocal(payload);
  // Original stays on file, inactive (owner rule): the originating store can
  // still see it and a future accepted delivery reactivates it.
  await updatePatientLocal(source.id, { status: 'inactive' }).catch(() => {});

  // Heal the straight-line stamp to the real road distance from the new store.
  try {
    const { base44 } = await import('@/api/base44Client');
    base44.functions.invoke('getGoogleDrivingDistance', {
      originLat: Number(targetStore.latitude),
      originLng: Number(targetStore.longitude),
      destLat: Number(source.latitude),
      destLng: Number(source.longitude),
    }).then(async (res) => {
      const km = Number(res?.data?.distance_km ?? res?.distance_km);
      if (Number.isFinite(km) && km > 0) {
        await updatePatientLocal(created.id, { distance_from_store: Math.round(km * 100) / 100 }).catch(() => {});
      }
    }).catch(() => {});
  } catch (_) { /* offline — the straight-line stamp stands */ }

  return { ...created, ...payload };
};
