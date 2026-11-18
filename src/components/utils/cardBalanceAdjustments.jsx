/**
 * cardBalanceAdjustments — owner rule (Nov 18 2026, Londonderry $10.50):
 *
 * "if a cod to collect is removed from a delivery or that delivery with a cod
 *  to collect is deleted, the amount of that cod needs to be added back to the
 *  card balance"
 *
 * WHY THIS EXISTS
 * ---------------
 * A COD to collect that is created after the last true-up is DEDUCTED from the
 * store card estimate by default (computePendingCodDeduction, owner rule
 * Oct 6-7 2026): the card is presumed charged for the prescription until the
 * COD money comes back. The deduction is derived from the DELIVERY record, so
 * the moment that delivery is deleted (or its COD is cleared) the deduction
 * silently disappears from the math — but the physical card already paid that
 * money out. The card balance then reads LOW by exactly the COD amount, with
 * no row anywhere in Payment Discrepancies or Card Transfer to explain it
 * (the Square side is a CARD SPEND + CARD SPEND REFUND, which the payments
 * API never returns).
 *
 * FIX
 * ---
 * When a COD is removed or its delivery is deleted, append a durable, signed
 * adjustment to the square_balances config so the amount is added back to that
 * location's card estimate. Adjustments are additive cents and survive
 * deletes, reloads and true-ups.
 *
 * ONLY REVERSES A DEDUCTION THAT WAS REALLY APPLIED: callers must pass
 * `wasDeducted` (see shouldReverseCodDeduction) so a COD that was never
 * deducted (pre-true-up and counted, or marked Not Tapped) is not credited
 * twice.
 */

import { base44 } from '@/api/base44Client';
import { buildStoreToLocMap } from '@/components/square/useSquareBalancesSummary';

export const SETTING_KEY = 'square_balances';

const toCents = (v) => Math.round(Number(v || 0) * 100);

/** Location id for a store (Store -> SquareLocationConfig -> square_location_id). */
export async function locationIdForStore(storeId) {
  if (!storeId) return null;
  try {
    const map = await buildStoreToLocMap();
    return map?.get?.(String(storeId)) || null;
  } catch (_) {
    return null;
  }
}

/**
 * Was this delivery's COD actually being deducted from the card estimate?
 * Mirrors computePendingCodDeduction: only CODs created at/after the true-up
 * (or with a card-spend stamp at/after it) deduct by default.
 */
export function shouldReverseCodDeduction(delivery, truedUpAt) {
  if (!delivery) return false;
  if (!(toCents(delivery?.cod_total_amount_required) > 0)) return false;
  const tu = truedUpAt ? new Date(truedUpAt).getTime() : null;
  if (tu == null) return false; // no true-up snapshot: nothing was deducted
  const createdT = delivery?.created_date ? new Date(delivery.created_date).getTime() : null;
  if (createdT != null && Number.isFinite(createdT) && createdT >= tu) return true;
  const spendT = delivery?.cod_card_spend_at ? new Date(delivery.cod_card_spend_at).getTime() : null;
  if (spendT != null && Number.isFinite(spendT) && spendT >= tu) return true;
  return false;
}

/** Sum of adjustment cents per location_id (all adjustments, or since a stamp). */
export function sumAdjustmentsByLoc(config, sinceIso = null) {
  const out = new Map();
  const since = sinceIso ? new Date(sinceIso).getTime() : null;
  for (const a of Array.isArray(config?.card_adjustments) ? config.card_adjustments : []) {
    const loc = String(a?.location_id || '');
    if (!loc) continue;
    if (since != null) {
      const at = a?.at ? new Date(a.at).getTime() : null;
      if (at == null || !Number.isFinite(at) || at < since) continue;
    }
    const cents = Math.round(Number(a?.amount_cents || 0));
    if (!cents) continue;
    out.set(loc, (out.get(loc) || 0) + cents);
  }
  return out;
}

/**
 * Append one adjustment to the square_balances config.
 * Idempotent per (delivery_id, kind): re-running the same delete cannot
 * double-credit.
 */
