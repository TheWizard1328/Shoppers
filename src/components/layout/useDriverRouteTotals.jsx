import { useEffect, useState, useCallback } from 'react';
import { globalFilters } from '@/components/utils/globalFilters';
import { userHasRole } from '@/components/utils/userRoles';
import { offlineDB } from '@/components/utils/offlineDatabase';

/**
 * Yearly Routes badge source (owner spec Oct 26 2026, v2):
 * "Piggy back on the Quick stats for the full year count — total number of
 * days with at least 1 stop."
 *
 * v1 pulled per-driver routesWorked from the server-cached getDriverOverviewStats,
 * which returned 0 across the board; the owner redirected to the Quick-stats
 * mechanism instead: DashboardQuickStats reads month slices from IDB via the
 * indexed delivery_date range read (offlineDB.getDeliveriesByDateRange). This
 * hook uses the SAME indexed range read, widened to the whole year — one read
 * per TTL window, never the entire IDB.
 *
 * Badge semantics (owner):
 *   driver      → number of dates THEY had >=1 stop assigned (year)
 *   dispatcher  → dates with >=1 stop assigned to ANY driver in their stores (year)
 *   admin       → selected driver's date count; 'all' → all dates with >=1 stop (year)
 */
const YEAR_SLICE_TTL_MS = 10 * 60 * 1000;

// Module-scope year-slice cache (mirrors DashboardQuickStats' month-slice cache):
// { yearStr, rows, at } — the IDB range read is the expensive part; scope filtering
// (driver/store) runs in-memory from the cached rows on every selection change.
let _yearSliceCache = null;

const getYearDeliverySlice = async (yearStr) => {
  const now = Date.now();
  if (_yearSliceCache && _yearSliceCache.yearStr === yearStr && (now - _yearSliceCache.at) < YEAR_SLICE_TTL_MS) {
    return _yearSliceCache.rows;
  }
  const rows = await offlineDB
    .getDeliveriesByDateRange(`${yearStr}-01-01`, `${yearStr}-12-31`)
    .catch(() => []);
  _yearSliceCache = { yearStr, rows: rows || [], at: now };
  return _yearSliceCache.rows;
};

export function useDriverRouteTotals(currentUser) {
  const [routesByDriver, setRoutesByDriver] = useState(null); // driverId → date count
  const [totalRoutes, setTotalRoutes] = useState(0);          // union of dates in scope
  const [selectedDriverId, setSelectedDriverId] = useState('all');

  const compute = useCallback(async () => {
    if (!currentUser) return;
    try {
      const selectedDate = String(globalFilters.getSelectedDate() || '');
      const parsedYear = parseInt(selectedDate.slice(0, 4), 10);
      const yearStr = Number.isFinite(parsedYear) ? String(parsedYear) : String(new Date().getFullYear());

      const rows = await getYearDeliverySlice(yearStr);

      // Dispatcher scope: only their stores count (any driver's stops).
      const isDispatcherOnly = userHasRole(currentUser, 'dispatcher') && !userHasRole(currentUser, 'admin');
      const storeScope = isDispatcherOnly ? new Set(currentUser.store_ids || []) : null;

      const datesByDriver = new Map(); // driverId → Set(delivery_date)
      const allDates = new Set();      // union of dates with >=1 stop in scope
      rows.forEach((d) => {
        if (!d || !d.delivery_date) return;
        if (storeScope && !storeScope.has(d.store_id)) return;
        allDates.add(d.delivery_date);
        if (d.driver_id) {
          let set = datesByDriver.get(d.driver_id);
          if (!set) { set = new Set(); datesByDriver.set(d.driver_id, set); }
          set.add(d.delivery_date);
        }
      });

      const by = {};
      datesByDriver.forEach((set, driverId) => { by[driverId] = set.size; });

      setRoutesByDriver(by);
      setTotalRoutes(allDates.size);
      setSelectedDriverId(globalFilters.getSelectedDriverId() || 'all');
    } catch {
      /* keep last good values — Layout falls back to the legacy local count */
    }
  }, [currentUser]);

  useEffect(() => {
    if (!currentUser) return;
    void compute();
    // Driver/date switches recompute instantly from the cached year slice.
    const onFiltersChanged = () => void compute();
    const iv = setInterval(compute, YEAR_SLICE_TTL_MS);
    window.addEventListener('globalFiltersChanged', onFiltersChanged);
    return () => {
      clearInterval(iv);
      window.removeEventListener('globalFiltersChanged', onFiltersChanged);
    };
  }, [currentUser, compute]);

  return { routesByDriver, totalRoutes, selectedDriverId };
}
