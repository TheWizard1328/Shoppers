import React from 'react'
import ReactDOM from 'react-dom/client'
import App from '@/App.jsx'
import '@/index.css'

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