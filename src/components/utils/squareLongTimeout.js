/**
 * squareLongTimeout — Square COD syncs legitimately take longer than the
 * global 15s axios cap: squareGetCodData2 pulls paginated payments/orders from
 * every active location, 90 days of deliveries, runs the collected-COD purge
 * and writes bookkeeping (17-25s typical). syncSquareCods batch-creates items
 * in Square itself. The SDK builds its axios instances from axios.defaults,
 * so the only way to extend the cap per-call is to raise the default for the
 * duration of the invocation and restore it after.
 *
 * NOTE: requests fired by unrelated components during the window also get the
 * extended cap — they only WAIT longer before failing, they never fail sooner,
 * which is the correct trade-off for a page that owns the screen while syncing.
 */
import axios from 'axios';
import { base44 } from '@/api/base44Client';

const BASE_DEFAULT_TIMEOUT = 15000;

export const invokeWithLongTimeout = async (fnName, payload, timeoutMs = 120000) => {
  const prev = axios.defaults.timeout || BASE_DEFAULT_TIMEOUT;
  axios.defaults.timeout = timeoutMs;
  try {
    return await base44.functions.invoke(fnName, payload);
  } finally {
    axios.defaults.timeout = prev;
  }
};
