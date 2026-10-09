/**
 * Bridges the Base44 SDK access token (localStorage) into IndexedDB so the
 * push-notification service worker — which has NO access to window.localStorage —
 * can read a valid Authorization token when handling background notification
 * actions (e.g. "Mark as Read", "Acknowledge") triggered while the app is closed.
 *
 * The SDK stores the token under localStorage key "base44_access_token" (see
 * @base44/sdk auth-utils.js). We mirror it into a tiny IndexedDB database that
 * the service worker opens independently.
 */
const DB_NAME = 'rxdeliver_auth_bridge';
const STORE_NAME = 'tokens';
const RECORD_KEY = 'current';

function openBridgeDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function writeToken(token, refreshToken = null) {
  if (!token) return;
  try {
    const db = await openBridgeDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put({ token, refresh_token: refreshToken, updated_at: Date.now() }, RECORD_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (e) {
    console.warn('[authTokenBridge] Failed to persist token to IndexedDB:', e?.message || e);
  }
}

let intervalHandle = null;

/**
 * BOOT RESTORE (owner report Oct 9 2026: "every force close asks me to sign
 * back in"): Android WebView can evict localStorage while keeping IndexedDB
 * alive (same eviction class as the Oct 6 crypto-key loss on Sharuk's S26
 * Ultra). The Base44 SDK keeps the access token in localStorage, so a force
 * close + eviction wiped the session. The bridge below has been mirroring the
 * token into IDB every 30s all along (for the notification service worker) —
 * so on boot, if localStorage has NO token but the bridge copy exists, write
 * it back (localStorage + SDK headers + appParams) BEFORE the auth check.
 * Returns true if a token was restored (caller can proceed to checkAppState).
 */
export async function restoreTokenFromBridge() {
  if (typeof window === 'undefined' || !window.indexedDB) return false;
  try {
    const existing = window.localStorage.getItem('base44_access_token') || window.localStorage.getItem('token');
    if (existing) return false;
    const db = await openBridgeDb();
    const rec = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(RECORD_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    if (!rec?.token) return false;
    window.localStorage.setItem('base44_access_token', rec.token);
    window.localStorage.setItem('token', rec.token);
    if (rec.refresh_token) {
      window.localStorage.setItem('base44_refresh_token', rec.refresh_token);
    }
    // SDK axios headers + the module-singleton appParams token snapshot
    try {
      const { base44 } = await import('@/api/base44Client');
      base44.auth.setToken?.(rec.token);
    } catch { /* non-fatal: checkAppState's 401 path still handles a dead token */ }
    try {
      const { appParams } = await import('@/lib/app-params');
      appParams.token = rec.token;
    } catch { /* appParams already defaults from localStorage on fresh loads */ }
    console.log('[authTokenBridge] Restored access token from IndexedDB bridge after localStorage eviction');
    return true;
  } catch (e) {
    console.warn('[authTokenBridge] Boot restore failed:', e?.message || e);
    return false;
  }
}

/**
 * Start mirroring the current access token into IndexedDB immediately and on
 * a recurring interval (tokens can rotate/refresh while the app is open).
 */
export function startAuthTokenBridge() {
  if (typeof window === 'undefined' || !window.indexedDB) return;

  const sync = () => {
    try {
      const token = window.localStorage.getItem('base44_access_token') || window.localStorage.getItem('token');
      const refreshToken = window.localStorage.getItem('base44_refresh_token');
      if (token) writeToken(token, refreshToken || null);
    } catch (e) {
      // localStorage access can throw in some privacy modes — non-fatal
    }
  };

  sync();
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = setInterval(sync, 30000);

  // Also re-sync on visibility change (app resumed) so a background refresh
  // is picked up quickly for the SW.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') sync();
  });
}
