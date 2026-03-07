import { useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { format } from 'date-fns';
import { globalFilters } from '@/components/utils/globalFilters';

/**
 * Bridge component: listens for refreshDeliveryStats events, calls getDeliveryStats,
 * and dispatches both deliveryStatsUpdated AND performanceStatsUpdated with the result.
 * 
 * This avoids the rate-limited getDriverPayrollStats endpoint by re-using the
 * performanceStats already computed inside getDeliveryStats.
 */
export default function PerformanceStatsBridge({ currentUser, selectedDriverId }) {
  useEffect(() => {
    if (!currentUser) return;

    let inFlight = false;
    let lastFetchKey = '';

    const fetchStats = async () => {
      if (inFlight) return;

      const selectedDate = globalFilters.getSelectedDate();
      const driverId = selectedDriverId || globalFilters.getSelectedDriverId();
      const fetchKey = `${selectedDate}|${driverId}`;
      if (fetchKey === lastFetchKey) return;

      inFlight = true;
      lastFetchKey = fetchKey;

      try {
        const response = await base44.functions.invoke('getDeliveryStats', {
          selectedDate,
          driverId: driverId === 'all' ? undefined : driverId,
        });

        const data = response?.data || response;
        if (!data) return;

        // Dispatch deliveryStatsUpdated (consumed by Dashboard)
        window.dispatchEvent(new CustomEvent('deliveryStatsUpdated', { detail: data }));

        // CRITICAL: Also dispatch performanceStatsUpdated so Dashboard sets performanceStats
        if (data.performanceStats) {
          window.dispatchEvent(new CustomEvent('performanceStatsUpdated', { detail: data.performanceStats }));
        }
      } catch (_e) {
        // Silently ignore errors (rate limits, auth, etc.)
      } finally {
        inFlight = false;
      }
    };

    // Listen for the refresh trigger
    window.addEventListener('refreshDeliveryStats', fetchStats);

    // Initial fetch on mount
    fetchStats();

    return () => {
      window.removeEventListener('refreshDeliveryStats', fetchStats);
    };
  }, [currentUser?.id, selectedDriverId]);

  return null;
}