export async function addCardBalanceAdjustment({
  locationId,
  storeId = null,
  storeName = null,
  deliveryId = null,
  patientName = null,
  amountCents,
  kind = 'cod_removed',
  reason = null,
}) {
  const cents = Math.round(Number(amountCents || 0));
  if (!locationId || !(cents > 0)) return { ok: false, reason: 'invalid' };
  try {
    const existingRows = await base44.entities.AppSettings.filter({ setting_key: SETTING_KEY }, '-updated_date', 1).catch(() => []);
    const row = Array.isArray(existingRows) ? existingRows[0] : existingRows?.items?.[0];
    if (!row?.id) return { ok: false, reason: 'no_config' };
    const config = { ...(row?.setting_value || {}) };
    const list = Array.isArray(config.card_adjustments) ? [...config.card_adjustments] : [];
    const dupe = list.some((a) => String(a?.delivery_id || '') === String(deliveryId || '')
      && String(a?.kind || '') === String(kind)
      && String(a?.location_id || '') === String(locationId));
    if (dupe) return { ok: true, skipped: 'duplicate' };
    list.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      location_id: String(locationId),
      store_id: storeId ? String(storeId) : null,
      store_name: storeName || null,
      delivery_id: deliveryId ? String(deliveryId) : null,
      patient_name: patientName || null,
      amount_cents: cents,
      kind,
      reason: reason || null,
      at: new Date().toISOString(),
    });
    config.card_adjustments = list;
    await base44.entities.AppSettings.update(row.id, { setting_value: config });
    return { ok: true, amount_cents: cents };
  } catch (e) {
    console.warn('[cardBalanceAdjustments] append failed:', e?.message || e);
    return { ok: false, reason: 'error' };
  }
}

/** Config loader (fresh, one row). */
export async function loadSquareBalancesConfig() {
  try {
    const rows = await base44.entities.AppSettings.filter({ setting_key: SETTING_KEY }, '-updated_date', 1);
    const row = Array.isArray(rows) ? rows[0] : rows?.items?.[0];
    return row?.setting_value || null;
  } catch (_) {
    return null;
  }
}

/**
 * One-call helper for the delete / COD-removal paths.
 * Reads the config, decides whether a reversal is owed, appends it.
 */
export async function reverseCodDeductionForDelivery(delivery, { kind = 'cod_removed', storeName = null } = {}) {
  if (!delivery) return { ok: false, reason: 'no_delivery' };
  // SERVER PATH FIRST: the backend runs as the service role, so the reversal is
  // recorded no matter which role deleted the stop. Falls back to a direct
  // AppSettings write (owner/admin) if the function is unavailable.
  try {
    const res = await base44.functions.invoke('codCardReversal', {
      deliveryId: delivery?.id || null,
      storeId: delivery?.store_id || null,
      amountCents: toCents(delivery?.cod_total_amount_required),
      patientName: delivery?.patient_name || null,
      createdDate: delivery?.created_date || null,
      codCardSpendAt: delivery?.cod_card_spend_at || null,
      kind,
    });
    const data = res?.data || res;
    if (data?.success) return { ok: true, via: 'function', added: data?.added_cents || 0, skipped: data?.skipped || null };
  } catch (_) { /* fall through to the local write */ }
  try {
    const config = await loadSquareBalancesConfig();
    if (!config) return { ok: false, reason: 'no_config' };
    if (!shouldReverseCodDeduction(delivery, config?.trued_up_at)) return { ok: false, reason: 'not_deducted' };
    const locationId = await locationIdForStore(delivery?.store_id);
    if (!locationId) return { ok: false, reason: 'no_location' };
    return await addCardBalanceAdjustment({
      locationId,
      storeId: delivery?.store_id || null,
      storeName,
      deliveryId: delivery?.id || null,
      patientName: delivery?.patient_name || null,
      amountCents: toCents(delivery?.cod_total_amount_required),
      kind,
      reason: `COD ${kind === 'delivery_deleted' ? 'removed with deleted delivery' : 'removed'} — added back to the card`,
    });
  } catch (e) {
    console.warn('[cardBalanceAdjustments] reverse failed:', e?.message || e);
    return { ok: false, reason: 'error' };
  }
}
