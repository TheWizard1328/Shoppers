/**
 * apiCountsCache — local IndexedDB mirror of today's Google / HERE usage counts.
 *
 * OWNER SPEC (Nov 9 2026): the API usage badge used to re-query GoogleAPILog on
 * every dashboard load, which is what produced the 429 bursts on the owner's
 * editor instance. The counts now live in IDB on the device:
 *
 *   1. On load (or a dashboard remount / page switch) the badge paints straight
 *      from IDB — no network.
 *   2. Only when the cached copy is older than 5 minutes does that device do one
 *      quick server pull.
 *   3. Every later change arrives over the WebSocket (all devices write
 *      GoogleAPILog rows, so every call anywhere in the app is broadcast) and is
 *      folded into the same IDB record.
 *
 * Deliberately a SEPARATE tiny database: the main offline DB has a fixed store
 * list and its own version migrations, and nothing here needs to join it.
 */

const DB_NAME = 'rxdeliver_api_counts';
const STORE = 'counts';
const REFRESH_AFTER_MS = 5 * 60 * 1000; // owner rule: 5 minutes

let dbPromise = null;

const openDb = () => {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'day' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch (_) {
      resolve(null);
    }
  });
  return dbPromise;
};

const tx = async (mode, fn) => {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const t = db.transaction(STORE, mode);
      const store = t.objectStore(STORE);
      let out = null;
      const req = fn(store);
      if (req) req.onsuccess = () => { out = req.result ?? null; };
      t.oncomplete = () => resolve(out);
      t.onerror = () => resolve(null);
      t.onabort = () => resolve(null);
    } catch (_) {
      resolve(null);
    }
  });
};

/** Local calendar day key (the badge's own day window is local midnight → local 23:59). */
export const dayKeyOf = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const EMPTY = { google: 0, hereRouting: 0, hereTiles: 0, fetchedAt: 0 };

/**
 * Cached counts for a day.
 * @returns {Promise<{google:number, hereRouting:number, hereTiles:number, fetchedAt:number, hasData:boolean}>}
 */
export const readApiCounts = async (day = dayKeyOf()) => {
  const row = await tx('readonly', (store) => store.get(day));
  if (!row) return { ...EMPTY, hasData: false };
  return {
    google: Number(row.google) || 0,
    hereRouting: Number(row.hereRouting) || 0,
    hereTiles: Number(row.hereTiles) || 0,
    fetchedAt: Number(row.fetchedAt) || 0,
    hasData: true,
  };
};

/** Absolute write — used after a server pull. */
export const writeApiCounts = async ({ google, hereRouting, hereTiles, day = dayKeyOf(), fetchedAt = Date.now() }) => {
  await tx('readwrite', (store) => store.put({
    day,
    google: Number(google) || 0,
    hereRouting: Number(hereRouting) || 0,
    hereTiles: Number(hereTiles) || 0,
    fetchedAt: Number(fetchedAt) || Date.now(),
  }));
};

/**
 * Fold one broadcast log row into the cached day (what the WebSocket handler calls).
 * Never invents a `fetchedAt`, so an increment does NOT postpone the 5-minute pull.
 */
export const bumpApiCounts = async (category, count = 1, day = dayKeyOf()) => {
  const row = (await tx('readonly', (store) => store.get(day))) || { day, ...EMPTY };
  const next = { ...row, day };
  if (category === 'google') next.google = (Number(row.google) || 0) + count;
  else if (category === 'here_routing') next.hereRouting = (Number(row.hereRouting) || 0) + count;
  else if (category === 'here_tiles') next.hereTiles = (Number(row.hereTiles) || 0) + count;
  else return;
  await tx('readwrite', (store) => store.put(next));
};

/** Owner rule: a device pulls from the server only when its cached copy is 5+ minutes old. */
export const needsServerRefresh = (cached) => {
  if (!cached || !cached.hasData || !cached.fetchedAt) return true;
  return Date.now() - cached.fetchedAt > REFRESH_AFTER_MS;
};

export const REFRESH_INTERVAL_MS = REFRESH_AFTER_MS;
