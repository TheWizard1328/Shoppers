import { useCallback, useRef } from 'react';
import { base44 } from '@/api/base44Client';
import { format } from 'date-fns';

// Lightweight throttled/debounced payroll stats fetcher
// Usage:
// const { schedulePayrollFetch } = usePayrollStats({ isDriver, isAdmin, currentUser, selectedDriverId, selectedDate, setPerformanceStats, setIsLoadingPayrollStats });
// useEffect(() => { schedulePayrollFetch('mount'); }, [schedulePayrollFetch]);
export default function usePayrollStats({
  isDriver,
  isAdmin,
  currentUser,
  selectedDriverId,
  selectedDate,
  setPerformanceStats,
  setIsLoadingPayrollStats,
}) {
  const timerRef = useRef(null);
  const lastFetchAtRef = useRef(0);
  const inFlightRef = useRef(false);
  const MIN_INTERVAL = 10000; // 10s throttle

  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const fetchNow = useCallback(async () => {
    const shouldFetch = (isDriver && selectedDriverId === currentUser?.id) || (isAdmin && selectedDriverId && selectedDriverId !== 'all');
    if (!shouldFetch) {
      setPerformanceStats(null);
      setIsLoadingPayrollStats(false);
      return;
    }

    const targetDriverId = isAdmin ? selectedDriverId : currentUser.id;
    setIsLoadingPayrollStats(true);
    inFlightRef.current = true;
    try {
      const response = await base44.functions.invoke('getDriverPayrollStats', {
        driverId: targetDriverId,
        deliveryDate: format(selectedDate, 'yyyy-MM-dd')
      });
      const data = response?.data || response;
      if (data?.success) {
        setPerformanceStats({
          totalPay: data.totalPay || 0,
          totalKm: data.totalKm || 0,
          totalExtraKm: data.totalExtraKm || 0,
          totalTimeOnDuty: data.totalTimeOnDuty || '00:00',
          extraKmLimit: data.extraKmLimit || 0
        });
      } else {
        setPerformanceStats(null);
      }
    } catch (_e) {
      // Ignore transient errors incl. 429
      setPerformanceStats(null);
    } finally {
      setIsLoadingPayrollStats(false);
      inFlightRef.current = false;
      lastFetchAtRef.current = Date.now();
    }
  }, [isDriver, isAdmin, currentUser?.id, selectedDriverId, selectedDate, setPerformanceStats, setIsLoadingPayrollStats]);

  const schedulePayrollFetch = useCallback((reason = 'manual') => {
    const now = Date.now();
    const inProgress = !!sessionStorage.getItem('driver_status_change_in_progress');
    const baseDelay = inProgress ? 1500 : 0; // cushion for bursty toggle flows
    const sinceLast = now - lastFetchAtRef.current;
    const throttleDelay = sinceLast < MIN_INTERVAL ? (MIN_INTERVAL - sinceLast) : 0;
    const delay = Math.max(baseDelay, throttleDelay);

    if (inFlightRef.current) {
      clearTimer();
      timerRef.current = setTimeout(() => schedulePayrollFetch('after-inflight'), MIN_INTERVAL);
      return;
    }

    if (delay > 0) {
      clearTimer();
      timerRef.current = setTimeout(() => fetchNow(), delay);
    } else {
      fetchNow();
    }
  }, [fetchNow]);

  return { schedulePayrollFetch };
}