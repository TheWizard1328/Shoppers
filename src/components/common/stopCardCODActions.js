/**
 * stopCardCODActions — extracted from useStopCardActions.jsx (Sep 6 2026).
 * Pure code movement, zero behavior change. COD payment actions.
 */
import { useCallback } from "react";

export function useStopCardCODActions({
  codTotalRequired,
  codTotalCollected,
  setCodPayments,
}) {
  const handleAddCODPayment = useCallback(() => {
    const remainingAmount = codTotalRequired - codTotalCollected;
    const newPayment = { type: 'Cash', amount: Math.max(0, remainingAmount) };
    setCodPayments((prev) => [...prev, newPayment]);
  }, [codTotalCollected, codTotalRequired, setCodPayments]);

  return { handleAddCODPayment };
}
