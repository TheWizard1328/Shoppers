import React from "react";
import { Button } from "@/components/ui/button";

const isSandboxEditMode = () =>
  window.location.search.includes('_preview_token') ||
  window.location.search.includes('hide_badge=true') ||
  window.location.hostname.includes('preview') ||
  window.location.hostname.includes('sandbox');

// Fix: Base44 platform role for app owners is 'admin', NOT 'App Owner'.
// The old check only matched 'App Owner' which never exists in practice,
// so crash details were NEVER shown to the app owner on mobile.
const isAppOwnerUser = () => {
  try {
    const userCache = sessionStorage.getItem('effectiveUserCache') || localStorage.getItem('effectiveUserCache');
    if (!userCache) return false;
    const parsed = JSON.parse(userCache);
    const role = parsed?.user?.role;
    return role === 'admin' || role === 'App Owner';
  } catch {
    return false;
  }
};

// Keep alias for network-error gate logic
const isOwnerInEditor = isAppOwnerUser;

const shouldIgnoreNetworkError = (error) => {
  const message = error?.message || '';
  const isNetworkError = message.includes('429') || message.includes('Rate limit') || message.includes('Network') || message.includes('fetch');
  if (!isNetworkError) return false;
  return !(isSandboxEditMode() && isAppOwnerUser());
};

const shouldIgnoreError = (error) => {
  const message = error?.message || '';
  if (!message) return false;

  if (message.includes('l is not a function') || message.includes('_leaflet_pos') || message.includes('Leaflet')) {
    return true;
  }

  if (shouldIgnoreNetworkError(error)) {
    return true;
  }

  if (message.includes('flushSync') || message.includes('useEffect') || message.includes('setState')) {
    return true;
  }

  return false;
};

// ── Global pre-boundary error capture ──────────────────────────────────────
const CRASH_BUFFER_KEY = 'rxdeliver_crash_buffer';
const MAX_CRASH_ENTRIES = 10;

const storeCrashEntry = (entry) => {
  try {
    const raw = localStorage.getItem(CRASH_BUFFER_KEY);
    const buffer = raw ? JSON.parse(raw) : [];
    buffer.push(entry);
    const trimmed = buffer.slice(-MAX_CRASH_ENTRIES);
    localStorage.setItem(CRASH_BUFFER_KEY, JSON.stringify(trimmed));
  } catch {}
};

