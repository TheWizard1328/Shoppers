/**
 * InkbirdBleLog.jsx
 *
 * Captures and displays BLE connection attempt logs for the Inkbird sensor.
 * Logs are written to localStorage so they persist across page reloads.
 * The hook fires events via window custom events which this component listens to.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Bluetooth, Trash2, RefreshCw, ChevronDown, ChevronUp } from 'lucide-react';

const LOG_KEY = 'rxdeliver_inkbird_ble_log';
const MAX_ENTRIES = 80;

export function appendInkbirdLog(level, message, detail = null) {
  try {
    const existing = JSON.parse(localStorage.getItem(LOG_KEY) || '[]');
    const entry = {
      ts: new Date().toISOString(),
      level,   // 'info' | 'warn' | 'error' | 'success'
      message,
      detail: detail ? JSON.stringify(detail) : null,
    };
    const updated = [entry, ...existing].slice(0, MAX_ENTRIES);
    localStorage.setItem(LOG_KEY, JSON.stringify(updated));
    // Broadcast to any mounted InkbirdBleLog component
    window.dispatchEvent(new CustomEvent('inkbirdBleLog', { detail: entry }));
  } catch (_) {}
}

const LEVEL_STYLES = {
  info:    'bg-blue-100 text-blue-800',
  warn:    'bg-yellow-100 text-yellow-800',
  error:   'bg-red-100 text-red-800',
  success: 'bg-green-100 text-green-800',
};

function formatTs(iso) {
  try {
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
  } catch { return iso; }
}

export default function InkbirdBleLog() {
  const [logs, setLogs] = useState(() => {
    try { return JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); } catch { return []; }
  });
  const [expanded, setExpanded] = useState(false);
  const [expandedEntry, setExpandedEntry] = useState(null);

  // Listen for new log entries pushed by the hook
  useEffect(() => {
    const handler = (e) => {
      setLogs(prev => [e.detail, ...prev].slice(0, MAX_ENTRIES));
    };
    window.addEventListener('inkbirdBleLog', handler);
    return () => window.removeEventListener('inkbirdBleLog', handler);
  }, []);

  const handleClear = useCallback(() => {
    localStorage.removeItem(LOG_KEY);
    setLogs([]);
    setExpandedEntry(null);
  }, []);

  const handleRefresh = useCallback(() => {
    try { setLogs(JSON.parse(localStorage.getItem(LOG_KEY) || '[]')); } catch { setLogs([]); }
  }, []);

  // Detect current BLE environment info for display
  const bleInfo = {
    hasBluetooth: typeof navigator !== 'undefined' && !!navigator.bluetooth,
    hasGetDevices: typeof navigator !== 'undefined' && typeof navigator.bluetooth?.getDevices === 'function',
    isTouchDevice: typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0,
    isSecureContext: typeof window !== 'undefined' && window.isSecureContext,
    isTopFrame: typeof window !== 'undefined' && window === window.top,
    savedSensor: typeof localStorage !== 'undefined' ? localStorage.getItem('rxdeliver_inkbird_sensor_name') : null,
  };

  return (
    <Card style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle
            className="text-base font-semibold flex items-center gap-2 cursor-pointer select-none"
            style={{ color: 'var(--text-slate-700)' }}
            onClick={() => setExpanded(v => !v)}
          >
            <Bluetooth className="w-4 h-4 text-blue-500" />
            Inkbird BLE Diagnostics
            {logs.length > 0 && (
              <Badge className="bg-slate-200 text-slate-700 text-xs">{logs.length}</Badge>
            )}
            {expanded ? <ChevronUp className="w-4 h-4 ml-auto" /> : <ChevronDown className="w-4 h-4 ml-auto" />}
          </CardTitle>
          <div className="flex gap-1 ml-2">
            <Button variant="ghost" size="sm" onClick={handleRefresh} title="Refresh logs">
              <RefreshCw className="w-3 h-3" />
            </Button>
            <Button variant="ghost" size="sm" onClick={handleClear} title="Clear logs" disabled={logs.length === 0}>
              <Trash2 className="w-3 h-3" />
            </Button>
          </div>
        </div>
      </CardHeader>

      {expanded && (
        <CardContent className="space-y-3 pt-0">
          {/* Environment snapshot */}
          <div className="rounded-lg border p-3 space-y-1 text-xs" style={{ borderColor: 'var(--border-slate-200)', background: 'var(--bg-slate-50)' }}>
            <p className="font-semibold mb-1" style={{ color: 'var(--text-slate-700)' }}>BLE Environment</p>
            {[
              ['Web Bluetooth API', bleInfo.hasBluetooth],
              ['getDevices() available', bleInfo.hasGetDevices],
              ['Touch device', bleInfo.isTouchDevice],
              ['Secure context (HTTPS)', bleInfo.isSecureContext],
              ['Top-level frame (not iframe)', bleInfo.isTopFrame],
            ].map(([label, ok]) => (
              <div key={label} className="flex items-center justify-between">
                <span style={{ color: 'var(--text-slate-600)' }}>{label}</span>
                <Badge className={ok ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}>
                  {ok ? '✓ Yes' : '✗ No'}
                </Badge>
              </div>
            ))}
            <div className="flex items-center justify-between">
              <span style={{ color: 'var(--text-slate-600)' }}>Saved sensor name</span>
              <span className="font-mono text-xs" style={{ color: 'var(--text-slate-800)' }}>
                {bleInfo.savedSensor || '(none)'}
              </span>
            </div>
          </div>

          {/* Log entries */}
          {logs.length === 0 ? (
            <p className="text-sm text-center py-4" style={{ color: 'var(--text-slate-400)' }}>
              No BLE events logged yet. Events appear here after interacting with a fridge-item stop card.
            </p>
          ) : (
            <div className="space-y-1 max-h-72 overflow-y-auto pr-1">
              {logs.map((entry, i) => (
                <div
                  key={i}
                  className="flex flex-col gap-0.5 p-2 rounded-md border cursor-pointer hover:bg-slate-50"
                  style={{ borderColor: 'var(--border-slate-100)' }}
                  onClick={() => setExpandedEntry(expandedEntry === i ? null : i)}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono" style={{ color: 'var(--text-slate-400)', minWidth: '54px' }}>
                      {formatTs(entry.ts)}
                    </span>
                    <Badge className={`text-xs ${LEVEL_STYLES[entry.level] || 'bg-slate-100 text-slate-700'}`}>
                      {entry.level}
                    </Badge>
                    <span className="text-xs flex-1" style={{ color: 'var(--text-slate-800)' }}>{entry.message}</span>
                  </div>
                  {expandedEntry === i && entry.detail && (
                    <pre className="text-xs mt-1 p-2 rounded bg-slate-100 overflow-x-auto whitespace-pre-wrap break-all" style={{ color: 'var(--text-slate-700)' }}>
                      {entry.detail}
                    </pre>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}