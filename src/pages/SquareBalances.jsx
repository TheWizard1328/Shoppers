import React from "react";
import SquareBalancesView from "@/components/square/SquareBalancesView";
import { useUser } from "@/components/utils/UserContext";

/**
 * Square Balances page — App Owner only (sidebar link lives in the
 * Patients / Stores / Drivers group; AppSidebar gates it with isAppOwner).
 *
 * Wrapper only: all logic lives in SquareBalancesView (see header comment there).
 * Page body follows the h-full flex column + overflow-y-auto pattern required
 * by Layout's overflow-hidden <main>.
 */
export default function SquareBalances() {
  const { currentUser } = useUser();
  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 overflow-y-auto p-6 max-w-5xl mx-auto w-full">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100">Square Balances</h1>
            <p className="text-slate-500 dark:text-slate-400 mt-1">Card, loan and folder estimates — true-up from real Square numbers</p>
          </div>
        </div>
        <SquareBalancesView currentUser={currentUser} />
      </div>
    </div>
  );
}
