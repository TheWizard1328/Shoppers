import { useState, useEffect, useRef } from 'react';
import { base44 } from '@/api/base44Client';

/**
 * Checks whether the driver's Square reader is currently active on the expected
 * location by peeking at recent orders for that locationId via the Square API.
 * Walks up to 50 recent orders to find the first one attributed to this specific
 * driver (matched by name via Square Team Members API), so multiple drivers at
 * the same location don't interfere with each other's status.
 *
 * Returns: 'idle' | 'loading' | 'verified' | 'mismatch' | 'no_data'
 *
 * Fires only when isNextDelivery=true AND it is a COD stop.
 * Cache is keyed per locationId+driverName for 5 minutes to avoid repeated calls.
 */

const cache = new Map(); // `${locationId}:${driverName}` -> { status, ts }
const CACHE_TTL_MS = 5 * 60 * 1000;

export function useSquareLocationCheck({ isNextDelivery, hasCODRequired, isCODComplete, expectedLocationId, driverName }) {
  const [status, setStatus] = useState('idle');
  const abortRef = useRef(false);

  const shouldCheck = isNextDelivery && hasCODRequired && !isCODComplete && !!expectedLocationId;

  // Stable cache key — includes driverName so two drivers at the same location
  // never share a cached result.
  const cacheKey = expectedLocationId && driverName
    ? `${expectedLocationId}:${String(driverName).toLowerCase().trim()}`
    : expectedLocationId || null;

  useEffect(() => {
    if (!shouldCheck) {
      setStatus('idle');
      return;
    }

    // Check cache first
    const cached = cacheKey ? cache.get(cacheKey) : null;
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
      setStatus(cached.status);
      return;
    }

    abortRef.current = false;
    setStatus('loading');

    const run = async () => {
      try {
        const resp = await base44.functions.invoke('squareCodCore', {
          action: 'peekDriverTransaction',
          locationId: expectedLocationId,
          driverName: driverName || null,
        });
        const data = resp?.data || {};

        if (abortRef.current) return;

        let result;
        if (!data.found) {
          // No transaction found for this driver — first COD of day (neutral, no warning)
          result = 'no_data';
        } else if (data.lastLocationId === expectedLocationId) {
          result = 'verified';
        } else {
          result = 'mismatch';
        }

        if (cacheKey) cache.set(cacheKey, { status: result, ts: Date.now() });
        setStatus(result);
      } catch (_) {
        if (!abortRef.current) setStatus('no_data');
      }
    };

    run();

    return () => { abortRef.current = true; };
  }, [shouldCheck, expectedLocationId, cacheKey]);

  return status;
}
