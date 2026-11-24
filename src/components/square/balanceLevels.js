// Tiny, dependency-free balance colour scale.
//
// CODE SCAN (Nov 24 2026, finding #2 follow-up): BALANCE_LEVELS / getBalanceLevel used to
// live inside useSquareBalancesSummary.js (158KB of balances + IndexedDB code). Anything
// that only needed a chip colour - AppSidebar's legend dots, SquareLowBalanceAlert - pulled
// the whole module into the boot bundle. They live here now and the big module re-exports
// them, so existing importers keep working while light importers stay light.
export const BALANCE_BAND = 20;

// Color level: green when the balance is more than $20 ABOVE the 7-day average
// daily CODs to collect, red when more than $20 BELOW, yellow inside the +/-$20 band.
export function getBalanceLevel(balance, codAvg) {
  const diff = (Number(balance) || 0) - (Number(codAvg) || 0);
  if (diff > BALANCE_BAND) return 'green';
  if (diff >= -BALANCE_BAND) return 'yellow';
  return 'red';
}

// OWNER FIX (Nov 24 2026): the Square balance summary died completely whenever this
// binding was missing from the executing bundle (the w332 Rollup free-variable trap:
// 'getBalanceLevel is not defined', 174 errors in one hour, no balances on screen).
// A stale client is always possible, so the chip computation must never be able to
// throw: worst case the level falls back to yellow and the page still renders.
export function safeBalanceLevel(balance, codAvg) {
  try {
    const level = getBalanceLevel(balance, codAvg);
    return BALANCE_LEVELS[level] ? level : 'yellow';
  } catch (_) {
    return 'yellow';
  }
}

export const BALANCE_LEVELS = {
  green: { border: '#10b981', tint: 'rgba(16, 185, 129, 0.07)', chipBg: '#d1fae5', chipText: '#065f46' },
  yellow: { border: '#f59e0b', tint: 'rgba(245, 158, 11, 0.08)', chipBg: '#fef3c7', chipText: '#92400e' },
  red: { border: '#ef4444', tint: 'rgba(239, 68, 68, 0.07)', chipBg: '#fee2e2', chipText: '#991b1b' },
};
