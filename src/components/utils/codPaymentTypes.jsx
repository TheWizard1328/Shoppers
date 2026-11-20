/**
 * codPaymentTypes.jsx — ONE definition of the COD collection types.
 *
 * OWNER SPEC (Nov 20 2026): "For the COD collection type list let's add another
 * item for E-Transfer. E-Transfers will be treated like cash for all intents
 * and purposes throughout the app. So the order of collection types will go
 * cash, debit, credit, cheque, e-transfer, and archived will be changed to
 * archive."
 *
 * Rules encoded here:
 *   • Order: Cash → Debit → Credit → Cheque → E-Transfer → Archive.
 *   • The Archive option is a LABEL change only. Stored records keep the value
 *     'Archived' (the Square page, the badges and every filter already read it),
 *     so renaming the value would orphan existing data.
 *   • E-Transfer is CASH-LIKE: it waits for the drawer/deposit exactly like
 *     cash, it is never a card tender, and it never counts as collected on a
 *     card. Use isCashLikeType() anywhere the app singles out 'cash'.
 */

export const COD_TYPE_OPTIONS = [
  { value: 'Cash', label: 'Cash' },
  { value: 'Debit', label: 'Debit' },
  { value: 'Credit', label: 'Credit' },
  { value: 'Cheque', label: 'Cheque' },
  { value: 'E-Transfer', label: 'E-Transfer' },
  { value: 'Archived', label: 'Archive' },
];

/** Types the driver can pick for a live collection (no Archive write-off). */
export const COD_TYPE_OPTIONS_ACTIVE = COD_TYPE_OPTIONS.filter((o) => o.value !== 'Archived');

/** Cash and every spelling of e-transfer (legacy rows included). */
const CASH_LIKE = ['cash', 'e-transfer', 'etransfer', 'e_transfer', 'e transfer', 'interac e-transfer', 'interac etransfer'];

/** Money taken directly at the door — never awaits a deposit. */
const DIRECT = ['debit', 'credit', 'cheque', 'check', 'card', 'archived'];

/** Canonical lowercase type ('check' → 'cheque', all e-transfer spellings → 'e-transfer'). */
export function normalizeCodType(type) {
  const lower = String(type || '').trim().toLowerCase();
  if (!lower) return '';
  if (lower === 'check') return 'cheque';
  if (CASH_LIKE.includes(lower) && lower !== 'cash') return 'e-transfer';
  return lower;
}

/** True for Cash AND E-Transfer — the "awaits the drawer" money. */
export function isCashLikeType(type) {
  return CASH_LIKE.includes(normalizeCodType(type)) || CASH_LIKE.includes(String(type || '').trim().toLowerCase());
}

/** True for Debit / Credit / Cheque / card / archive. */
export function isDirectCodType(type) {
  return DIRECT.includes(normalizeCodType(type));
}

/** Display label for a stored type value. */
export function codTypeLabel(type) {
  const norm = normalizeCodType(type);
  if (norm === 'e-transfer') return 'E-Transfer';
  if (norm === 'archived') return 'Archive';
  if (norm === 'cheque') return 'Cheque';
  if (!norm) return '';
  return norm.charAt(0).toUpperCase() + norm.slice(1);
}
