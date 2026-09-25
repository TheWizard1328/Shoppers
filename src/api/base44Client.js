import axios from 'axios';
import { createClient } from '@base44/sdk';
import { appParams } from '@/lib/app-params';
import { connectionMonitor } from '@/components/utils/connectionMonitor';

const { appId, serverUrl, token, functionsVersion } = appParams;

// The SDK creates its own Axios instances from the shared defaults. A hard
// timeout prevents a black-holed cellular connection from leaving UI actions,
// auth/bootstrap, GPS uploads, or sync queues pending forever.
axios.defaults.timeout = 15000;

// Known-slow backend functions: the Square COD/Finance syncs legitimately run
// 17-25s+ (multi-location paginated Square API fetches, 90-day delivery pulls,
// ledger backfills). The 15s global cap kills them ("timeout of 15000ms
// exceeded" on the Square Management page).
//
// CRITICAL MECHANICS: the SDK's axios instances snapshot axios.defaults at
// createClient() time — mutating axios.defaults.timeout LATER is invisible to
// them. The correct hook is axios.create itself: wrap it so every instance the
// SDK builds gets a request interceptor that raises the timeout per request,
// matched by function name in the URL. All other requests keep the 15s cap.
const LONG_TIMEOUT_FUNCTIONS = new Set([
  // Full-year payroll/metrics pull: computes a year of deliveries, payroll
  // records and driver stats server-side — legitimately 20-60s on cold cache.
  'getAdminMetricsAndPayrollData',
  'squareGetCodData2',
  'syncSquareCods',
  'squareCodReconcile',
  'squareLedgerSync',
  'squareSyncHealth',
  'squarePurgeBookkeepingTxs',
  'squareSyncOnline',
  'squareFetchPmts',
  'squareMirrorCatalog',
]);
const LONG_TIMEOUT_MS = 120000;
const originalAxiosCreate = axios.create.bind(axios);
axios.create = (config) => {
  const instance = originalAxiosCreate(config);
  instance.interceptors.request.use((cfg) => {
    const fnMatch = typeof cfg?.url === 'string' ? cfg.url.match(/\/functions\/([A-Za-z0-9_]+)(?:\?|$)/) : null;
    if (fnMatch && LONG_TIMEOUT_FUNCTIONS.has(fnMatch[1])) {
      cfg.timeout = LONG_TIMEOUT_MS;
    }
    return cfg;
  });
  return instance;
};

const classifyConnectionError = (error) => {
  const message = String(error?.message || '').toLowerCase();
  const status = Number(error?.status || error?.response?.status || error?.code);
  if (status === 429 || message.includes('rate limit')) return 'rate_limit';
  if (error?.code === 'ECONNABORTED' || message.includes('timeout')) return 'timeout';
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'offline';
  if (!status || message.includes('network') || message.includes('fetch')) return 'network';
  return null;
};

export const base44 = createClient({
  appId,
  serverUrl,
  token,
  functionsVersion,
  requiresAuth: false,
  options: {
    onError: (error) => {
      const connectionErrorType = classifyConnectionError(error);
      if (!connectionErrorType) return;
      connectionMonitor.recordError(connectionErrorType);
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('connectionError', {
          detail: { errorType: connectionErrorType, message: error?.message || 'Connection error' }
        }));
      }
    }
  }
});
