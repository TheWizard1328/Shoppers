import { base44 } from '@/api/base44Client';
import { offlineDB } from '@/components/utils/offlineDatabase';
import { syncDeliverySquareCod } from '@/components/utils/squareCodSync';
import {
  estimateCardFeeCents,
  folderCentsFor,
  buildStoreToLocMap,
  invalidateIdbReadCache,
} from './useSquareBalancesSummary';

/**
 * COD tender writes — ONE implementation shared by the Square Balances page
 * (Set tender popup on the location cards) and the Square COD page's Deliveries
 * tab (tap a Cash or Failed amount badge).
 *
 * Owner spec (Nov 10 2026): the amount badges on the Deliveries tab must be
 * tappable without changing their size or shape, and a Cash badge or a failed
 * delivery's badge must be switchable to Debit, Credit or Refunded. Both
 * surfaces therefore run the SAME fee / loan / folder math and the same
 * delivery stamping, so a change made in either place can never drift.
 *
 * Nothing here touches React state: each function resolves to
 * { ok, message } and the caller shows the toast and refreshes its own view.
 */

const SETTING_KEY = 'square_balances';

// COMBINED-SWIPE SUPPORT (owner rule Oct 9 2026): proportional largest-remainder
// split of one swipe's fee/loan/folder cents across the combined items so the
// parts sum EXACTLY to the whole.
function splitSwipeCents(total, weights) {
  const w = weights.map((x) => Math.max(0, Number(x) || 0));
  const sum = w.reduce((a, b) => a + b, 0);
  const totalC = Math.round(Number(total) || 0);
  if (sum <= 0 || totalC === 0) return w.map(() => 0);
  const raw = w.map((x) => totalC * x / sum);
  const base = raw.map(Math.floor);
  let left = totalC - base.reduce((a, b) => a + b, 0);
  const order = raw.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) {
    if (left <= 0) break;
    base[i] += 1;
    left -= 1;
  }
  return base;
}

// Loan rates + folder rate live in the square_balances AppSettings record. The
// Balances page already holds it, the Deliveries tab does not, so load it here
// when the caller has nothing to pass (newest record wins — duplicates exist).
async function loadBalancesConfig() {
  const rows = await base44.entities.AppSettings.filter({ setting_key: SETTING_KEY }, undefined, 5, 0).catch(() => []);
  const rec = (rows || []).filter(Boolean).sort((a, b) => String(b?.updated_date || '').localeCompare(String(a?.updated_date || '')))[0];
  const value = rec?.setting_value;
  return value && Array.isArray(value.locations) ? value : null;
}

const fetchDelivery = async (id) => {
  const rows = await base44.entities.Delivery.filter({ id: String(id) }, undefined, 1, 0).catch(() => []);
  return (rows || [])[0] || null;
};

/**
 * Change a delivery's COD tender.
 *   toType 'Debit' | 'Credit'  → cash payments (or a missing payment on an
 *                                uncollected COD) become that card tender and
 *                                accrue Square fee + loan% + folder%.
 *   toType 'Cash'              → card payments go back to drawer cash and every
 *                                card stamp/split cent is stripped.
 */
