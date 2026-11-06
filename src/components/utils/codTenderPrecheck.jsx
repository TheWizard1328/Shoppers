/**
 * codTenderPrecheck — flag a wrong COD collection type BEFORE it is saved.
 *
 * OWNER SPEC (Nov 5 2026): the background heal already repairs a mis-typed
 * collection type from the Square ledger, but it can take a minute or two.
 * When the driver comes back to the app (POS round-trip, app resume) with a COD
 * card expanded and a collection type selected that is NOT saved yet, the
 * recorded tender can be looked up at that moment and the mismatch shown right
 * on the card — before the driver taps Save.
 *
 * READ-ONLY: this module never writes a delivery, never touches Square. It only
 * reports which collection type Square actually recorded. The driver (or the
 * existing background heal) still makes the change.
 *
 * Lookup order, cheapest first:
 *   1. the offline Square ledger cache already on the device (free, instant)
 *   2. squareCodTenderPeek (one Square call, card payments only, 90s cooldown)
 *
 * Known limits (accepted):
 *   • squareCodTenderPeek only matches CARD payments, so a cash mis-type is
 *     only detectable from the local ledger.
 *   • split payments are compared per amount; an ambiguous match simply
 *     reports nothing instead of guessing.
 */

import { getLedgerEntriesOffline } from './squareLedgerOfflineManager';

const TENDER_COOLDOWN_MS = 90 * 1000;
const PEEK_WINDOW_MS = 6 * 60 * 60 * 1000; // a returned-to card is never older than this

const lastPeekAt = new Map(); // deliveryId -> ts of last Square call
let inFlight = false;

// Collection types that can be verified against Square.
export const VERIFIABLE_TYPES = ['Cash', 'Debit', 'Credit'];

/**
 * Square ledger row -> RxDeliver collection type.
 *   CASH                       → Cash
 *   INTERAC card / DEBIT tender → Debit
 *   any other card brand       → Credit
 */
export const collectionTypeFromSquare = (row) => {
  const tender = String(row?.tender_type || '').toUpperCase();
  const brand = String(row?.card_brand || '').toUpperCase();
  if (!tender && !brand) return null;
  if (tender.includes('CASH')) return 'Cash';
  if (brand === 'INTERAC' || tender.includes('INTERAC') || tender === 'DEBIT') return 'Debit';
  return 'Credit';
};

/** Recorded tender for a delivery from the offline ledger cache (free). */
export const peekRecordedTenderLocal = async (deliveryId) => {
  if (!deliveryId) return null;
  try {
    const rows = await getLedgerEntriesOffline();
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const mine = rows.filter((r) => r && r.delivery_id === deliveryId);
    if (mine.length === 0) return null;
    const newest = [...mine].sort((a, b) =>
      String(b.occurred_at || b.created_date || '').localeCompare(String(a.occurred_at || a.created_date || ''))
    )[0];
    return collectionTypeFromSquare(newest);
  } catch (_) {
    return null;
  }
};

/**
 * Recorded tender for a delivery, local cache first then one Square peek.
 * Returns { tender, source } — tender is null when nothing could be verified.
 * Never throws.
 */
export const peekRecordedTender = async ({ deliveryId, amountCents }) => {
  const local = await peekRecordedTenderLocal(deliveryId);
  if (local) return { tender: local, source: 'ledger' };

  if (!deliveryId || !amountCents || amountCents <= 0) return { tender: null, source: null };
  const last = lastPeekAt.get(deliveryId) || 0;
  if (Date.now() - last < TENDER_COOLDOWN_MS || inFlight) return { tender: null, source: null };

  inFlight = true;
  try {
    const { base44 } = await import('@/api/base44Client');
    const res = await base44.functions.invoke('squareCodTenderPeek', {
      amountCents,
      sinceMs: Date.now() - PEEK_WINDOW_MS,
    });
    lastPeekAt.set(deliveryId, Date.now());
    return { tender: res?.matched ? (res.tender || null) : null, source: 'square' };
  } catch (_) {
    return { tender: null, source: null };
  } finally {
    inFlight = false;
  }
};

/**
 * Entries whose type is selected locally but is not what the delivery already
 * has saved. That is exactly the window the owner described: the driver has
 * picked a collection type and has not tapped Save yet.
 */
export const findUnsavedSelections = (codPayments, savedPayments) => {
  const saved = Array.isArray(savedPayments) ? savedPayments : [];
  const isAlreadySaved = (payment) => saved.some((s) =>
    Math.abs((Number(s?.amount) || 0) - (Number(payment?.amount) || 0)) < 0.005
    && String(s?.type || '') === String(payment?.type || '')
  );
  return (Array.isArray(codPayments) ? codPayments : [])
    .map((payment, index) => ({ payment, index }))
    .filter(({ payment }) => payment?.type && !isAlreadySaved(payment));
};
