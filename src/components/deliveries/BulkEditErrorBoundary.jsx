import React from 'react';
import { remoteLogger } from '@/components/utils/remoteLogger';

/**
 * BulkEditErrorBoundary — scoped crash guard for the Bulk Edit stops panel.
 *
 * OWNER REPORT (Nov 24 2026): Erin's iPhone hit the app-wide error boundary while the
 * dashboard Bulk Edit panel was rendering, which blanked the whole Dashboard for her
 * (BulkEditStopsPanel chunk, component stack through DashboardBulkEditControls). The
 * logged error arrived as an EMPTY object, so nothing identifiable reached the logs.
 *
 * Two jobs:
 *   1. Contain the failure to the panel. A bad selection must never take the dashboard
 *      down; the user gets a short retry line instead.
 *   2. Log the error's real shape (name, message, stack, typeof, own keys) so the next
 *      occurrence is identifiable instead of printing "{}".
 *
 * Reset on `resetKey` (the panel's open state + selection) so a recovered panel works
 * again without a full page reload.
 */
export default class BulkEditErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { failed: false, detail: '' };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error, errorInfo) {
    const describe = (value) => {
      if (value === null) return 'null';
      if (value === undefined) return 'undefined';
      if (typeof value !== 'object') return `${typeof value}: ${String(value)}`;
      let keys = [];
      try { keys = Object.keys(value); } catch (_) { keys = ['<unreadable>']; }
      return `object keys=[${keys.join(',')}] name=${value.name || ''} message=${value.message || ''}`;
    };
    const detail = describe(error);
    this.setState({ detail });
    try {
      remoteLogger.error(
        `❌ BULK EDIT PANEL CRASH ${detail} stack=${String(error?.stack || '').slice(0, 900)} componentStack=${String(errorInfo?.componentStack || '').slice(0, 900)}`,
      );
    } catch (_) { /* logging must never throw */ }
    try {
      console.error('[BulkEditErrorBoundary]', error, errorInfo);
    } catch (_) { /* ignore */ }
  }

  componentDidUpdate(prevProps) {
    if (this.state.failed && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ failed: false, detail: '' });
    }
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="fixed inset-0 z-[10050] flex items-center justify-center bg-black/40 p-4">
        <div className="w-full max-w-sm rounded-xl bg-white dark:bg-slate-900 p-4 shadow-xl">
          <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">Bulk Edit hit a snag</p>
          <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">
            Nothing was saved. Close this and try again with fewer stops selected.
          </p>
          <button
            type="button"
            onClick={() => this.setState({ failed: false, detail: '' })}
            className="mt-3 h-9 w-full rounded-lg bg-slate-900 text-sm font-medium text-white dark:bg-slate-100 dark:text-slate-900"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }
}
