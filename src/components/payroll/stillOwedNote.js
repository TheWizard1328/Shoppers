// ─── "Still Owed" payroll note (owner feature, Oct 21 2026) ───────────────────
// When a paid amount is entered into a driver's Paid textbox, the driver's
// payroll notes (driver_notes) get a "Still Owed: $X" line as their FIRST line,
// where X = net amount − paid amount. If the phrase is already present anywhere
// in the notes its value is updated in place. When the paid amount matches the
// net amount (nothing still owed, including overpayment), the line is removed.
//
// PURE functions — both the desktop save path (PayrollSummaryCard
// savePayrollChanges) and the mobile card (PayrollMobileCard local note sync)
// call the SAME helpers so the server record and the local textarea never
// drift apart.

const STILL_OWED_LINE_RX = /^Still Owed:?\s*\$?-?[\d,]+(\.\d+)?\s*$/i;
export const STILL_OWED_MATCH_RX = STILL_OWED_LINE_RX;

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
  const idx = lines.findIndex((line) => STILL_OWED_LINE_RX.test(line.trim()));

  // Paid matches (or exceeds) the net → nothing still owed → erase the line.
  if (owed <= 0.005) {
    if (idx >= 0) {
      lines.splice(idx, 1);
      return { notes: lines.join('\n'), changed: true };
    }
    return { notes: current, changed: false };
  }

  const owedLine = `Still Owed: $${owed.toFixed(2)}`;
  if (idx >= 0) {
    if (lines[idx].trim() === owedLine) return { notes: current, changed: false };
    lines[idx] = owedLine; // update value in place, keep its position
  } else {
    lines.unshift(owedLine); // first line of the notes
  }
  return { notes: lines.join('\n'), changed: true };
};
