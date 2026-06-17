import React from 'react'
import ReactDOM from 'react-dom/client'
import App from '@/App.jsx'
import '@/index.css'
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
    navigator.serviceWorker.register('/map-tile-sw.js').then((registration) => {
      registration.update().catch(() => {});
    }).catch(() => {});
  });
}

if (import.meta.hot) {
  import.meta.hot.on('vite:beforeUpdate', () => {
    window.parent?.postMessage({ type: 'sandbox:beforeUpdate' }, '*');
  });
  import.meta.hot.on('vite:afterUpdate', () => {
    window.parent?.postMessage({ type: 'sandbox:afterUpdate' }, '*');
  });
}