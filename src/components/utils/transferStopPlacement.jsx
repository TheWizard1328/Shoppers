/**
 * TRANSFERRED-STOP PLACEMENT (owner spec Nov 3 2026)
 *
 * When a delivery moves to another date and/or driver it has to be "fished into"
 * that day's fixed pickup skeleton (home → P1 → P2 → … → Pn). This module
 * gathers the inputs and decides the four things a transfer owns:
 *
 *   1. PUID — a DATE change re-points to the patient's assigned store pickup on
 *      the new date (created first if that day has no pickups yet). A same-date
 *      DRIVER change keeps the current PUID.
 *   2. delivery_time_start — decided by the shared corridor rule in routeRules.js
 *      (09:00 lead, a pickup window + 5, or the tail pickup + 5).
 *   3. delivery_time_end — always cleared; it belongs to the old date's window.
 *   4. Driver note — "Delivery Transferred from [Driver] on [Date]" when the
 *      driver changes, "Delivery Transferred from [Date]" otherwise, appended on
 *      a new line when the stop already carries a note.
 *
 * The geometry itself lives in routeRules.js (resolveTransferStart) so the client
 * and server engines stay on one rule base. This file only does data plumbing.
 */
import { base44 } from '@/api/base44Client';
import { resolveTransferStart } from '../../../base44/functions/rxServerRouteOptimizer/routeRules.js';

const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'];
const BOOKED_OFF = '__booked_off__';

const dayOf = (v) => String(v || '').slice(0, 10);

const coordsOf = (row, storesById) => {
  const lat = Number(row?.latitude);
  const lng = Number(row?.longitude);
  if (Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0)) return { lat, lng };
  const store = storesById.get(String(row?.store_id || ''));
  const sLat = Number(store?.latitude);
  const sLng = Number(store?.longitude);
  if (Number.isFinite(sLat) && Number.isFinite(sLng) && !(sLat === 0 && sLng === 0)) return { lat: sLat, lng: sLng };
  return null;
};

const driverHome = (drivers, driverId) => {
  const match = (drivers || []).find((d) => d && (
    String(d.id) === String(driverId)
    || String(d.user_id || '') === String(driverId)
  ));
  const lat = Number(match?.home_latitude);
  const lng = Number(match?.home_longitude);
  if (Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0)) return { lat, lng };
  return null;
};

const driverLabel = (drivers, driverId, fallbackName) => {
  const match = (drivers || []).find((d) => d && (
    String(d.id) === String(driverId)
    || String(d.user_id || '') === String(driverId)
  ));
  return match?.user_name || match?.full_name || match?.driver_name || fallbackName || '';
};

/** Store + slot pairs this driver is scheduled for on a date (store day-of-week fields). */
const scheduledStoreSlots = (stores, targetDate, targetDriverId) => {
  const dow = new Date(`${dayOf(targetDate)}T00:00:00`).getDay();
  const prefix = dow === 6 ? 'saturday' : dow === 0 ? 'sunday' : 'weekday';
  const out = [];
  for (const store of stores || []) {
    if (!store || !store.id) continue;
    const amId = store[`${prefix}_am_driver_id`];
    const pmId = store[`${prefix}_pm_driver_id`];
    if (amId && String(amId) === String(targetDriverId)) out.push({ store, slot: 'AM' });
    if (pmId && String(pmId) === String(targetDriverId)) out.push({ store, slot: 'PM' });
  }
  return out;
};

/** Existing pickups for the driver + date, in the day's preset order. */
const pickupsForDay = (allDeliveries, targetDate, targetDriverId) => (allDeliveries || [])
  .filter((d) => d
    && !d.patient_id
    && dayOf(d.delivery_date) === dayOf(targetDate)
    && String(d.driver_id || '') === String(targetDriverId)
    && d.driver_id !== BOOKED_OFF
    && !d.is_cycling_marker)
  .sort((a, b) => (Number(a.stop_order) || 9999) - (Number(b.stop_order) || 9999));