const readCrashBuffer = () => {
  try {
    const raw = localStorage.getItem(CRASH_BUFFER_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
};

let _globalHandlersInstalled = false;
const installGlobalErrorCapture = () => {
  if (_globalHandlersInstalled || typeof window === 'undefined') return;
  _globalHandlersInstalled = true;

  window.addEventListener('error', (event) => {
    const error = event.error || event;
    const message = error?.message || String(event.message || 'Unknown error');
    if (shouldIgnoreError({ message })) return;
    storeCrashEntry({
      type: 'window.onerror',
      message,
      stack: error?.stack || '',
      filename: event.filename || '',
      lineno: event.lineno || 0,
      colno: event.colno || 0,
      timestamp: new Date().toISOString(),
      url: window.location.pathname,
    });
    console.error('🔴 [PreBoundary] Uncaught error:', message, error?.stack);
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const message = reason?.message || String(reason || 'Unhandled rejection');
    if (shouldIgnoreError({ message })) return;
    storeCrashEntry({
      type: 'unhandledrejection',
      message,
      stack: reason?.stack || '',
      timestamp: new Date().toISOString(),
      url: window.location.pathname,
    });
    console.error('🔴 [PreBoundary] Unhandled rejection:', message, reason?.stack);
  });
};

export default class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null, crashCount: 0 };
    installGlobalErrorCapture();
  }

  static getDerivedStateFromError(error) {
    if (shouldIgnoreError(error)) {
      return { hasError: false };
    }

    try {
      localStorage.setItem('rxdeliver_last_error', JSON.stringify({
        message: error?.message || 'Unknown error',
        stack: error?.stack || '',
        timestamp: new Date().toISOString()
      }));
    } catch {}

    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    if (shouldIgnoreError(error)) {
      this.setState({ hasError: false, error: null, errorInfo: null });
      return;
    }

    const crashEntry = {
      type: 'react-error-boundary',
      message: error?.message || 'Unknown error',
      stack: error?.stack || '',
      componentStack: errorInfo?.componentStack || '',
      timestamp: new Date().toISOString(),
      url: window.location.pathname,
    };

    storeCrashEntry(crashEntry);

    this.setState((prev) => ({
      errorInfo,
      crashCount: prev.crashCount + 1,
    }));

    console.error('❌ CRITICAL ERROR CAUGHT BY ERROR BOUNDARY', error, errorInfo);
  }

  render() {
    if (this.state.hasError && isSandboxEditMode()) throw this.state.error;
    if (!this.state.hasError) return this.props.children;

    let cachedError = null;
    try {
      const cached = localStorage.getItem('rxdeliver_last_error');
      if (cached) cachedError = JSON.parse(cached);
    } catch {}

    const errorToShow = this.state.error || cachedError;
    const isMobileDevice = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

    // Show crash details for app owners on ALL devices, not just in editor mode.
    const showErrorDetails = (isAppOwnerUser() || !isMobileDevice) && errorToShow;

    const crashHistory = readCrashBuffer();

    const handleCopyError = () => {
      const recentCrashes = crashHistory.slice(-5).map((c, i) =>
        `[${i + 1}] ${c.timestamp} (${c.type})\n  ${c.message}\n  ${c.stack?.split('\n').slice(0, 5).join('\n  ')}`
      ).join('\n\n');
      const errorText = `Error Message:\n${errorToShow?.message || 'Unknown error'}\n\nStack Trace:\n${errorToShow?.stack || 'No stack trace'}\n\nComponent Stack:\n${this.state.errorInfo?.componentStack || 'N/A'}\n\nRecent Crashes:\n${recentCrashes}`;
      navigator.clipboard.writeText(errorText).then(() => {
        alert('Error copied to clipboard');
      }).catch(() => {
        alert('Failed to copy error');
      });
    };

    const handleCopyAllCrashes = () => {
      const allCrashes = crashHistory.map((c, i) =>
        `[${i + 1}] ${c.timestamp} (${c.type}) @ ${c.url}\n  Message: ${c.message}\n  Stack: ${c.stack || 'N/A'}\n  ComponentStack: ${c.componentStack || 'N/A'}`
      ).join('\n\n---\n\n');
      navigator.clipboard.writeText(allCrashes).then(() => {
        alert(`Copied ${crashHistory.length} crash entries`);
      }).catch(() => {
        alert('Failed to copy');
      });
    };

    return (
      <div className="h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-800 p-4 overflow-auto">
        <div className="text-center max-w-2xl mx-auto">
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100 mb-2">Something went wrong</h1>
          <p className="text-slate-600 dark:text-slate-400 dark:text-slate-500 mb-2">An error occurred while loading the app.</p>
          {this.state.crashCount > 1 && (
            <p className="text-sm text-amber-600 dark:text-amber-400 mb-2">
              This app has crashed {this.state.crashCount} times this session.
            </p>
          )}

          {showErrorDetails && (
            <div className="text-left mb-4 p-4 bg-red-50 dark:bg-red-950 rounded-lg border-2 border-red-300">
              <div className="flex justify-between items-center mb-3">
                <div className="font-bold text-red-900 text-lg">Error Details:</div>
                <div className="flex gap-2">
                  <Button onClick={handleCopyAllCrashes} variant="outline" size="sm" className="text-red-700 border-red-300 hover:bg-red-100">
                    Copy All ({crashHistory.length})
                  </Button>
                  <Button onClick={handleCopyError} variant="outline" size="sm" className="text-red-700 border-red-300 hover:bg-red-100">
                    Copy Error
                  </Button>
                </div>
              </div>
              <div className="mb-2 p-2 bg-white dark:bg-slate-900 rounded border border-red-200">
                <div className="font-semibold text-red-900 text-sm mb-1">Message:</div>
                <div className="text-sm text-red-800 break-words">{errorToShow.message || 'Unknown error'}</div>
              </div>
              {errorToShow.stack && (
                <div className="mb-2 p-2 bg-white dark:bg-slate-900 rounded border border-red-200">
                  <div className="font-semibold text-red-900 text-sm mb-1">Stack Trace:</div>
                  <pre className="text-xs text-red-800 overflow-auto max-h-40 whitespace-pre-wrap break-words">{errorToShow.stack}</pre>
                </div>
              )}
              {this.state.errorInfo?.componentStack && (
                <div className="mb-2 p-2 bg-white dark:bg-slate-900 rounded border border-red-200">
                  <div className="font-semibold text-red-900 text-sm mb-1">Component Stack:</div>
                  <pre className="text-xs text-red-800 overflow-auto max-h-32 whitespace-pre-wrap break-words">{this.state.errorInfo.componentStack}</pre>
                </div>
              )}
              {crashHistory.length > 1 && (
                <div className="p-2 bg-white dark:bg-slate-900 rounded border border-red-200">
                  <div className="font-semibold text-red-900 text-sm mb-1">Recent Crashes ({crashHistory.length}):</div>
                  <div className="text-xs text-red-700 space-y-1 max-h-32 overflow-auto">
                    {crashHistory.slice(-5).reverse().map((c, i) => (
                      <div key={i} className="border-b border-red-100 dark:border-red-900 pb-1">
                        <span className="font-mono">{c.timestamp}</span> ({c.type}): {c.message}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="flex gap-3 justify-center">
            <Button
              onClick={() => {
                localStorage.removeItem('rxdeliver_last_error');
                sessionStorage.clear();
                window.location.reload();
              }}
              className="bg-emerald-600 hover:bg-emerald-700"
            >
              Clear Cache & Refresh
            </Button>
            <Button onClick={() => window.location.reload()} variant="outline">
              Refresh Page
            </Button>
          </div>
        </div>
      </div>
    );
  }
}
