import React from 'react'
import ReactDOM from 'react-dom/client'
import App from '@/App.jsx'
import '@/index.css'
import { startAuthTokenBridge } from '@/lib/authTokenBridge'

// ── Global chunk-load error handler ─────────────────────────────────────────
// When Vite rebuilds after a deploy, dynamic import() calls in open tabs reference
// old hashed chunk filenames that no longer exist on the server (404). This produces
// "Failed to fetch dynamically imported module" errors. Trigger ONE silent reload
// so the driver gets the new build, then stop — ChunkErrorBoundary (which also
// purges the stale service worker + caches) handles any further failure instead of
// looping. Without this guard, a persistently-stale SW serving an old index.html
// keeps 404-ing the same chunk and this handler reloads every 1.5s forever, which
// surfaces as the "dashboard refreshes every second until white screen" boot loop.
const CHUNK_RELOAD_FLAG = 'rxdeliver_chunk_reload_attempted';
const chunkReloadAlreadyTried = () => {
  try { return sessionStorage.getItem(CHUNK_RELOAD_FLAG) === '1'; } catch { return false; }
};
const markChunkReloadTried = () => {
  try { sessionStorage.setItem(CHUNK_RELOAD_FLAG, '1'); } catch {}
};
window.addEventListener('error', (event) => {
  const msg = event?.message || '';
  if (msg.includes('Failed to fetch dynamically imported module') || msg.includes('Importing a module script failed')) {
    if (chunkReloadAlreadyTried()) {
      console.warn('⚠️ [ChunkLoad] Stale chunk persists after reload — leaving recovery to ChunkErrorBoundary (no loop)');
      return;
    }
    console.warn('⚠️ [ChunkLoad] Stale chunk detected — reloading once for fresh build');
    markChunkReloadTried();
    // Small delay so any in-flight saves can complete
    setTimeout(() => window.location.reload(), 1500);
  }
});
window.addEventListener('unhandledrejection', (event) => {
  const msg = String(event?.reason?.message || event?.reason || '');
  if (msg.includes('Failed to fetch dynamically imported module') || msg.includes('Importing a module script failed')) {
    event.preventDefault();
    if (chunkReloadAlreadyTried()) {
      console.warn('⚠️ [ChunkLoad] Stale chunk (unhandledrejection) persists — leaving recovery to ChunkErrorBoundary (no loop)');
      return;
    }
    console.warn('⚠️ [ChunkLoad] Stale chunk (unhandledrejection) — reloading once for fresh build');
    markChunkReloadTried();
    setTimeout(() => window.location.reload(), 1500);
  }
});

import L from 'leaflet';

// ─── Leaflet SVG path safety patch ──────────────────────────────────────────
// Leaflet's Path._clipPoints calls this._map.getPixelWorldBounds() which can
// return undefined during react-leaflet's initial addLayer->onAdd cycle before
// the map has completed its first render. Patched synchronously so the prototype
// override is in place before ANY component mounts or adds a layer.
(function patchLeafletSvgPaths() {
  if (!L?.Path?.prototype) return;

  const origClipPoints = L.Path.prototype._clipPoints;
  L.Path.prototype._clipPoints = function () {
    try {
      if (!this._map) return;
      const bounds = this._map.getPixelWorldBounds && this._map.getPixelWorldBounds();
      if (!bounds || bounds.min == null) {
        this._parts = this._rings ? this._rings.slice() : [];
        return;
      }
      return origClipPoints.call(this);
    } catch (e) {
      this._parts = this._rings ? this._rings.slice() : [];
    }
  };

  const origOnRemove = L.Path.prototype.onRemove;
  L.Path.prototype.onRemove = function (map) {
    try {
      if (this._renderer && this._renderer._removePath) {
        return origOnRemove.call(this, map);
      }
    } catch (e) {
      // Renderer not yet initialized — ignore, layer will be GC'd
    }
  };
}());
// ────────────────────────────────────────────────────────────────────────────



ReactDOM.createRoot(document.getElementById('root')).render(
  // <React.StrictMode>
  <App />
  // </React.StrictMode>,
)

if ('serviceWorker' in navigator) {
  window.__hereTileSwMessageQueue = window.__hereTileSwMessageQueue || [];

  navigator.serviceWorker.addEventListener('message', (event) => {
    window.__hereTileSwMessageQueue.push(event?.data);
    window.dispatchEvent(new CustomEvent('hereTileSwMessage'));
  });

  window.addEventListener('load', async () => {
    // Single combined SW: map-tile-sw.js handles BOTH tile caching AND push
    // notifications. The separate push-sw.js was removed to eliminate the
    // two-SW controller race that broke background push delivery on Android.
    //
    // CRITICAL: unregister any lingering push-sw.js registrations from earlier
    // builds. When two SWs are registered at the same scope, Android Chrome
    // sometimes fires the push event on the NON-controlling SW (push-sw.js),
    // which has no handler — so push notifications only arrive when the app
    // is foregrounded and map-tile-sw.js happens to be active. Removing the
    // stale registration forces map-tile-sw.js to be the sole controller.
    try {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(async (r) => {
        const scriptUrl = r.active?.scriptURL || r.installing?.scriptURL || r.waiting?.scriptURL || '';
        if (scriptUrl.includes('push-sw.js')) {
          await r.unregister().catch(() => {});
        }
      }));
    } catch (_) { /* non-critical */ }

    navigator.serviceWorker.register('/map-tile-sw.js').then((registration) => {
      registration.update().catch(() => {});
    }).catch(() => {});
  });

  // Listen for notification action button clicks from the service worker
  // (e.g. "Mark as Read", "Acknowledge") so the UI can update in real-time
  // when the user taps a button on a push notification while the app is open.
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event?.data?.type === 'notification_action') {
      window.dispatchEvent(new CustomEvent('notification_action', { detail: event.data }));
    }
  });

  // Mirror the auth token into IndexedDB so the SW can make authenticated
  // API calls for background notification actions.
  startAuthTokenBridge();
}

if (import.meta.hot) {
  import.meta.hot.on('vite:beforeUpdate', () => {
    window.parent?.postMessage({ type: 'sandbox:beforeUpdate' }, '*');
  });
  import.meta.hot.on('vite:afterUpdate', () => {
    window.parent?.postMessage({ type: 'sandbox:afterUpdate' }, '*');
  });
}