import { useState, useEffect, useRef } from 'react';
import { base44 } from '@/api/base44Client';

/**
 * Checks whether the driver's Square reader is currently active on the expected
 * location by peeking at the most-recent order for that locationId via the Square API.
 *
 * Returns: 'idle' | 'loading' | 'verified' | 'mismatch' | 'no_data'
 *
 * Fires only when isNextDelivery=true AND it is a COD stop.
 * Caches results per locationId for 5 minutes to avoid repeated API calls.
 */

const cache = new Map(); // locationId -> { status, ts }
const CACHE_TTL_MS = 5 * 60 * 1000;

export function useSquareLocationCheck({ isNextDelivery, hasCODRequired, isCODComplete, expectedLocationId }) {
  const [status, setStatus] = useState('idle');
  const abortRef = useRef(false);

  const shouldCheck = isNextDelivery && hasCODRequired && !isCODComplete && !!expectedLocationId;

  useEffect(() => {
    if (!shouldCheck) {
      setStatus('idle');
      return;
    }

    // Check cache first
    const cached = cache.get(expectedLocationId);
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
        });
        const data = resp?.data || {};

        if (abortRef.current) return;

        let result;
        if (!data.found) {
          // No recent transactions — can't confirm, show as no_data (neutral)
          result = 'no_data';
        } else if (data.lastLocationId === expectedLocationId) {
          result = 'verified';
        } else {
          result = 'mismatch';
        }

        cache.set(expectedLocationId, { status: result, ts: Date.now() });
        setStatus(result);
      } catch (_) {
        if (!abortRef.current) setStatus('no_data');
      }
    };

    run();

    return () => { abortRef.current = true; };
  }, [shouldCheck, expectedLocationId]);

  return status;
}