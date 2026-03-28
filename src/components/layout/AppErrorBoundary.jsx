import React from "react";
import { Button } from "@/components/ui/button";

const isSandboxEditMode = () =>
  window.location.search.includes('_preview_token') ||
  window.location.search.includes('hide_badge=true') ||
  window.location.hostname.includes('preview') ||
  window.location.hostname.includes('sandbox');

const isOwnerInEditor = () => {
  try {
    const userCache = sessionStorage.getItem('effectiveUserCache');
    if (!userCache) return false;
    const parsed = JSON.parse(userCache);
    return parsed?.user?.role === 'App Owner';
  } catch {
    return false;
  }
};

const shouldIgnoreNetworkError = (error) => {
  const message = error?.message || '';
  const isNetworkError = message.includes('429') || message.includes('Rate limit') || message.includes('Network') || message.includes('fetch');
  if (!isNetworkError) return false;
  return !(isSandboxEditMode() && isOwnerInEditor());
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

export default class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
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

    this.setState({ errorInfo });
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
    const showErrorDetails = isMobileDevice && isOwnerInEditor() && errorToShow;

    const handleCopyError = () => {
      const errorText = `Error Message:\n${errorToShow?.message || 'Unknown error'}\n\nStack Trace:\n${errorToShow?.stack || 'No stack trace'}`;
      navigator.clipboard.writeText(errorText).then(() => {
        alert('Error copied to clipboard');
      }).catch(() => {
        alert('Failed to copy error');
      });
    };

    return (
      <div className="h-screen flex items-center justify-center bg-slate-50 p-4">
        <div className="text-center max-w-2xl mx-auto">
          <h1 className="text-xl font-semibold text-slate-900 mb-2">Something went wrong</h1>
          <p className="text-slate-600 mb-4">An error occurred while loading the app.</p>

          {showErrorDetails && (
            <div className="text-left mb-4 p-4 bg-red-50 rounded-lg border-2 border-red-300">
              <div className="flex justify-between items-center mb-3">
                <div className="font-bold text-red-900 text-lg">Error Details:</div>
                <Button onClick={handleCopyError} variant="outline" size="sm" className="text-red-700 border-red-300 hover:bg-red-100">
                  Copy Error
                </Button>
              </div>
              <div className="mb-2 p-2 bg-white rounded border border-red-200">
                <div className="font-semibold text-red-900 text-sm mb-1">Message:</div>
                <div className="text-sm text-red-800 break-words">{errorToShow.message || 'Unknown error'}</div>
              </div>
              {errorToShow.stack && (
                <div className="p-2 bg-white rounded border border-red-200">
                  <div className="font-semibold text-red-900 text-sm mb-1">Stack Trace:</div>
                  <pre className="text-xs text-red-800 overflow-auto max-h-40 whitespace-pre-wrap break-words">{errorToShow.stack}</pre>
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