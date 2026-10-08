import React, { useEffect, useState } from "react";
import SquareBalancesView from "@/components/square/SquareBalancesView";
import { useUser } from "@/components/utils/UserContext";
import { userHasRole, isAppOwner } from "@/components/utils/userRoles";
import { base44 } from "@/api/base44Client";
import { buildStoreToLocMap } from "@/components/square/useSquareBalancesSummary";
import { edmontonWallString } from "@/components/utils/albertaTime";

/**
 * Square Balances page.
 *
 * Access: admins and the App Owner see every card. Drivers see only the cards
 * assigned to the stores on their route for the current date (fallback: their
 * assigned stores). Dispatchers never reach this page from the sidebar — their
 * badge is read-only — but a direct URL shows the card(s) for their store(s).
 */
export default function SquareBalances() {
  const { currentUser } = useUser();
  // null = all cards, array = subset, undefined = still resolving
  const [visibleLocationIds, setVisibleLocationIds] = useState(undefined);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!currentUser) return;
      const isAdmin = userHasRole(currentUser, "admin") || isAppOwner(currentUser);
      if (isAdmin) {
        if (!cancelled) setVisibleLocationIds(null);
        return;
      }
      // Driver (or dispatcher via direct URL): cards for their stores.
      const today = edmontonWallString(new Date()).slice(0, 10);
      let storeIds = [];
      if (userHasRole(currentUser, "driver")) {
        const rows = await base44.entities.Delivery.filter({
          driver_id: currentUser.id,
          delivery_date: today
        }).catch(() => []);
        storeIds = [...new Set(
          (rows || []).
          filter((d) => d?.status !== "cancelled" && d?.store_id).
          map((d) => String(d.store_id))
        )];
      }
      if (!storeIds.length) {
        storeIds = (currentUser?.store_ids || []).map(String).filter(Boolean);
      }
      const storeToLoc = await buildStoreToLocMap().catch(() => new Map());
      const locIds = [...new Set(
        storeIds.map((sid) => storeToLoc.get(String(sid))).filter(Boolean)
      )];
      if (!cancelled) setVisibleLocationIds(locIds);
    })();
    return () => {cancelled = true;};
  }, [currentUser]);

  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 overflow-y-auto mx-auto w-full max-w-6xl px-4 py-4">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100">Square Balances</h1>
            {currentUser && isAppOwner(currentUser) &&
            <p className="text-slate-500 dark:text-slate-400 mt-1">Card, loan and folder estimates — true-up from real Square numbers</p>
            }
          </div>
        </div>
        {visibleLocationIds === undefined ?
          <div className="text-sm text-slate-500 dark:text-slate-400 p-4">Loading balances…</div> :
          <SquareBalancesView currentUser={currentUser} visibleLocationIds={visibleLocationIds} />}
      </div>
    </div>);

}