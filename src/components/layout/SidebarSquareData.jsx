import React from 'react';
import { isAppOwner } from '@/components/utils/userRoles';
import { edmontonWallString } from '@/components/utils/albertaTime';
import {
  useSquareBalancesSummary,
  getBalanceLevel,
  resolveDriverBadgeStoreIds
} from '@/components/square/useSquareBalancesSummary';

/**
 * SidebarSquareData — headless Square-balances loader for AppSidebar.
 *
 * CODE SCAN (Nov 24 2026, finding #2 follow-up): AppSidebar imported
 * useSquareBalancesSummary statically, so the 158KB balances + IndexedDB module sat in the
 * boot bundle even though the sidebar only needs a badge number, a hover balloon and the
 * Maps handed to two dialogs. That work now lives here, in a chunk AppSidebar pulls with
 * React.lazy, and reports its result up through onData.
 *
 * It renders nothing.
 */
export default function SidebarSquareData({
  currentUser,
  deliveries,
  selectedDate,
  isAdmin,
  isDriver,
  isDispatcher,
  onData
}) {
  const { ready, byLocId, storeToLoc, weeklyByStore, storeNames, dailyRemainingByStore } =
    useSquareBalancesSummary(!!currentUser, currentUser?.id || null, isAppOwner(currentUser));

  // Owner spec (Nov 11 2026): the badge scope follows the SELECTED date in the global
  // filters (never the current date). Falls back to today only when no date is set at all.
  const sqSelectedDate = String(selectedDate || '').slice(0, 10) ||
    edmontonWallString(new Date()).slice(0, 10);

  // Driver badge scope resolved against the SELECTED date (gates: default assigned
  // stores -> scheduled stores -> that date's stops -> N/A).
  const [driverScope, setDriverScope] = React.useState(null);
  React.useEffect(() => {
    if (!isDriver || !currentUser?.id) { setDriverScope(null); return; }
    let alive = true;
    resolveDriverBadgeStoreIds({
      driverId: currentUser?.id,
      dateStr: sqSelectedDate,
      defaultStoreIds: currentUser?.store_ids,
      deliveries
    })
      .then((res) => { if (alive) setDriverScope(res); })
      .catch(() => { if (alive) setDriverScope({ storeIds: [], source: 'error' }); });
    return () => { alive = false; };
  }, [isDriver, currentUser?.id, sqSelectedDate, deliveries]);

  const badge = React.useMemo(() => {
    if (!ready || !byLocId || byLocId.size === 0) return null;
    let storeIds = null;
    if (isDriver || isDispatcher) {
      // The driver's own stores come first (fixed assignments); a route with no
      // assigned stores falls back to today's route stores.
      storeIds = (currentUser?.store_ids || []).map(String).filter(Boolean);
      if (isDriver) {
        // Gates (owner spec Nov 11 2026, selected date only): default assigned
        // stores -> stores scheduled that date -> stores on that date's stops
        // -> empty scope ("N/A"). Stat holidays skip the schedule gates.
        storeIds = driverScope?.storeIds || [];
      }
    }
    let total = 0, avg = 0, found = false;
    if (isAdmin) {
      // Admin: all cards combined against the combined 7-day COD average.
      for (const row of byLocId.values()) {
        total += Number(row?.cardEstimate || 0);
        avg += Number(row?.codAvg || 0);
      }
      found = byLocId.size > 0;
    } else if (storeIds && storeIds.length && storeToLoc) {
      // Driver/dispatcher: cards for their stores, but the COD average is built
      // from THEIR stores' deliveries only (7 days, excluding today).
      const locIds = [...new Set(storeIds.map((sid) => storeToLoc.get(String(sid))).filter(Boolean))];
      for (const lid of locIds) {
        const row = byLocId.get(lid);
        if (row) { total += Number(row.cardEstimate || 0); found = true; }
      }
      for (const sid of storeIds) avg += Number(weeklyByStore?.get(String(sid)) || 0) / 7;
    }
    if (!found) return null;
    // Dispatcher balloon: today's remaining CODs (count + total) across their stores
    let remaining = null;
    if (isDispatcher && storeIds && storeIds.length) {
      let c = 0, t = 0;
      for (const sid of storeIds) {
        const r = dailyRemainingByStore?.get(String(sid));
        if (r) { c += Number(r.count || 0); t += Number(r.total || 0); }
      }
      remaining = { count: c, total: t };
    }
    // Hover-balloon lines: one per store (the user's stores), showing the balance of
    // that store's card, colored by the card's level.
    const balloonStoreIds = isAdmin ? [...storeToLoc.keys()] : storeIds || [];
    const lines = balloonStoreIds
      .map((sid) => {
        const lid = storeToLoc.get(String(sid));
        const row = lid ? byLocId.get(lid) : null;
        if (!row) return null;
        return {
          storeId: String(sid),
          name: storeNames?.get(String(sid)) || String(sid),
          balance: row.cardEstimate,
          level: row.level
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name));
    return { total, avg, level: getBalanceLevel(total, avg), lines, remaining };
  }, [ready, byLocId, storeToLoc, weeklyByStore, storeNames, dailyRemainingByStore, isAdmin, isDriver, isDispatcher, currentUser, driverScope]);

  // "N/A" = loaded but nothing in scope for the selected date. "..." is reserved
  // for the brief load window, so a driver with no stops that day never sits on
  // an endless ellipsis (owner report Nov 11 2026).
  const scopeEmpty = React.useMemo(() => {
    if (isAdmin) return false;
    if (isDriver) return !!driverScope && (driverScope.storeIds || []).length === 0;
    const assigned = (currentUser?.store_ids || []).map(String).filter(Boolean);
    return assigned.length === 0; // dispatcher with no store assigned
  }, [isAdmin, isDriver, driverScope, currentUser]);

  React.useEffect(() => {
    onData?.({ ready, byLocId, storeToLoc, badge, scopeEmpty });
  }, [ready, byLocId, storeToLoc, badge, scopeEmpty, onData]);

  return null;
}
