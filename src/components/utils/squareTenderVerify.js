/**
 * squareTenderVerify — auto-stamp the collection type from the REAL Square
 * swipe (owner spec Oct 9 2026):
 *   "After the money is on Square and I click back to the app, the type of
 *    transaction comes back — debit (Interac) sets the collection type to
 *    Debit, Visa / Mastercard / any credit sets it to Credit."
 *
 * Flow: the Square button records a pending POS launch (delivery + amount +
 * location + driver + timestamp) right before handing off to the POS app.
 * When the app regains focus (visibilitychange) with the COD collection
 * panel open, the panel asks squareCodTenderPeek (backend) to find the
 * driver's newest exact-amount card payment since the launch and reports
 * Square's card_brand / entry_method. The matching cod_payments entry is
 * then stamped Debit (INTERAC) or Credit (any other brand) in place of the
 * manually pre-seeded type — the driver no longer has to pick the tender.
 *
 * The pending record lives in sessionStorage (survives the POS round-trip,
 * clears on app restart) and expires after 10 minutes. A single in-flight
 * guard + 60s per-delivery cooldown keep the Square API rate budget safe.
 */

const PENDING_KEY = 'rxdeliver_pos_pending_tender_verify';
const PENDING_TTL_MS = 10 * 60 * 1000;
const VERIFY_COOLDOWN_MS = 60 * 1000;

let inFlight = false;
const lastVerifiedAt = new Map(); // deliveryId → ts

export const recordSquarePosLaunch = ({ deliveryId, amountCents, locationId, driverName }) => {
  try {
    if (!deliveryId || !amountCents || amountCents <= 0) return;
    sessionStorage.setItem(PENDING_KEY, JSON.stringify({
      deliveryId,
      amountCents,
      locationId: locationId || null,
      driverName: driverName || null,
      launchedAt: Date.now(),
    }));
  } catch (_) { /* storage unavailable — verification simply won't run */ }
};

export const getPendingSquarePosLaunch = (deliveryId) => {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const rec = JSON.parse(raw);
    if (!rec?.deliveryId || rec.deliveryId !== deliveryId) return null;
    if (Date.now() - Number(rec.launchedAt || 0) > PENDING_TTL_MS) {
      sessionStorage.removeItem(PENDING_KEY);
      return null;
    }
    return rec;
  } catch (_) { return null; }
};

export const clearPendingSquarePosLaunch = () => {
  try { sessionStorage.removeItem(PENDING_KEY); } catch (_) {}
};

/**
 * Ask the backend for the tender of the swipe. Returns:
 *   { matched: true, tender, card_brand, entry_method, ... } or
 *   { matched: false, reason } — never throws (caller falls back to the
 *   manually selected tender, which is the pre-existing behaviour).
 */
export const verifySquareTender = async (pending, { deliveryId } = {}) => {
  if (inFlight) return { matched: false, reason: 'in_flight' };
  const key = deliveryId || pending?.deliveryId;
  if (key) {
    const last = lastVerifiedAt.get(key) || 0;
    if (Date.now() - last < VERIFY_COOLDOWN_MS) return { matched: false, reason: 'cooldown' };
  }
  inFlight = true;
  try {
    const { base44 } = await import('@/api/base44Client');
    const res = await base44.functions.invoke('squareCodTenderPeek', {
      amountCents: pending.amountCents,
      locationId: pending.locationId,
      driverName: pending.driverName,
      sinceMs: pending.launchedAt,
    });
    if (key) lastVerifiedAt.set(key, Date.now());
    return {
      matched: !!res?.matched,
      tender: res?.tender || null,
      card_brand: res?.card_brand || null,
      entry_method: res?.entry_method || null,
      reason: res?.matched ? null : (res?.error ? 'api_error' : 'no_card_payment_match'),
    };
  } catch (_) {
    return { matched: false, reason: 'api_error' };
  } finally {
    inFlight = false;
  }
};
