/**
 * ChunkErrorBoundary.jsx
 *
 * Catches "Failed to fetch dynamically imported module" errors that occur
 * when a stale PWA tries to load a chunk whose hashed filename no longer exists
 * (i.e. the app was redeployed but the old service worker is still active,
 *  or the browser cache still holds the old index.html that references the
 *  removed chunk).
 *
 * Strategy:
 *  1. If it's a chunk-load error — UNREGISTER all service workers and clear
 *     all caches + the stale HTML entry, then hard-reload once. The fresh SW
 *     (or no SW) will serve updated chunks.
 *  2. If we already reloaded after cleanup and it STILL fails — show a friendly
 *     "Update available" banner with a manual Reload button that re-runs the
 *     full cleanup. Never loop.
 */

import { Component } from 'react';

const RELOAD_FLAG = 'rxdeliver_chunk_reload_attempted';

const isChunkError = (error) => {
  if (!error) return false;
  const msg = String(error.message || error.name || '');
  return (
    msg.includes('Failed to fetch dynamically imported module') ||
    msg.includes('Importing a module script failed') ||
    msg.includes('Unable to preload CSS') ||
    msg.includes('ChunkLoadError') ||
    (error.name === 'TypeError' && msg.includes('Failed to fetch'))
  );
};

/**
 * Force the browser to drop the stale service worker + cached chunks so the
 * next load pulls the current build from the server. Returns a Promise that
 * always resolves (best-effort — never throws) so callers can await it before
 * a reload without risking the reload being skipped.
 */
export const purgeStaleServiceWorkerAndCaches = async () => {
  try {
    // 1. Unregister every active service worker
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(
        (regs || []).map(async (reg) => {
          try { await reg.unregister(); } catch (_) {}
        })
      );
      // Remove any BroadcastChannel/heartbeat the SW may use to keep itself alive
      try {
        const bc = new BroadcastChannel('rxdeliver_sw_heartbeat');
        bc.postMessage('unregister');
        bc.close();
      } catch (_) {}
    }
  } catch (_) {}

  // 2. Wipe all Cache Storage entries (chunks, HTML, JS, CSS from old build)
  try {
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(
        (keys || []).map(async (k) => {
          try { await caches.delete(k); } catch (_) {}
        })
      );
    }
  } catch (_) {}

  // 3. Clear IndexedDB app caches that may hold stale chunk metadata
  //    (storageQuotaGuard / tileCacheManager etc. create these)
  try {
    const idbDbs = await indexedDB.databases?.();
    await Promise.all(
      (idbDbs || []).filter((db) => db?.name?.startsWith?.('rxdeliver')).map(async (db) => {
        try { await new Promise((res, rej) => {
          const req = indexedDB.deleteDatabase(db.name);
          req.onsuccess = res; req.onerror = rej; req.onblocked = res;
        }); } catch (_) {}
      })
    );
  } catch (_) {}

  // 4. Drop localStorage/sessionStorage entries that pin old build hashes
  //    (keep auth + device id so the user isn't logged out by cleanup)
  try {
    const KEEP = new Set([
      'base44_server_url', 'base44_data_env', 'base44_access_token',
      'base44_refresh_token', 'rxdeliver_device_identifier', 'effectiveUserCache',
    ]);
    const stripBuildPinnedKeys = (storage) => {
      for (let i = storage.length - 1; i >= 0; i--) {
        const key = storage.key(i);
        if (!key) continue;
        if (KEEP.has(key)) continue;
        if (key.startsWith('vite:') || key.includes('chunk') || key.includes('chunk_') ||
            key.includes('sw_') || key.includes('precached') || key.includes('workbox')) {
          storage.removeItem(key);
        }
      }
    };
    stripBuildPinnedKeys(localStorage);
    stripBuildPinnedKeys(sessionStorage);
  } catch (_) {}

  // Give the SW unregister a tick to settle before reload races it
  await new Promise((r) => setTimeout(r, 150));
};

export class ChunkErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { crashed: false, chunkError: false };
    this.purgingRef = false;
  }

  static getDerivedStateFromError(error) {
    if (isChunkError(error)) {
      // First chunk error this session → auto-reload after SW/cache purge
      if (!sessionStorage.getItem(RELOAD_FLAG)) {
        sessionStorage.setItem(RELOAD_FLAG, '1');
        // Kick off the purge + reload. Don't await here — return state immediately.
        (async () => {
          await purgeStaleServiceWorkerAndCaches();
          window.location.reload();
        })();
        return { crashed: false, chunkError: true };
      }
      // Already reloaded — show manual banner (user can trigger purge+reload again)
      return { crashed: true, chunkError: true };
    }
    return { crashed: true, chunkError: false };
  }

  componentDidCatch(error, info) {
    console.error('[ChunkErrorBoundary] Caught error:', error?.message, info?.componentStack?.slice(0, 200));
  }

  handleManualReload = async () => {
    sessionStorage.removeItem(RELOAD_FLAG);
    await purgeStaleServiceWorkerAndCaches();
    window.location.reload();
  };

  render() {
    const { crashed, chunkError } = this.state;

    if (!crashed) return this.props.children;

    if (chunkError) {
      return (
        <div className="fixed inset-0 flex flex-col items-center justify-center gap-6 p-8 bg-slate-900 text-white text-center">
          <div className="text-5xl">🔄</div>
          <div>
            <p className="text-xl font-semibold mb-2">Update available</p>
            <p className="text-sm text-slate-400 dark:text-slate-500 dark:text-slate-400 max-w-xs">
              RxDeliver was updated. Reload to clear the old version and get the latest build.
            </p>
          </div>
          <button
            onClick={this.handleManualReload}
            className="px-6 py-3 bg-blue-600 hover:bg-blue-500 rounded-xl text-white font-semibold text-base transition-colors"
          >
            Reload app
          </button>
        </div>
      );
    }

    // Generic crash fallback
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center gap-4 p-8 bg-slate-900 text-white text-center">
        <div className="text-4xl">⚠️</div>
        <p className="text-lg font-semibold">Something went wrong</p>
        <p className="text-sm text-slate-400 dark:text-slate-500 dark:text-slate-400 max-w-xs">
          An unexpected error occurred. Try reloading the app.
        </p>
        <button
          onClick={this.handleManualReload}
          className="px-6 py-3 bg-blue-600 hover:bg-blue-500 rounded-xl text-white font-semibold transition-colors"
        >
          Reload app
        </button>
      </div>
    );
  }
}

export default ChunkErrorBoundary;