/**
 * interStoreTransferHandler.js
 * Handles creation of an InterStore transfer delivery record with all required fields.
 */

import { base44 } from '@/api/base44Client';
import { ensureInterStoreCoords } from '@/components/utils/interStoreGeocode';
import { executeOfflineBatchAction } from '@/components/utils/offlineBatchAction';
import { offlineDB } from '@/components/utils/offlineDatabase';

/**
 * Creates an InterStore transfer delivery with all required system fields populated.
 * Closes the form and triggers route optimization + polyline regeneration on completion.
 */
export async function createInterStoreTransfer({
  formData,
  allDrivers,
  allDeliveries,
  appUsers,
  stores,
  currentUser,
  getDriverNameForStorage,
  applyDeliveryChangesLocally,
  handleClearForm,
  onCancel,
}) {
  const sourceId = formData._interstore_source_id;
  const destId = formData._interstore_dest_id;

  if (!formData.delivery_date || !sourceId || !destId) {
    throw new Error('Please select a date, From store, and To store.');
  }

  const driver = allDrivers.find((d) => d.id === formData.driver_id);

  // ── Fetch InterStoreLocation records to get phone numbers ────────────
  const stripPhone = (phone) => (phone || '').replace(/\D/g, '');
  let srcPhone = '';
  let dstPhone = '';
  try {
    const [srcLoc, dstLoc] = await Promise.all([
      base44.entities.InterStoreLocation.filter({ id: sourceId }).then((r) => r?.[0] || null),
      base44.entities.InterStoreLocation.filter({ id: destId }).then((r) => r?.[0] || null),
    ]);
    srcPhone = stripPhone(srcLoc?.store_phone || '');
    dstPhone = stripPhone(dstLoc?.store_phone || '');

    // If either location is missing coords, try to resolve from offline Store DB first
    const stripPhoneCoords = (s) => (s || '').replace(/[\s()+-]/g, '');
    const tryFillCoordsFromStores = async (loc) => {
      if (!loc || (loc.store_latitude && loc.store_longitude)) return;
      try {
        const { offlineDB } = await import('@/components/utils/offlineDatabase');
        const offlineStores = await offlineDB.getAll(offlineDB.STORES.STORES);
        const targetPhone = stripPhoneCoords(loc.store_phone);
        const match = targetPhone
          ? (offlineStores || []).find((s) => s && s.latitude && s.longitude && stripPhoneCoords(s.phone) === targetPhone)
          : null;
        if (match) {
          loc.store_latitude = match.latitude;
          loc.store_longitude = match.longitude;
        }
      } catch { /* silent */ }
    };

    await Promise.all([
      tryFillCoordsFromStores(srcLoc),
      tryFillCoordsFromStores(dstLoc),
    ]);

    // Geocode any still-missing coords fire-and-forget
    if (srcLoc) ensureInterStoreCoords(srcLoc).catch(() => null);
    if (dstLoc) ensureInterStoreCoords(dstLoc).catch(() => null);
  } catch { /* phones will remain empty */ }

  // ── stop_type — pickup (ISP) or dropoff (ISD) ────────────────────────
  const isDropOff = (formData._interstore_stop_type || 'pickup') === 'dropoff';
  const idPrefix = isDropOff ? 'ISD' : 'ISP';

  // ── delivery_id  (ISP-/ISD-fromPhone-toPhone) ─────────────────────────
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const randStr = (len) => Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  const tsNow = Date.now();
  const phonePart = [srcPhone, dstPhone].filter(Boolean).join('-');
  const delivery_id = `${idPrefix}-${tsNow}${phonePart ? `-${phonePart}` : ''}`;

  // ── stop_id — 3-char mixed-case alphanumeric, unique for this date ────
  const existingStopIds = new Set(
    (allDeliveries || [])
      .filter((d) => d && d.delivery_date === formData.delivery_date)
      .map((d) => d?.stop_id)
      .filter(Boolean)
  );
  let stop_id;
  do {
    stop_id = randStr(3);
  } while (existingStopIds.has(stop_id));

  // ── store_id — match To Store (or fall back to From Store for ISD if To not in DB) ─
  const stripPhoneDigits = (p) => (p || '').replace(/\D/g, '');
  const findStoreByPhone = (phone) => {
    if (!phone || !stores?.length) return null;
    const digits = stripPhoneDigits(phone);
    if (!digits) return null;
    return stores.find((s) => s?.phone && stripPhoneDigits(s.phone) === digits) || null;
  };
  const findStoreByName = (name) => {
    if (!name || !stores?.length) return null;
    const lower = name.toLowerCase();
    return stores.find((s) => s && s.name && s.name.toLowerCase().includes(lower));
  };
  const matchedDestStore = findStoreByPhone(dstPhone) || findStoreByName(formData._interstore_dest_name || '');
  const matchedSrcStore = findStoreByPhone(srcPhone) || findStoreByName(formData._interstore_source_name || '');

  // ISD: assign to To Store; if To Store not in DB, fall back to From Store.
  // ISP: always assign to To Store (existing behaviour).
  const assignedStore = matchedDestStore || (isDropOff ? matchedSrcStore : null);
  const store_id = assignedStore?.id || matchedSrcStore?.id || '';

  // ── puid ──────────────────────────────────────────────────────────────
  // ISP: look for any pickup stop on the To Store in the driver's route.
  // ISD: look for a *finished* (completed/en_route) Store Pickup for the To Store (or
  //      From Store if To not in DB) on the driver's route. Only reuse if found;
  //      otherwise generate a new stop_id-based puid below (after stop_id is set).
  const routeDeliveriesAll = (allDeliveries || []).filter(
    (d) => d && d.delivery_date === formData.delivery_date && d.driver_id === formData.driver_id
  );

  const findPickupForStore = (storeId, requireFinished = false) => {
    if (!storeId) return null;
    return routeDeliveriesAll.find((d) =>
      d && !d.patient_id && d.store_id === storeId && d.stop_id &&
      (!requireFinished || ['completed', 'en_route'].includes(d.status))
    ) || null;
  };

  // ── tracking_number ───────────────────────────────────────────────────
  const routeDeliveries = routeDeliveriesAll;

  // Use the assigned store for TR# logic
  const toStoreId = assignedStore?.id || '';

  // Find the pickup TR# base for the To Store on this driver/date (multiples of 20)
  const toStorePickup = routeDeliveries.find(
    (d) => d && !d.patient_id && d.store_id === toStoreId
  );
  const parseNum = (v) => { const n = parseInt(String(v || ''), 10); return Number.isNaN(n) ? null : n; };

  let tracking_number;
  if (toStorePickup && parseNum(toStorePickup.tracking_number) !== null) {
    // Follow the patient delivery series: pickupBaseTR + count + 1
    const pickupBase = parseNum(toStorePickup.tracking_number);
    const existingDeliveryTNs = routeDeliveries
      .filter((d) => d && d.patient_id && d.store_id === toStoreId)
      .map((d) => parseNum(d.tracking_number))
      .filter((v) => v !== null && v > pickupBase);
    const nextOffset = existingDeliveryTNs.length + 1;
    tracking_number = String(pickupBase + nextOffset).padStart(2, '0');
  } else {
    // No pickup found for To Store — fall back to max existing TR# + 1
    const existingTNs = routeDeliveries
      .map((d) => parseNum(d.tracking_number))
      .filter((v) => v !== null);
    const tnBase = existingTNs.length > 0 ? Math.max(...existingTNs) + 1 : 1;
    tracking_number = String(tnBase).padStart(2, '0');
  }

  // ── puid resolution (needs stop_id to be ready first for ISD new-puid case) ──
  let puid;
  if (isDropOff) {
    // ISD: reuse finished pickup for To Store (or From Store fallback); else generate new puid = stop_id
    const lookupStoreId = assignedStore?.id || '';
    const finishedPickup = findPickupForStore(lookupStoreId, true);
    puid = finishedPickup?.stop_id || stop_id; // new puid = this delivery's own stop_id
  } else {
    // ISP: look for any pickup stop on the To Store in the driver's route
    const pickupForDest = findPickupForStore(matchedDestStore?.id, false);
    puid = pickupForDest?.stop_id || '';
  }

  // ── ampm_deliveries ───────────────────────────────────────────────────
  const now = new Date();
  const ampm_deliveries = now.getHours() < 13 ? 'AM' : 'PM';

  // ── stop_order ────────────────────────────────────────────────────────
  const existingStopOrders = routeDeliveries.map((d) => Number(d?.stop_order || 0)).filter((v) => v > 0);
  const stop_order = existingStopOrders.length > 0 ? Math.max(...existingStopOrders) + 1 : 1;

  // ── delivery_time_start ───────────────────────────────────────────────
  // Priority: form value → From store delivery_time_start + 5 min → now + 5 min
  // ── delivery_time_end ─────────────────────────────────────────────────
  // Priority: form value → To store delivery_time_end → blank
  // Reuse already-resolved store matches
  const fromStore = matchedSrcStore;
  const toStore = matchedDestStore;

  // Helper: get whichever delivery_time field is active for the current day/time
  const getStoreTimeField = (store, field) => {
    if (!store) return '';
    const day = now.getDay(); // 0=Sun...6=Sat
    if (day === 0) return store[`sunday_am_${field}`] || store[`sunday_pm_${field}`] || '';
    if (day === 6) return store[`saturday_am_${field}`] || store[`saturday_pm_${field}`] || '';
    return store[`weekday_am_${field}`] || store[`weekday_pm_${field}`] || '';
  };

  // delivery_time_start: form override → From store start + 5 min → now + 5 min
  let delivery_time_start = formData.delivery_time_start || '';
  if (!delivery_time_start) {
    const fromStoreStart = getStoreTimeField(fromStore, 'start');
    if (fromStoreStart) {
      const [h, m] = fromStoreStart.split(':').map(Number);
      const storeStartMs = new Date(now).setHours(h, m, 0, 0);
      const adjusted = new Date(storeStartMs + 5 * 60 * 1000);
      delivery_time_start = `${String(adjusted.getHours()).padStart(2, '0')}:${String(adjusted.getMinutes()).padStart(2, '0')}`;
    } else {
      const startTime = new Date(now.getTime() + 5 * 60 * 1000);
      delivery_time_start = `${String(startTime.getHours()).padStart(2, '0')}:${String(startTime.getMinutes()).padStart(2, '0')}`;
    }
  }

  // delivery_time_end: form override → To store end → blank
  let delivery_time_end = formData.delivery_time_end || '';
  if (!delivery_time_end) {
    delivery_time_end = getStoreTimeField(toStore, 'end') || '';
  }

  // ── estimated_distance_km ─────────────────────────────────────────────
  const estimated_distance_km = formData._interstore_distance_km != null
    ? Number(formData._interstore_distance_km)
    : null;

  // ── created_by_app_user_id ────────────────────────────────────────────
  const currentAppUser = (appUsers || []).find((au) => au && au.user_id === currentUser?.id);
  const created_by_app_user_id = currentAppUser?.id || currentUser?.id || '';

  // ── delivery_notes ────────────────────────────────────────────────────
  const srcNum = formData._interstore_source_number || '';
  const dstNum = formData._interstore_dest_number || '';
  const transferLabel = isDropOff ? 'InterStore DropOff' : 'InterStore PickUp';
  const routeLine = srcNum && dstNum ? `SDM ${srcNum} -> ${dstNum}` : (srcNum || dstNum || '');
  const notes = formData._interstore_notes || '';
  const delivery_notes = [transferLabel, routeLine, notes].filter(Boolean).join('\n');

  // patient_name-equivalent: used as the display name across the app for this stop
  const patient_name = transferLabel;

  const payload = {
    delivery_id,
    delivery_date: formData.delivery_date,
    driver_id: formData.driver_id || '',
    driver_name: driver ? getDriverNameForStorage(driver) : formData.driver_name || '',
    patient_name,
    delivery_notes,
    _interstore_source_id: sourceId,
    _interstore_source_name: formData._interstore_source_name || '',
    _interstore_dest_id: destId,
    _interstore_dest_name: formData._interstore_dest_name || '',
    is_cycling_marker: false,
    patient_id: null,
    status: formData.status || 'in_transit',
    stop_id,
    puid,
    tracking_number,
    ampm_deliveries,
    stop_order,
    delivery_time_start,
    delivery_time_end,
    arrival_time: formData.arrival_time || '',
    actual_delivery_time: formData.actual_delivery_time || '',
    created_by_app_user_id,
    store_id,
    ...(estimated_distance_km != null ? { estimated_distance_km } : {}),
    ...(estimated_distance_km != null ? { paid_km_override: estimated_distance_km } : {}),
  };

  // ── Offline-first batch action ────────────────────────────────────────────
  // Build the record locally, save to offlineDB, run optimizer, then flush online.
  let created = null;

  const batchResult = await executeOfflineBatchAction({
    actionName: isDropOff ? 'AddInterStoreDropoff' : 'AddInterStorePickup',
    work: async () => {
      // Save a local temp record to offlineDB immediately so the UI is responsive
      const tempId = `temp_delivery_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const localRecord = { ...payload, id: tempId, _isLocal: true, created_date: new Date().toISOString(), updated_date: new Date().toISOString() };
      await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, [localRecord]).catch(() => null);
      return { records: [localRecord], driverId: formData.driver_id, deliveryDate: formData.delivery_date };
    },
    runOptimizer: true,
    optimizerContext: {
      deliveries: [], // optimizer will use offlineDB snapshot merged with the new record
      patients: [],
      stores,
      appUsers: appUsers || [],
    },
    applyLocalUI: (records) => {
      applyDeliveryChangesLocally?.({ upserts: records.filter(Boolean), deleteIds: [] });
    },
  });

  // The real backend record is the finalized one from the batch flush
  created = batchResult?.records?.[0] || null;
  return created;
}