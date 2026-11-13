// cashTenderReset — owner rule (Nov 12 2026): when a COD's collection type is
// edited BACK to Cash, the delivery is no longer "collected". The earlier
// Debit/Credit collection stamps must be cleared, otherwise squareCodReconcile's
// desiredState() sees cod_confirmed_collected and returns 'ignore', so the
// Square catalog item is never re-created even though the COD is outstanding
// cash again.
//
// One shared implementation so the stop-card COD panel, the Save & Complete
// footer action and the Square COD/Balances tender edit all behave the same.
import { base44 } from '@/api/base44Client';
import { offlineDB } from '@/components/utils/offlineDatabase';

const DIRECT_TYPES = ['debit', 'credit', 'cheque', 'check', 'card', 'archived'];

/** true when the payment set is cash money and nothing was taken on a card/cheque. */
export function isCashOnlyCollection(codPayments) {
  const list = Array.isArray(codPayments) ? codPayments : [];
  const hasCash = list.some((p) => String(p?.type || '').toLowerCase() === 'cash' && Number(p?.amount || 0) > 0);
  const hasDirect = list.some((p) => DIRECT_TYPES.includes(String(p?.type || '').toLowerCase()) && Number(p?.amount || 0) > 0);
  return hasCash && !hasDirect;
}

/**
 * Clear the Square collection authority on a delivery that has gone back to
 * cash. Returns true when a write happened. Never throws.
 */
export async function resetCollectionStampsForCash(deliveryId, codPayments) {
  const id = String(deliveryId || '');
  if (!id || !isCashOnlyCollection(codPayments)) return false;
  const patch = { cod_confirmed_collected: false, cod_confirmed_collected_at: '', cod_card_spend_at: '' };
  try {
    await base44.entities.Delivery.update(id, patch);
  } catch (e) {
    console.warn('[cashTenderReset] stamp reset failed:', e?.message || e);
    return false;
  }
  try {
    // getById, never getAll — a full deliveries scan is the known IDB timeout
    // storm source on bloated local stores.
    const existing = await offlineDB.getById(offlineDB.STORES.DELIVERIES, id).catch(() => null);
    if (existing) await offlineDB.save(offlineDB.STORES.DELIVERIES, { ...existing, ...patch }).catch(() => {});
  } catch { /* mirror is best effort */ }
  return true;
}
