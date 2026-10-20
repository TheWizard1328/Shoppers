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

function openBridgeDb(timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    // BOOT-SAFETY (owner report Oct 9 2026: fresh reloads hang on the load
    // screen): this open runs BEFORE checkAppState on every boot — a wedged
    // or blocked IDB open (Android WebView storage eviction races, another
    // connection holding an old version) must never stall boot forever.
    const timer = setTimeout(() => {
      if (!settled) { settled = true; reject(new Error('authBridge open timeout')); }
    }, timeoutMs);
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(req.result); } };
    req.onerror = () => { if (!settled) { settled = true; clearTimeout(timer); reject(req.error); } };
    req.onblocked = () => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error('authBridge open blocked')); } };
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
// ── AUTH-BOOT DIAGNOSTIC (owner request Oct 20 2026) ────────────────────────
// Shoppers store PCs get a nightly network-wide login wipe — every morning
// dispatchers must re-login to ALL their apps and clear Google's "I am not a
// robot". Before deciding whether a silent auto-restore can beat the wipe,
// we need to know what the wipe actually clears on those PCs:
//   • localStorage token gone but IDB bridge record alive → the existing
//     restore path should already re-login them (if it fails anyway, the
//     token expired SERVER-side — nothing client-side can fix that);
//   • IDB gone too → nothing survives; the fix belongs to their IT
//     (exempt the app's site from the nightly wipe).
// Every boot records a small row INTO the IDB bridge DB itself (no auth
// needed — the wiped boot may be unauthenticated and an API log write would
// 401 anyway). The next AUTHENTICATED boot ships every unsent row once via
// remoteLogger as [AuthBootDiag] lines. Absence of rows from a PC that runs
// the app daily is itself the answer: its IDB is being wiped nightly.
const DIAG_KEY = 'boot_diags';
const DIAG_MAX_ROWS = 10;

const _ceiling = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);

async function _diagRows(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(DIAG_KEY);
    req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
    req.onerror = () => reject(req.error);
  });
}

async function _diagPut(db, rows) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(rows, DIAG_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function _openDiagDb() {
  return _ceiling(openBridgeDb(), 3000);
}

/** Record one boot observation. Fire-and-forget; never blocks boot. */
export async function recordBootDiag(fields = {}) {
  if (typeof window === 'undefined' || !window.indexedDB) return;
  let db;
  try {
    db = await _openDiagDb();
    if (!db) return;
    const rows = (await _ceiling(_diagRows(db), 2000)) || [];
    rows.push({ ts: Date.now(), tz_offset_min: new Date().getTimezoneOffset(), ...fields });
    while (rows.length > DIAG_MAX_ROWS) rows.shift();
    await _ceiling(_diagPut(db, rows), 2000);
  } catch { /* diagnostic only */ }
  try { db && db.close(); } catch {}
}

/** Ship every unsent diagnostic row exactly once (called on authenticated boots). */
export async function shipBootDiags() {
  if (typeof window === 'undefined' || !window.indexedDB) return;
  let db;
  try {
    db = await _openDiagDb();
    if (!db) return;
    const rows = (await _ceiling(_diagRows(db), 2000)) || [];
    if (!rows.length) return;
    let changed = false;
    for (const row of rows) {
      if (row.sent) continue;
      let logger;
      try { logger = (await import('@/components/utils/remoteLogger')).remoteLogger; } catch { return; }
      try {
        logger.info(`[AuthBootDiag] ${JSON.stringify(row)}`);
        row.sent = true; changed = true;
      } catch { /* try again next boot */ }
    }
    if (changed) await _ceiling(_diagPut(db, rows), 2000);
  } catch { /* diagnostic only */ }
  try { db && db.close(); } catch {}
}

export async function restoreTokenFromBridge() {
  if (typeof window === 'undefined' || !window.indexedDB) return false;
  // HARD CEILING: never hold boot hostage on a wedged IDB (the restore is
  // best-effort — a miss just falls through to the normal login flow).
  const withTimeout = (p, ms) => Promise.race([
    p,
    new Promise((resolve) => setTimeout(() => resolve(null), ms))
  ]);
  try {
    const existing = window.localStorage.getItem('base44_access_token') || window.localStorage.getItem('token');
    if (existing) { void recordBootDiag({ ls_token: 'present', bridge_restore: false }); return false; }
    const db = await withTimeout(openBridgeDb(), 3000);
    if (!db) return false;
    const rec = await withTimeout(new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(RECORD_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    }), 3000) || null;
    try { db.close(); } catch {}
    if (!rec?.token) { void recordBootDiag({ ls_token: 'absent', bridge: 'miss' }); return false; }
    void recordBootDiag({
      ls_token: 'absent',
      bridge: 'hit',
      bridge_age_h: rec.updated_at ? Math.round((Date.now() - rec.updated_at) / 360000) / 10 : null,
      bridge_restore: true
    });
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
    void recordBootDiag({ ls_token: window.localStorage.getItem('base44_access_token') ? 'present' : 'absent', restore_error: String(e?.message || e).slice(0, 120) });
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
