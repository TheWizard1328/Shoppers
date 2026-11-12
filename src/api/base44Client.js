import axios from 'axios';
import { createClient } from '@base44/sdk';
import { appParams } from '@/lib/app-params';
import { connectionMonitor } from '@/components/utils/connectionMonitor';
import { publishApiIssue } from '@/components/utils/apiIssueBus';

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
  // Square balances compute (owner report Oct 19 2026): the same multi-driver
  // paginated Square fetches as the other sync fns — runs 17-25s+ on cold
  // paths. Left at the 15s cap it "timed out", returned no payload, and every
  // owner device retried every ~2 min all night while the Editor host slept.
  'squareBalancesCompute',
  'squareSyncCatalog2',
  'squareSyncCatalogItems',
  'squareCodTenderPeek',
  // Full-year payroll/metrics pull: computes a year of deliveries, payroll
  // records and driver stats server-side — legitimately 20-60s on cold cache.
  'getAdminMetricsAndPayrollData',
  'squareGetCodData2',
  'syncSquareCods',
  'squareCodReconcile',
  'squareLedgerSync',
  'squareVerifyCatalog',
  'squareSyncHealth',
  'squarePurgeBookkeepingTxs',
  'squareSyncOnline',
  'squareFetchPmts',
  'squareMirrorCatalog',
]);
const LONG_TIMEOUT_MS = 120000;
// ── SILENT BACKGROUND HOUSEKEEPING (owner report Nov 4 2026) ────────────────
// "I'm still seeing a lot of these errors quite regularly just after completing
// stops or just driving along between stops": syncPendingBreadcrumbs,
// SquareBalancesSnapshot, DriverDailyActivity and patientPortalWatchers all
// fired within one second of each other on a weak cellular link, all four hit
// the hard 15s cap, and all four painted an ERROR box over the map.
// None of them is user-facing: every one retries on its own next cycle. So they
// get a longer cap (a slow link is not a failure) and they never publish an
// issue balloon. Real failures still land in the console.
const SILENT_BACKGROUND_ENDPOINTS = new Set([
  'syncPendingBreadcrumbs',
  'patientPortalWatchers',
  'DriverDailyActivity',
  'SquareBalancesSnapshot',
]);
const SILENT_BACKGROUND_MS = 45000;
const endpointOfRequest = (url) => {
  if (typeof url !== 'string') return null;
  const fn = url.match(/\/functions\/([A-Za-z0-9_]+)(?:\?|$)/);
  if (fn) return fn[1];
  const ent = url.match(/\/entities\/([A-Za-z0-9_]+)/);
  if (ent) return ent[1];
  return null;
};
// OWNER REPORT (Nov 12 2026, My-Phone): four ERROR balloons in a row — 
// DeliveryBreadcrumbs / Store GET and Delivery / Patient PUT, all 15s timeouts —
// during one weak-link minute. The GETs are background reads that retry on their
// own next cycle, so they no longer paint an issue balloon (the timeout itself is
// left at 15s so a dead link still fails fast). WRITES stay visible on purpose:
// a PUT that times out may not have landed, and that is worth surfacing.
const SILENT_BACKGROUND_READ_ENTITIES = new Set(['DeliveryBreadcrumbs', 'Store']);
const isSilentBackground = (url, method) => {
  const endpoint = endpointOfRequest(url);
  if (SILENT_BACKGROUND_ENDPOINTS.has(endpoint)) return true;
  const verb = String(method || 'get').toLowerCase();
  return verb === 'get' && SILENT_BACKGROUND_READ_ENTITIES.has(endpoint);
};

const originalAxiosCreate = axios.create.bind(axios);
axios.create = (config) => {
  const instance = originalAxiosCreate(config);
  // Owner issue balloon: tag every failed SDK request with entity/function + method
  // (the SDK's own console error drops the URL). Passes the error through untouched.
  instance.interceptors.response.use((r) => r, (error) => {
    const failedUrl = error?.config?.url || error?.response?.config?.url;
    const failedMethod = error?.config?.method || error?.response?.config?.method;
    if (!isSilentBackground(failedUrl, failedMethod)) publishApiIssue(error);
    return Promise.reject(error);
  });
  instance.interceptors.request.use((cfg) => {
    const endpoint = endpointOfRequest(cfg?.url);
    if (endpoint && LONG_TIMEOUT_FUNCTIONS.has(endpoint)) {
      cfg.timeout = LONG_TIMEOUT_MS;
    } else if (endpoint && SILENT_BACKGROUND_ENDPOINTS.has(endpoint)) {
      cfg.timeout = SILENT_BACKGROUND_MS;
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
