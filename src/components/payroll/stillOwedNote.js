// ─── "Still Owed" payroll note (owner feature, Oct 21 2026) ───────────────────
// When a paid amount is entered into a driver's Paid textbox, the driver's
// payroll notes (driver_notes) get a "Still Owed: $X" line as their FIRST line,
// where X = net amount − paid amount. If the phrase is already present anywhere
// in the notes its value is updated in place. When the paid amount is MORE than
// the net, the line reads "Over Paid: $X" instead (owner request Nov 27 2026:
// "the Still Owed update still needs to be updated for over paid amounts too").
// Only an exact match (nothing owed either way) removes the line.
//
// PURE functions — both the desktop save path (PayrollSummaryCard
// savePayrollChanges) and the mobile card (PayrollMobileCard local note sync)
// call the SAME helpers so the server record and the local textarea never
// drift apart.

const STILL_OWED_LINE_RX = /^Still Owed:?\s*\$?-?[\d,]+(\.\d+)?\s*$/i;
const OVER_PAID_LINE_RX = /^Over Paid:?\s*\$?-?[\d,]+(\.\d+)?\s*$/i;
// Either line occupies the same slot (the first line of the notes).
const OWED_OR_OVER_LINE_RX = /^(?:Still Owed|Over Paid):?\s*\$?-?[\d,]+(\.\d+)?\s*$/i;
export const STILL_OWED_MATCH_RX = STILL_OWED_LINE_RX;
export const OVER_PAID_MATCH_RX = OVER_PAID_LINE_RX;

/**
 * @param {string} notes      current driver_notes (may be '' / null)
 * @param {number} netAmount  period net pay for the driver
 * @param {number} paidAmount paid amount entered
 * @returns {{ notes: string, changed: boolean }} new notes value + whether
 *   anything actually changed (avoids redundant Payroll writes).
 */
export const applyStillOwedToNotes = (notes, netAmount, paidAmount) => {
  const net = Number(netAmount) || 0;
  const paid = Number(paidAmount) || 0;
  const owed = Math.round((net - paid) * 100) / 100;

  const current = String(notes || '');
  const lines = current.length ? current.split('\n') : [];
  const idx = lines.findIndex((line) => OWED_OR_OVER_LINE_RX.test(line.trim()));

  // Paid matches the net exactly → nothing owed either way → erase the line.
  if (Math.abs(owed) <= 0.005) {
    if (idx >= 0) {
      lines.splice(idx, 1);
      return { notes: lines.join('\n'), changed: true };
    }
    return { notes: current, changed: false };
  }

  // Paid MORE than the net → the driver is ahead: "Over Paid: $X".
  const owedLine = owed > 0
    ? `Still Owed: $${owed.toFixed(2)}`
    : `Over Paid: $${Math.abs(owed).toFixed(2)}`;
  if (idx >= 0) {
    if (lines[idx].trim() === owedLine) return { notes: current, changed: false };
    lines[idx] = owedLine; // update value in place, keep its position
  } else {
    lines.unshift(owedLine); // first line of the notes
  }
  return { notes: lines.join('\n'), changed: true };
};
