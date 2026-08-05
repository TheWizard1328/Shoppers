/**
 * ChunkErrorBoundary.jsx
 *
 * Catches "Failed to fetch dynamically imported module" errors that occur
 * when a stale PWA tries to load a chunk whose hashed filename no longer exists
 * (i.e. the app was redeployed but the old service worker is still active).
 *
 * Strategy:
 *  1. If it's a chunk-load error and we haven't reloaded yet this session →
 *     set a sessionStorage flag and hard-reload the page once. The fresh SW
 *     will serve updated chunks.
 *  2. If we already reloaded and it still fails → show a friendly "Update
 *     available" banner so the user can tap Reload manually. Never loop.
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

export class ChunkErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { crashed: false, chunkError: false };
  }

  static getDerivedStateFromError(error) {
    if (isChunkError(error)) {
      // First chunk error this session → auto-reload
      if (!sessionStorage.getItem(RELOAD_FLAG)) {
        sessionStorage.setItem(RELOAD_FLAG, '1');
        // Delay slightly so React finishes the render cycle before reload
        setTimeout(() => window.location.reload(), 300);
        return { crashed: false, chunkError: true };
      }
      // Already reloaded — show manual banner
      return { crashed: true, chunkError: true };
    }
    return { crashed: true, chunkError: false };
  }

  componentDidCatch(error, info) {
    console.error('[ChunkErrorBoundary] Caught error:', error?.message, info?.componentStack?.slice(0, 200));
  }

  handleManualReload = () => {
    sessionStorage.removeItem(RELOAD_FLAG);
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
              RxDeliver was updated. Reload to get the latest version.
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