/**
 * Creates the driver's default pickups for a date that has none yet.
 * Owner rule: "if I had no stops tomorrow I would need all of my default pickups
 * created first before the stop is transferred."
 */
const createDefaultPickups = async ({ stores, targetDate, targetDriverId, targetDriverName }) => {
  const created = [];
  const pairs = scheduledStoreSlots(stores, targetDate, targetDriverId);
  for (const { store, slot } of pairs) {
    try {
      const res = await base44.functions.invoke('ensurePickupForDelivery', {
        storeId: store.id,
        deliveryDate: dayOf(targetDate),
        driverId: targetDriverId,
        ampmDeliveries: slot,
        allowCreateIfMissing: true,
      });
      const pickup = res?.data?.pickup || null;
      if (pickup) {
        created.push({ ...pickup, ...(pickup.driver_name ? {} : { driver_name: targetDriverName }) });
      }
    } catch (err) {
      console.warn('[transferPlacement] ensurePickupForDelivery failed', store?.name, slot, err?.message || err);
    }
  }
  return created;
};

/**
 * Resolves everything a transfer needs. Returns null when there is nothing to
 * decide (no coords, no pickups possible) so the caller keeps its current values.
 */
export async function resolveTransferPlacement({
  delivery,
  targetDate,
  targetDriverId,
  targetDriverName,
  allDeliveries = [],
  stores = [],
  drivers = [],
  patients = [],
  options = null,
  // BULK ONLY (owner spec Nov 3 2026): a bulk move sends several stops to the
  // same target day. `cache` builds that day's pickup skeleton ONCE and lets
  // every stop rank against the same skeleton; `usedStarts` keeps two moved
  // stops off the same clock minute.
  cache = null,
  usedStarts = null,
}) {
  if (!delivery || !targetDate || !targetDriverId) return null;
  const nextDate = dayOf(targetDate);
  const prevDate = dayOf(delivery.delivery_date);
  const dateChanged = nextDate !== prevDate;
  const driverChanged = String(delivery.driver_id || '') !== String(targetDriverId || '');
  if (!dateChanged && !driverChanged) return null;
  if (delivery.is_cycling_marker || !delivery.patient_id) return null;

  const storesById = new Map((stores || []).filter((s) => s?.id).map((s) => [String(s.id), s]));
  const dayKey = `${String(targetDriverId)}::${nextDate}`;

  // ── 1. default pickups for the target day (owner rule Nov 9 2026, part 2) ──
  // "If a delivery is transferred to another driver and they have default
  // pickups for that day that haven't been added to their route yet, the default
  // pickups must be created first, THEN the stop is transferred." The transferred
  // stop itself never gets a new PUID and never gets its own pickup created
  // (part 1): the day's default pickups are what make its route valid.
  let createdPickups = [];
  try {
    const existing = pickupsForDay(allDeliveries, nextDate, targetDriverId);
    const wanted = scheduledStoreSlots(stores, nextDate, targetDriverId);
    const have = new Set(existing.map((p) => `${String(p.store_id || '')}:${String(p.ampm_deliveries || '')}`));
    const missing = wanted.filter(({ store, slot }) => !have.has(`${String(store?.id || '')}:${String(slot || '')}`));
    if (missing.length) {
      createdPickups = await createDefaultPickups({ stores, targetDate: nextDate, targetDriverId, targetDriverName });
      console.log(`[transferPlacement] created ${createdPickups.length} default pickup(s) for ${targetDriverName || targetDriverId} on ${nextDate} before transferring the stop`);
    }
  } catch (err) {
    console.warn('[transferPlacement] default pickup pre-creation failed:', err?.message || err);
  }
  const skeleton = pickupsForDay(allDeliveries.concat(createdPickups), nextDate, targetDriverId).map((p, i) => ({
    stopId: p.stop_id || p.puid || p.id || null,
    start: p.delivery_time_start || '',
    order: Number(p.stop_order) || i + 1,
  }));

  // ── 2. PUID never changes (owner rule Nov 9 2026) ─────────────────────────
  // The delivery was already collected, so it keeps the pickup it was collected
  // on. Re-pointing it at the receiving driver's store pickup stranded the stop
  // under a pickup that does not exist on their route.
  const nextPuid = null;

  // ── 3. route origin: home before duty, last-reached stop once running ──────
  const dayStops = (allDeliveries || []).filter((d) => d
    && d.patient_id
    && dayOf(d.delivery_date) === nextDate
    && String(d.driver_id || '') === String(targetDriverId));
  const touched = dayStops
    .filter((d) => d.arrival_time || d.actual_delivery_time)
    .sort((a, b) => String(b.actual_delivery_time || b.arrival_time || '').localeCompare(String(a.actual_delivery_time || a.arrival_time || '')))[0];
  const origin = (touched && coordsOf(touched, storesById)) || driverHome(drivers, targetDriverId);

  // ── 4. the stop's own point ───────────────────────────────────────────────
  const patient = (patients || []).find((p) => p && String(p.id) === String(delivery.patient_id));
  const point = coordsOf({ ...delivery, latitude: delivery.latitude ?? patient?.latitude, longitude: delivery.longitude ?? patient?.longitude }, storesById);
  if (!point) return null;

  // ── 5. start time (owner rule Nov 9 2026) ──────────────────────────────────
  // Already in the past → leave it exactly as it is (a collected stop must not
  // look freshly scheduled). Otherwise → transfer time + 5 minutes.
  const existingStart = String(delivery.delivery_time_start || '').slice(0, 16);
  const existingMs = existingStart ? new Date(existingStart.replace(' ', 'T')).getTime() : NaN;
  const placement = { startTime: existingStart };
  if (!Number.isFinite(existingMs) || existingMs > Date.now()) {
    const bumped = new Date(Date.now() + 5 * 60 * 1000);
    placement.startTime = `${String(bumped.getHours()).padStart(2, '0')}:${String(bumped.getMinutes()).padStart(2, '0')}`;
  }

  // Two stops moved to the same day must not share a clock minute.
  let startTime = placement.startTime || '';
  if (startTime && usedStarts) {
    const used = usedStarts.get(dayKey) || new Set();
    let guard = 0;
    while (used.has(startTime) && guard < 24) {
      const [hh, mm] = startTime.split(':').map(Number);
      const bumped = new Date(2000, 0, 1, hh || 0, mm || 0);
      bumped.setMinutes(bumped.getMinutes() + 5);
      startTime = `${String(bumped.getHours()).padStart(2, '0')}:${String(bumped.getMinutes()).padStart(2, '0')}`;
      guard += 1;
    }
    used.add(startTime);
    usedStarts.set(dayKey, used);
  }

  // ── 6. driver note ─────────────────────────────────────────────────────────
  const oldDriverName = delivery.driver_name || driverLabel(drivers, delivery.driver_id, '');
  const fromDate = prevDate || dayOf(delivery.created_date);
  const line = driverChanged && oldDriverName
    ? `Delivery Transferred from ${oldDriverName} on ${fromDate}`
    : `Delivery Transferred from ${fromDate}`;
  const existingNote = String(delivery.delivery_notes || '').trim();
  const nextNotes = existingNote && !existingNote.includes(line)
    ? `${existingNote}\n${line}`
    : (existingNote ? existingNote : line);

  return {
    dateChanged,
    driverChanged,
    puid: nextPuid,
    delivery_time_start: startTime,
    delivery_time_end: '',
    delivery_notes: nextNotes,
    placement: { ...placement, startTime },
    skeleton,
    dayKey,
    origin,
    createdPickups,
  };
}

export default resolveTransferPlacement;
