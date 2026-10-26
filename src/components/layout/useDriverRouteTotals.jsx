import { useEffect, useState, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import { globalFilters } from '@/components/utils/globalFilters';
import { userHasRole } from '@/components/utils/userRoles';

/**
 * Yearly routes badge source (owner spec Oct 26 2026):
 * "Routes total badge ... should be showing a total number of routes for the
 * selected driver for the year ... We need to be able to get the yearly total
 * without always reading the entire IDB."
 *
 * The badge previously recomputed from the Layout `deliveries` array, which
 * only holds the SELECTED DATE slice since the IDB-first boot optimization —
 * so the badge silently degraded to a single-day count. This hook pulls the
 * year aggregate from the getDriverOverviewStats backend function instead,
 * which is server-side cached (1h current year / 24h historical years) and
 * shared with the Driver Overview page — no client-side full-IDB read, no
 * heavy compute on render.
 *
 * Returns:
 *   routesByDriver  — { driverId: routesWorked } for the scope (null until loaded)
 *   totalRoutes     — sum of routesWorked across drivers in the scope
 *   selectedDriverId— echo of globalFilters (re-renders consumers on change)
 *   refresh         — manual re-pull (cached server-side; cheap)
 */
const POLL_MS = 15 * 60 * 1000; // silent re-pull cadence while the layout is open

export function useDriverRouteTotals(currentUser) {
  const [routesByDriver, setRoutesByDriver] = useState(null);
  const [totalRoutes, setTotalRoutes] = useState(0);
  const [selectedDriverId, setSelectedDriverId] = useState('all');

  // Echo the filter selection so consumers re-render when the admin switches
  // drivers — even if the fetched totals themselves did not change.
  const syncSelection = useCallback(() => {
    const did = globalFilters.getSelectedDriverId();
    setSelectedDriverId(did || 'all');
    return did || 'all';
  }, []);

  useEffect(() => {
    if (!currentUser) return;
    let cancelled = false;
    let inFlight = false;
    const cache = { year: null, stats: null, total: 0 };

    const resolveYear = () => {
      const d = String(globalFilters.getSelectedDate() || '');
      const y = parseInt(d.slice(0, 4), 10);
      return Number.isFinite(y) ? y : new Date().getFullYear();
    };

    const fetchTotals = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const year = resolveYear();
        const isDispatcherOnly = userHasRole(currentUser, 'dispatcher') && !userHasRole(currentUser, 'admin');
        const storeIds = isDispatcherOnly ? (currentUser.store_ids || []) : undefined;

        const res = await base44.functions.invoke('getDriverOverviewStats', {
          year: String(year),
          storeIds,
          forceRefresh: false // NEVER force from the badge — the shared cache keeps this to one entity read
        });
        if (cancelled || !res || res.error) return;

        const stats = Array.isArray(res.driverStats) ? res.driverStats : [];
        const by = {};
        let sum = 0;
        stats.forEach((ds) => {
          if (!ds?.driverId) return;
          by[ds.driverId] = Number(ds.routesWorked) || 0;
          sum += Number(ds.routesWorked) || 0;
        });
        cache.year = year;
        cache.stats = by;
        cache.total = sum;
        setRoutesByDriver(by);
        setTotalRoutes(sum);
      } catch {
        /* keep last good values — badge falls back to the legacy local count */
      } finally {
        inFlight = false;
      }
    };

    const onFiltersChanged = () => { syncSelection(); void fetchTotals(); };

    syncSelection();
    void fetchTotals();
    const iv = setInterval(fetchTotals, POLL_MS);
    window.addEventListener('globalFiltersChanged', onFiltersChanged);
    return () => {
      cancelled = true;
      clearInterval(iv);
      window.removeEventListener('globalFiltersChanged', onFiltersChanged);
    };
  }, [currentUser, syncSelection]);

  return { routesByDriver, totalRoutes, selectedDriverId };
}
