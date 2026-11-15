// PICKUP AM/PM CASCADE (owner spec Nov 14 2026)
//
// "This change should also affect all the stops that same date with the same
// PUID." A pickup owns the slot for its whole PUID family: the pickup row plus
// every patient stop hanging off it (stop.puid === pickup.stop_id). When an
// admin flips the slot on the pickup, this walks that family for the same
// delivery_date and writes the new AM/PM onto each row through the normal
// updateDeliveryLocal gateway (IDB first, backend queued) so polylines, badges,
// card grouping and payroll all agree.
//
// Only ampm_deliveries is written. Time windows stay exactly as the dispatcher
// set them on the pickup — nothing here silently moves a stop's schedule.

import { offlineDB } from './offlineDatabase';

const normalizeSlot = (value) => {
  const slot = String(value || '').trim().toUpperCase();
  return slot === 'AM' || slot === 'PM' ? slot : null;
};

const samePuidFamily = (row, puidKey, pickupPuid) => {
  if (!row) return false;
  if (row.puid && row.puid === puidKey) return true;
  if (row.stop_id && row.stop_id === puidKey) return true;
  // Legacy rows carried the pickup id in puid while stop_id moved on.
  if (pickupPuid && row.puid && row.puid === pickupPuid) return true;
  return false;
};

/**
 * @param {object}   params.pickup            The pickup row AFTER its slot change.
 * @param {string}   params.newSlot           'AM' | 'PM'
 * @param {string}   params.previousSlot      Slot before the change (audit only).
 * @param {function} params.updateDeliveryLocal  The central write gateway.
 * @returns {Promise<{matched:number, updated:number, failed:number}>}
 */
export const cascadePickupSlotChange = async ({ pickup, newSlot, previousSlot = null, updateDeliveryLocal }) => {
  const slot = normalizeSlot(newSlot);
  const result = { matched: 0, updated: 0, failed: 0 };
  if (!pickup?.id || !slot) return result;

  const puidKey = pickup.stop_id || pickup.puid;
  if (!puidKey) return result;
  const dateKey = String(pickup.delivery_date || '');

  let pool = [];
  try {
    pool = (await offlineDB.getAll(offlineDB.STORES.DELIVERIES)) || [];
  } catch (_) {
    pool = [];
  }
  if (!pool.length && typeof window !== 'undefined') {
    pool = Array.isArray(window.__appDeliveries) ? window.__appDeliveries : [];
  }

  const targets = pool.filter((row) => {
    if (!row || row.id === pickup.id) return false;
    if (String(row.delivery_date || '') !== dateKey) return false;
    if (['cancelled', 'failed'].includes(row.status)) return false;
    if (!samePuidFamily(row, puidKey, pickup.puid)) return false;
    return normalizeSlot(row.ampm_deliveries) !== slot;
  });

  result.matched = targets.length;
  for (const row of targets) {
    try {
      await updateDeliveryLocal(row.id, { ampm_deliveries: slot }, {
        skipSmartRefresh: true,
        skipPickupSlotCascade: true
      });
      result.updated += 1;
    } catch (error) {
      result.failed += 1;
      console.warn('[PickupSlotCascade] Could not move stop to the new slot', {
        deliveryId: row.id,
        puid: row.puid || row.stop_id || null,
        from: row.ampm_deliveries || null,
        to: slot,
        previousSlot,
        error: error?.message || String(error)
      });
    }
  }

  if (result.updated > 0) {
    console.warn('[PickupSlotCascade] Pickup slot change cascaded', {
      pickup: pickup.stop_id || pickup.id,
      date: dateKey,
      from: previousSlot,
      to: slot,
      matched: result.matched,
      updated: result.updated
    });
  }

  return result;
};

export default cascadePickupSlotChange;
