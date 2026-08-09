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

async function writeToken(token) {
  if (!token) return;
  try {
    const db = await openBridgeDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put({ token, updated_at: Date.now() }, RECORD_KEY);
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
 * Start mirroring the current access token into IndexedDB immediately and on
 * a recurring interval (tokens can rotate/refresh while the app is open).
 */
export function startAuthTokenBridge() {
  if (typeof window === 'undefined' || !window.indexedDB) return;

  const sync = () => {
    try {
      const token = window.localStorage.getItem('base44_access_token') || window.localStorage.getItem('token');
      if (token) writeToken(token);
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
