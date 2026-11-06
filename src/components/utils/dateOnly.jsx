/**
 * Date-only helpers for rate-history / fee-history effective dates.
 *
 * OWNER BUG REPORT Nov 6 2026: "on Sharuk's pay rate history the most current
 * item says October 31st 2026 but the payroll uses November 1st instead of
 * October 31st — it is using it as the FINAL date, not the FIRST date."
 *
 * Root cause: `effective_date` is a CALENDAR DATE (a date input value), but
 * consumers compared it against a bare 'YYYY-MM-DD' string. When the stored
 * value carried a time tail ('2026-10-31T00:00:00.000Z') the comparison
 * '2026-10-31T00:00:00.000Z' <= '2026-10-31' is FALSE (longer string, same
 * prefix), so the new rate silently skipped its own effective date and only
 * took hold the NEXT day. Parsing with `new Date('2026-10-31')` had the
 * mirror-image problem: it lands at 00:00 UTC = the previous evening in
 * Edmonton, so the rate could also start a day early.
 *
 * RULE (owner): the date stored on a rate-history entry is the FIRST day the
 * change applies, inclusive. Every comparison must therefore be done on
 * normalized calendar-date strings in LOCAL time.
 */

/** Normalize anything date-like to a local 'YYYY-MM-DD' string. */
export const toDateOnlyStr = (value) => {
  if (value === null || value === undefined || value === '') return '';
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '';
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const raw = String(value).trim();
  // Already a bare calendar date — keep it verbatim (never shift it).
  const bare = raw.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(bare)) return bare;
  // Anything else (e.g. 'Oct 31 2026') falls back to a Date parse.
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? '' : toDateOnlyStr(parsed);
};

/** Parse a calendar date to a local Date at 00:00 (never UTC midnight). */
export const parseDateOnlyLocal = (value) => {
  const iso = toDateOnlyStr(value);
  if (!iso) return null;
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
};

/**
 * True when `entry.effective_date` applies on `date` (INCLUSIVE of the
 * effective day itself).
 */
export const isEffectiveOn = (entry, date) => {
  const entryStr = toDateOnlyStr(entry?.effective_date);
  const dateStr = toDateOnlyStr(date);
  if (!entryStr || !dateStr) return false;
  return entryStr <= dateStr;
};
