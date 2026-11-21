// ── One money formatter for the whole app ────────────────────────────────────
// SCAN ITEM 4 (Nov 21 2026): the payroll screens disagreed about currency.
// PayrollSummaryCard formatted en-US/USD, MobilePayrollSummary used CAD, and
// formatCurrency was hand-written in four places (PayrollSummaryCard,
// MobilePayrollSummary, StoreMetricsPanel, AdminMetrics), so a driver saw a
// different currency depending on which screen they opened. RxDeliver is a
// Canadian pharmacy app: every amount is CAD. Import from here, never inline
// another Intl.NumberFormat currency call.

export const APP_CURRENCY = 'CAD';
const APP_LOCALE = 'en-CA';

/**
 * "$1,234.56" (CAD). Pass decimals = 0 for whole-dollar summaries.
 * Null/undefined/NaN render as "$0.00" so a missing figure never blanks a card.
 */
export function formatCurrency(amount, decimals = 2) {
  const value = Number(amount);
  return new Intl.NumberFormat(APP_LOCALE, {
    style: 'currency',
    currency: APP_CURRENCY,
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(Number.isFinite(value) ? value : 0);
}

/** Plain grouped number, no symbol: "1,234.56" — for input fields and tables. */
export function formatPayrollAmount(amount) {
  const value = Number(amount);
  return new Intl.NumberFormat(APP_LOCALE, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(value) ? value : 0);
}
