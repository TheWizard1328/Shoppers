import { useEffect, useCallback, useRef } from 'react';

/**
 * A custom hook to automatically refresh data on an interval and on window focus.
 * NOW COMPLETELY DISABLED by default to prevent UI shakiness.
 * @param {Function} refreshFunction The async function to call to refresh data.
 * @param {number} interval The refresh interval in milliseconds.
 * @param {boolean} paused A flag to temporarily pause the refresh mechanism.
 * @param {boolean} enabled A flag to enable/disable auto-refresh entirely (DEFAULT: FALSE).
 */
export const useAutoRefresh = (refreshFunction, interval = 300000, paused = false, enabled = false) => {
  const memoizedRefresh = useCallback(refreshFunction, [refreshFunction]);
  const lastCallTime = useRef(0);
  const backoffTime = useRef(0);
  const intervalRef = useRef(null);

  const rateLimitedRefresh = useCallback(async () => {
    if (paused || !enabled) {
      return;
    }

    const now = Date.now();
    const timeSinceLastCall = now - lastCallTime.current;
    const minInterval = Math.max(60000, backoffTime.current);

    if (timeSinceLastCall < minInterval) {
      return;
    }

    try {
      lastCallTime.current = now;
      await memoizedRefresh();
      backoffTime.current = 0;
    } catch (error) {
      if (error.response?.status === 429 || error.message?.includes('429')) {
        // Exponential pattern: 1m → 2m → 5m (cap)
        backoffTime.current = backoffTime.current === 0 ? 60000 : (backoffTime.current === 60000 ? 120000 : 300000);
        console.warn(`Rate limit hit, backing off for ${backoffTime.current}ms`);
      }
      console.error('Refresh failed:', error);
    }
  }, [memoizedRefresh, paused, enabled]);

  useEffect(() => {
    if (!enabled || paused) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    intervalRef.current = setInterval(rateLimitedRefresh, interval);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [rateLimitedRefresh, interval, paused, enabled]);
};