export async function changeCodTender({ deliveryId, toType, combineIds = [], config = null }) {
  const target = String(toType || '').toLowerCase();
  try {
    const mainId = String(deliveryId);
    const others = Array.from(new Set((combineIds || []).map(String).filter((x) => x && x !== mainId)));
    const d = await fetchDelivery(mainId);
    if (!d) return { ok: false, message: 'Could not find that delivery' };
    const otherRecs = [];
    for (const xid of others) {
      const xd = await fetchDelivery(xid);
      if (!xd) return { ok: false, message: 'Could not find a combined delivery' };
      otherRecs.push(xd);
    }
    const cfg = config || await loadBalancesConfig();
    // Cash -> Debit/Credit converts cash payments; Debit/Credit -> Cash
    // (owner rule Oct 9 2026) converts card payments back to drawer cash.
    const convertible = target === 'cash' ? ['debit', 'credit'] : ['cash'];
    const allRecs = [d, ...otherRecs];
    const plan = allRecs.map((rec) => {
      const recPayments = Array.isArray(rec.cod_payments) ? rec.cod_payments : [];
      const convIdx = [];
      const nextPayments = recPayments.map((p, i) => {
        if (p && convertible.includes(String(p?.type || '').toLowerCase())) {
          convIdx.push(i);
          return { ...p, type: toType };
        }
        return p;
      });
      // UNCOLLECTED ITEM IN A COMBINED SWIPE (owner rule Oct 9 2026): a pending
      // COD has no payments yet — the swipe IS its collection. Create its card
      // payment for the outstanding amount so it joins the fee split.
      if (!convIdx.length && target !== 'cash') {
        const requiredC = Math.round(Number(rec?.cod_total_amount_required || 0) * 100);
        const nonCashC = recPayments.
        filter((p) => ['debit', 'credit', 'cheque'].includes(String(p?.type || '').toLowerCase())).
        reduce((sm, p) => sm + Math.round(Number(p?.amount || 0) * 100), 0);
        const addC = Math.max(0, requiredC - nonCashC);
        if (addC > 0) {
          nextPayments.push({ type: toType, amount: addC / 100 });
          convIdx.push(nextPayments.length - 1);
        }
      }
      return {
        rec,
        nextPayments,
        convIdx,
        convCents: convIdx.reduce((sm, i) => sm + Math.round(Number(nextPayments[i]?.amount || 0) * 100), 0),
        changed: convIdx.length > 0,
      };
    });
    if (!plan[0].changed) return { ok: false, message: `Payment is already ${toType}` };
    if (others.length && !plan.every((x) => x.changed)) return { ok: false, message: 'A combined item has no matching payment' };

    const totalCents = plan.reduce((sm, x) => sm + x.convCents, 0);
    if (target !== 'cash') {
      // ONE SWIPE, ONE FEE SET (owner rule Oct 9 2026): fees / loan / folder are
      // computed on the COMBINED swipe total, then split proportionally.
      const storeToLoc = await buildStoreToLocMap().catch(() => new Map());
      const loanRateByLoc = new Map((cfg?.locations || []).map((l) => [String(l.location_id), Number(l.loan_rate) || 0]));
      const folderRateNow = Number.isFinite(Number(cfg?.folder_rate)) ? Number(cfg.folder_rate) : 0.02;
      const feeC = estimateCardFeeCents(totalCents, toType);
      const locId = storeToLoc.get(String(d.store_id || '')) || null;
      const loanC = Math.round(totalCents * (locId ? loanRateByLoc.get(String(locId)) || 0 : 0));
      const folderC = folderCentsFor(totalCents, folderRateNow);
      const itemWeights = plan.map((x) => x.convCents);
      const feeSplit = splitSwipeCents(feeC, itemWeights);
      const loanSplit = splitSwipeCents(loanC, itemWeights);
      const folderSplit = splitSwipeCents(folderC, itemWeights);
      plan.forEach((x, k) => {
        const pWeights = x.convIdx.map((i) => Math.round(Number(x.rec.cod_payments[i]?.amount || 0) * 100));
        const feeP = splitSwipeCents(feeSplit[k], pWeights);
        const loanP = splitSwipeCents(loanSplit[k], pWeights);
        const folderP = splitSwipeCents(folderSplit[k], pWeights);
        x.convIdx.forEach((pi, j) => {
          const grossP = Math.round(Number(x.rec.cod_payments[pi]?.amount || 0) * 100);
          const f = feeP[j],
            l = loanP[j],
            fo = folderP[j];
          x.nextPayments[pi] = {
            ...x.nextPayments[pi],
            fee_c: f,
            loan_c: l,
            folder_c: fo,
            settled_c: Math.max(0, grossP - f - l - fo),
            swipe_total_c: totalCents,
          };
        });
      });
    } else {
      // CARD -> CASH: strip the stored swipe-split cents — drawer money has no
      // card fee math.
      plan.forEach((x) => x.convIdx.forEach((pi) => {
        const { fee_c, folder_c, loan_c, settled_c, swipe_total_c, ...rest } = x.nextPayments[pi];
        x.nextPayments[pi] = rest;
      }));
    }

    const noteSuffix =
    target === 'cash' ?
    'Collected in cash.' :
    `Paid Via Drivers ${toType} card${others.length ? ` (combined swipe $${(totalCents / 100).toFixed(2)})` : ''}.`;
    // CARD -> CASH clears every collection stamp; CASH -> CARD stamps the
    // conversion instant so the credit math counts this new card money.
    const stampUpdate =
    target === 'cash' ?
    { cod_card_spend_at: '', cod_confirmed_collected: false, cod_confirmed_collected_at: '' } :
    { cod_card_spend_at: new Date().toISOString() };

    const updatedRecs = [];
    for (const x of plan) {
      const existingNote = String(x.rec.delivery_notes || '');
      const nextNote = existingNote ? `${existingNote} ${noteSuffix}` : noteSuffix;
      const updatePayload = { cod_payments: x.nextPayments, delivery_notes: nextNote, ...stampUpdate };
      await base44.entities.Delivery.update(String(x.rec.id), updatePayload);
      updatedRecs.push({ ...x.rec, ...updatePayload });
    }
    // The fee / outstanding math reads the local IDB mirror and our own write's
    // WS echo is suppressed for 5 minutes — update the mirror and drop the read
    // cache FIRST so every recompute sees fresh data.
    await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, updatedRecs).catch(() => {});
    invalidateIdbReadCache('deliveries');
    // OWNER REPORT (Nov 12 2026): switching a COD from Debit/Credit back to Cash
    // never put the item back in the Square catalog. This edit path wrote the
    // tender and nothing else — no reconcile ever ran, and the code above had
    // already cleared the collection stamps, so the item belongs in the register
    // again (cash → item must exist, card → item must not). One authoritative
    // reconcile per changed delivery; the backend decides create vs remove.
    for (const r of updatedRecs) {
      syncDeliverySquareCod(String(r.id), {
        status: r.status,
        cod_total_amount_required: r.cod_total_amount_required,
        cod_payments: r.cod_payments,
        patient_name: r.patient_name,
        delivery_date: r.delivery_date,
        store_id: r.store_id,
      });
    }
    try { window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { source: 'codTenderChange', ids: updatedRecs.map((r) => r.id) } })); } catch (_) {/* noop */}
    return {
      ok: true,
      message:
      target === 'cash' ?
      'COD payment set to Cash' :
      `COD payment set to ${toType}${others.length ? ` (${plan.length} items, one swipe)` : ''}`,
    };
  } catch (e) {
    console.error('changeCodTender failed:', e);
    return { ok: false, message: 'Could not update the COD payment' };
  }
}

