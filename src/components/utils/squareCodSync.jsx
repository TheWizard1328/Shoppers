// squareCodSync — the ONE client entry point for Square COD catalog reconciliation.
//
// Replaces ALL scattered client-side create/delete decision logic:
//   deleteCODWithTimeout, createCODWithTimeout, updateSquareCODIfChanged,
//   deleteSquareCODOnCompletion, cleanupSquareCodCatalogForDate, triggerSquareCodCreate/
//   Upsert/Delete, and inline base44.functions.invoke('squareCreateCodItem'/'squareDeleteCodItem')
//   calls throughout useStopCardActions / DeliveryForm / DeliveryFormView / handleBatchSave /
//   StopCardCODCollection / StopCardConfirmDialogs / entityMutations.
//
// The backend function `squareCodReconcile` derives the desired state from the
// AUTHORITATIVE DB delivery record and makes the live Square catalog match:
//   active + COD > 0 → item must exist
//   completed + cash → item stays until squareReconcile matches the driver's deposit
//   completed + debit/credit/cheque → item must not exist (collected directly)
//   failed/cancelled/returned → item must not exist
//   pending/staged → item must not exist
//
// All calls are fire-and-forget: never block UI flows on Square. Idempotent — safe to
// call repeatedly; safe to lose a call (the scheduled sweep self-heals within minutes).
import { base44 } from '@/api/base44Client';

// Only cod decision inputs + identity fields needed for item naming are honored
// server-side. Patches exist for records the caller JUST wrote whose DB write may
// not have propagated yet — they are overrides the reconciler layers over the DB record.
const PATCH_FIELDS = [
  'status',
  'cod_total_amount_required',
  'cod_payments',
  'cod_payment_type',
  'patient_name',
  'delivery_date',
  'store_id'
];

export const buildCodPatch = (patch) => {
  if (!patch || typeof patch !== 'object') return undefined;
  const out = {};
  for (const k of PATCH_FIELDS) if (patch[k] !== undefined) out[k] = patch[k];
  return Object.keys(out).length > 0 ? out : undefined;
};

const report = (label, promise) =>
  promise
    .then((r) => {
      const errors = (r?.results || []).filter((x) => x?.status === 'error');
      if (errors.length > 0) {
        console.error(`❌ [SquareCodReconcile:${label}]`, errors.map((e) => `${e.deliveryId}: ${e.error}`).join('; '));
      } else {
        console.info(`✅ [SquareCodReconcile:${label}] ${(r?.results || []).length} reconciled`);
      }
    })
    .catch((e) => console.warn(`⚠️ [SquareCodReconcile:${label}] failed:`, e?.message || e));

// Reconcile ONE delivery. Fire-and-forget.
// patch: optional just-written cod fields (see PATCH_FIELDS) — e.g. from a form save
// whose DB write hasn't propagated yet.
export function syncDeliverySquareCod(deliveryId, patch) {
  if (!deliveryId) return;
  report('one', base44.functions.invoke('squareCodReconcile', {
    records: [{ deliveryId, patch: buildCodPatch(patch) }]
  }));
}

// Reconcile a batch of deliveries (e.g. Accept All). One backend call.
// Accepts [{ deliveryId, patch? }] or plain ids.
export function syncDeliveriesSquareCod(items) {
  const records = (items || [])
    .map((it) => (typeof it === 'string' ? { deliveryId: it } : it))
    .filter((it) => it?.deliveryId)
    .map((it) => ({ deliveryId: it.deliveryId, patch: buildCodPatch(it.patch) }));
  if (records.length === 0) return;
  report('batch', base44.functions.invoke('squareCodReconcile', { records }));
}

// Force-remove catalog items for deliveries that no longer exist in the DB
// (hard-deleted deliveries). The reconciler cannot read a deleted record, so this
// mode deletes by delivery id directly.
export function removeDeliverySquareCod(deliveryId, reason = 'delivery_deleted') {
  if (!deliveryId) return;
  report('remove', base44.functions.invoke('squareCodReconcile', {
    deletions: [{ deliveryId, reason }]
  }));
}
