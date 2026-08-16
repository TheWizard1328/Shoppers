/**
 * Deduction date-range helpers.
 *
 * A deduction is considered "active" for a given date when:
 *   - start_date is empty OR the date is on or after start_date
 *   - end_date is empty OR the date is on or before end_date
 *
 * Payroll uses the pay period's START date as the reference date when
 * deciding whether to apply a deduction to that period.
 */

const normalizeDate = (value) => {
  if (!value) return '';
  const str = String(value);
  // Accept both ISO date (yyyy-MM-dd) and full ISO datetime; slice to date.
  return str.length >= 10 ? str.slice(0, 10) : '';
};

export const isDeductionActiveOn = (deduction, referenceDateStr = null) => {
  if (!deduction) return false;
  const ref = normalizeDate(referenceDateStr) || new Date().toISOString().slice(0, 10);
  const start = normalizeDate(deduction.start_date);
  const end = normalizeDate(deduction.end_date);
  if (start && ref < start) return false;
  if (end && ref > end) return false;
  return true;
};

export const getActiveDeductions = (deductions, referenceDateStr = null) => {
  if (!Array.isArray(deductions)) return [];
  return deductions.filter((d) => isDeductionActiveOn(d, referenceDateStr));
};

/**
 * Get deductions that are active at ANY point during a pay period (date-range
 * OVERLAP with [periodStartStr, periodEndStr], inclusive).
 *
 * A deduction "applies to this pay period" when its active range overlaps the
 * period — not when it happens to be active on the period's FIRST day. The
 * previous behavior (reference = period.start) silently excluded one-time
 * deductions whose start_date fell mid-period (e.g. a Aug 15 one-time deduction
 * was filtered out of the Aug 1–31 monthly pay period because "Aug 1 < Aug 15").
 *
 * Empty deduction bounds = open-ended (always passes that side).
 */
export const getActiveDeductionsForPeriod = (deductions, periodStartStr, periodEndStr) => {
  if (!Array.isArray(deductions)) return [];
  const periodStart = normalizeDate(periodStartStr);
  const periodEnd = normalizeDate(periodEndStr);
  return deductions.filter((d) => {
    if (!d) return false;
    const dStart = normalizeDate(d.start_date);
    const dEnd = normalizeDate(d.end_date);
    // Deduction starts AFTER period ends → no overlap
    if (dStart && periodEnd && dStart > periodEnd) return false;
    // Deduction ends BEFORE period starts → no overlap
    if (dEnd && periodStart && dEnd < periodStart) return false;
    return true;
  });
};

export const getTodayDateStr = () => new Date().toISOString().slice(0, 10);

const formatCompactDate = (dateStr) => {
  if (!dateStr) return '';
  const normalized = normalizeDate(dateStr);
  if (!normalized) return '';
  const d = new Date(normalized + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return normalized;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};

/**
 * Human-readable label for a deduction's active date range.
 * Examples: "Jan 1, 2026 → ongoing", "— → Dec 31, 2026", "Jan 1 → Dec 31, 2026".
 */
export const formatDeductionDateRange = (deduction) => {
  if (!deduction) return '';
  const start = normalizeDate(deduction.start_date);
  const end = normalizeDate(deduction.end_date);
  if (!start && !end) return '';
  const startLabel = start ? formatCompactDate(start) : '—';
  const endLabel = end ? formatCompactDate(end) : 'ongoing';
  return `${startLabel} → ${endLabel}`;
};

export { normalizeDate };