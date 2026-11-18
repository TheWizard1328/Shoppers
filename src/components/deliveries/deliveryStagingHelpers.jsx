import { isFirstDeliveryPatient } from '@/components/utils/patientHistoryUtils';
import { resolveDeliveryCompanyId, mintDeliveryIdForPayload } from '@/components/utils/deliveryIdentity';

/**
 * OWNER REPORT Nov 16 2026: "that interstore drop off had its delivery ID prefix of
 * DID instead of ISD... either it's not being set as ISD when I create the interstore
 * drop off or something is changing it."
 *
 * ROOT CAUSE: the staging builders were the only creation path that hardcoded a
 * `DID-` id. interStoreTransferHandler mints `ISP-/ISD-{ts}-{fromPhone}-{toPhone}`
 * correctly, but a stop staged through Add To Route -> InterStore went through
 * buildPatientStagedDelivery and came out as `DID-...`. Everything downstream that
 * identifies an InterStore stop by its prefix then treated it as a plain pickup
 * (pickup marker, "Edit Pickup"). Mint the correct prefix at the source.
 */
export const buildInterStoreDeliveryId = (formData) => {
  const kind = (formData?._interstore_stop_type || 'pickup') === 'dropoff' ? 'ISD' : 'ISP';
  const digits = (v) => String(v || '').replace(/\D/g, '');
  const srcPhone = digits(formData?._interstore_source_number || formData?._interstore_source_phone);
  const dstPhone = digits(formData?._interstore_dest_number || formData?._interstore_dest_phone);
  const phonePart = [srcPhone, dstPhone].filter(Boolean).join('-');
  return `${kind}-${Date.now()}${phonePart ? `-${phonePart}` : ''}`;
};

export const isInterStoreDraft = (formData) => !!(
  formData && (formData._interstore_source_id || formData._interstore_dest_id)
);

export const resolveDistanceFromStore = ({ patient, store, calculateDistance }) => {
  let distanceFromStore = patient?.distance_from_store;

  if (distanceFromStore === null || distanceFromStore === undefined) {
    if (patient && patient.latitude && patient.longitude && store?.latitude && store?.longitude) {
      distanceFromStore = calculateDistance(store.latitude, store.longitude, patient.latitude, patient.longitude);
    }
  }

  return distanceFromStore;
};

export const buildPickupStagedDelivery = ({ formData, codAmount, store, timeSlot, existingStopIds = [] }) => {
  const ids = existingStopIds.filter(Boolean);
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let sid = '';
  let tries = 0;

  do {
    sid = '';
    for (let i = 0; i < 3; i += 1) sid += chars.charAt(Math.floor(Math.random() * chars.length));
    tries += 1;
  } while (ids.includes(sid) && tries < 10000);

  // Strip any leaked record identity from a previously edited pending stop
  // (see buildPatientStagedDelivery guard) — a new staged pickup gets a fresh
  // stop_id/puid/delivery_id below and must not carry an existing record's id.
  const {
    id: _leakedId,
    _wasEdited: _leakedWasEdited,
    _tempId: _leakedTempId,
    isNextDelivery: _leakedNextFlag,
    arrival_time: _leakedArrival,
    actual_delivery_time: _leakedActualTime,
    tracking_number: _leakedTrackingNumber,
    ...draftWithoutRecordIdentity
  } = formData || {};

  return {
    ...draftWithoutRecordIdentity,
    patient_id: '',
    patient_name: 'Pickup',
    patient_phone: '',
    unit_number: '',
    cod_total_amount_required: codAmount,
    delivery_date: formData.delivery_date,
    delivery_id: isInterStoreDraft(formData) ? buildInterStoreDeliveryId(formData) : mintDeliveryIdForPayload({ ...formData, patient_id: '' }),
    company_id: resolveDeliveryCompanyId(),
    driver_id: formData.driver_id,
    driver_name: formData.driver_name,
    store_id: store.id,
    store_name: store.name,
    store_abbreviation: store.abbreviation,
    store_phone: store.phone || '',
    stop_id: sid,
    puid: sid,
    ampm_deliveries: timeSlot,
    status: 'en_route',
    delivery_address: store.address,
    latitude: store.latitude,
    longitude: store.longitude,
    extra_time: formData.extra_time || 15,
    transport_mode: formData.transport_mode || 'driving',
    _tempId: Date.now() + Math.random()
  };
};

export const buildPatientStagedDelivery = ({
  formData,
  patient,
  store,
  codAmount,
  puid,
  timeSlot,
  distanceFromStore,
  isNewPatient,
  includeFirstDelivery = true
}) => {
  // ── Record-identity guard (CRITICAL) ─────────────────────────────────────
  // formData can carry the id/status of a previously EDITED pending stop
  // (handleStagedDeliveryClick spreads the whole pending record into the draft).
  // If that leaked through, the "new" staged item would be a phantom clone of
  // the pending record: it displays as pending, gets dedup-dropped at Done, and
  // its delete button deletes the REAL pending stop. A brand-new staged stop
  // has no record identity — strip it here unconditionally.
  const {
    id: _leakedId,
    _wasEdited: _leakedWasEdited,
    _tempId: _leakedTempId,
    isNextDelivery: _leakedNextFlag,
    arrival_time: _leakedArrival,
    actual_delivery_time: _leakedActualTime,
    tracking_number: _leakedTrackingNumber,
    stop_id: _leakedStopId,
    ...draftWithoutRecordIdentity
  } = formData || {};

  return ({
  ...draftWithoutRecordIdentity,
  // IDENTITY (owner report Nov 14 2026): the patient builder was the only
  // staged path with NO delivery_id and NO company_id, so every stop staged
  // here reached the database with a blank company_id. Stamp both at the
  // source, exactly like the pickup builder above.
  delivery_id: isInterStoreDraft(formData) ? buildInterStoreDeliveryId(formData) : mintDeliveryIdForPayload(formData),
  company_id: resolveDeliveryCompanyId(),
  time_window_start: formData.time_window_start || patient?.time_window_start || '',
  time_window_end: formData.time_window_end || patient?.time_window_end || '',
  // Form data (manual entry) takes priority over patient time windows.
  // Patient windows are only a fallback when no explicit delivery window was set.
  delivery_time_start: formData.delivery_time_start || patient?.time_window_start || '',
  delivery_time_end: formData.delivery_time_end || patient?.time_window_end || '',
  cod_total_amount_required: codAmount,
  puid: puid || '',
  ampm_deliveries: timeSlot,
  // ISP/ISD patient deliveries are always in_transit when created. A user who
  // explicitly picks in_transit in the status dropdown BEFORE clicking Add also
  // gets in_transit preserved (Robert, Sep 4 2026). Everything else stages as
  // 'Staged'. NOTE: only 'in_transit' is honored from formData — a draft that
  // previously edited a pending stop carries status 'pending', and inheriting
  // it turned new stops into phantom pending clones (dedup-deleted at Done,
  // delete button hit the real record). That guard stays intact.
  status: (formData._interstore_source_id || formData._interstore_dest_id || formData?.status === 'in_transit')
    ? 'in_transit'
    : 'Staged',
  _tempId: Date.now() + Math.random(),
  patient_name: formData.patient_name || patient?.full_name || 'N/A (Pickup)',
  store_name: store.name,
  store_abbreviation: store.abbreviation,
  distanceFromStore,
  delivery_address: patient?.address || store.address,
  transport_mode: formData.transport_mode || 'driving',
  ...(includeFirstDelivery ? { first_delivery: isNewPatient || isFirstDeliveryPatient(patient) } : {})
  });
};