/**
 * Refund a collected COD. The customer's money was handed back, so the delivery
 * stops owing or holding a COD: clear the amount, the payments, every collection
 * stamp, add the audit note, and pull the item out of the Square register
 * catalog so it cannot be rung again.
 */
export async function refundCodDelivery({ deliveryId }) {
  try {
    const d = await fetchDelivery(deliveryId);
    if (!d) return { ok: false, message: 'Could not find that delivery' };
    const payments = Array.isArray(d.cod_payments) ? d.cod_payments : [];
    const requiredNum = Number(d.cod_total_amount_required || 0);
    const paidNum = payments.reduce((sm, pm) => sm + (Number(pm?.amount) || 0), 0);
    const amount = requiredNum > 0 ? requiredNum : paidNum;
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Edmonton' });
    const noteSuffix = `Original COD of $${amount.toFixed(2)} was refunded on ${today}.`;
    const existingNote = String(d.delivery_notes || '');
    const updatePayload = {
      cod_total_amount_required: 0,
      cod_payments: [],
      cod_card_spend_at: '',
      cod_confirmed_collected: false,
      cod_confirmed_collected_at: '',
      cod_refunded_at: new Date().toISOString(),
      cod_refunded_amount: amount,
      // OWNER RULE (Nov 8 2026): an existing note is preserved and the refund
      // note starts on its OWN new line.
      delivery_notes: existingNote ? `${existingNote}\n${noteSuffix}` : noteSuffix,
    };
    await base44.entities.Delivery.update(String(d.id), updatePayload);
    await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, [{ ...d, ...updatePayload }]).catch(() => {});
    invalidateIdbReadCache('deliveries');
    // A refunded COD must leave the register catalog too, otherwise the COD item
    // keeps sitting on the POS and can be rung again.
    let catalogNote = '';
    try {
      const delRes = await base44.functions.
      invoke('squareDeleteCodItem', {
        deliveryId: String(d.id),
        reason: 'COD refunded from Square COD deliveries badge',
      }).
      catch((e) => {
        console.warn('squareDeleteCodItem failed:', e?.message || e);
        return null;
      });
      if (delRes === null) catalogNote = ' (catalog item delete failed — run a catalog reconcile)';
    } catch (e) {
      console.warn('squareDeleteCodItem failed:', e?.message || e);
      catalogNote = ' (catalog item delete failed — run a catalog reconcile)';
    }
    try { window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { source: 'codRefund', ids: [d.id] } })); } catch (_) {/* noop */}
    return { ok: true, message: `COD of $${amount.toFixed(2)} marked refunded${catalogNote}` };
  } catch (e) {
    console.error('refundCodDelivery failed:', e);
    return { ok: false, message: 'Could not mark the COD as refunded' };
  }
}

/** Tender kinds a Cash badge or a failed delivery's badge may switch to. */
export const TENDER_CHOICES_FOR_CASH = ['Debit', 'Credit'];
