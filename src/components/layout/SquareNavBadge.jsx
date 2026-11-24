import React from 'react';
import { isAppOwner } from '@/components/utils/userRoles';
import { useSquareBalancesSummary } from '@/components/square/useSquareBalancesSummary';

/**
 * SquareNavBadge — the money badge under the mobile nav's dollar-bill icon.
 *
 * CODE SCAN (Nov 24 2026, finding #2): MobileBottomNav imported
 * useSquareBalancesSummary STATICALLY at line 23 and then dynamically imported
 * the same module at line 66 for two helpers, so the split never happened and
 * every driver downloaded the full 158KB Square balances + IndexedDB layer on
 * app open. The badge computation now lives here, in its own chunk that
 * MobileBottomNav pulls with React.lazy: the nav paints immediately and the
 * money module streams in right after.
 *
 * It renders nothing; it reports the formatted amount up through onAmount.
 */
export default function SquareNavBadge({
  currentUser,
  isAdminNav,
  isDriverNav,
  isDispatcherNav,
  driverNavStoreIds,
  onAmount
}) {
  const { ready, byLocId, storeToLoc } = useSquareBalancesSummary(
    !!currentUser,
    currentUser?.id || null,
    isAppOwner(currentUser)
  );

  const amount = React.useMemo(() => {
    if (!ready || !byLocId || byLocId.size === 0) return null;
    let total = 0;
    if (isAdminNav || (!isDriverNav && !isDispatcherNav)) {
      for (const row of byLocId.values()) total += Number(row?.cardEstimate || 0);
    } else {
      // Still resolving the driver's route scope — stay blank rather than
      // flashing "N/A" before the IDB resolve finishes.
      if (isDriverNav && driverNavStoreIds === null) return null;
      const storeIds = driverNavStoreIds ?? (currentUser?.store_ids || []).map(String).filter(Boolean);
      const locIds = [...new Set(storeIds.map((sid) => storeToLoc?.get(String(sid))).filter(Boolean))];
      // Loaded, but nothing in scope for the selected date -> explicit "N/A"
      // (never a false $0.00 and never an endless blank).
      if (locIds.length === 0) return 'N/A';
      for (const lid of locIds) {
        const row = byLocId.get(lid);
        if (row) total += Number(row.cardEstimate || 0);
      }
    }
    if (!Number.isFinite(total)) return null;
    return total >= 1000 ? `$${(total / 1000).toFixed(1)}k` : `$${total.toFixed(2)}`;
  }, [ready, byLocId, storeToLoc, isAdminNav, isDriverNav, isDispatcherNav, currentUser, driverNavStoreIds]);

  React.useEffect(() => {
    onAmount?.(amount);
  }, [amount, onAmount]);

  return null;
}
