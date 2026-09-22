import { useEffect, useState } from 'react';
import { WifiOff, WifiLow } from 'lucide-react';
import { connectionMonitor } from '../utils/connectionMonitor';

/**
 * Compact connection badge.
 *
 * This intentionally performs no recovery fetch, cache purge, or full data
 * reload. Existing online listeners and the offline mutation processor replay
 * queued work when connectivity returns. The previous full-width banner could
 * obscure controls and its reconnect path cleared IndexedDB before refetching,
 * which violated the app's merge/upsert-only offline contract.
 */
export default function ConnectionRecoveryBanner() {
  const [health, setHealth] = useState(() => connectionMonitor.getQuality());

  useEffect(() => connectionMonitor.subscribe(setHealth), []);

  if (health.isOnline && health.quality === 'good') return null;

  const isOffline = !health.isOnline || health.quality === 'offline';
  const Icon = isOffline ? WifiOff : WifiLow;
  const label = isOffline ? 'Off Line' : 'Weak Connection';
  const details = [
    health.effectiveType ? `Network: ${health.effectiveType}` : null,
    health.rtt != null ? `RTT: ${health.rtt}ms` : null,
    health.avgResponseTime != null ? `API: ${health.avgResponseTime}ms` : null,
  ].filter(Boolean).join(' · ');

  return (
    <div
      className="fixed left-1/2 z-[10002] -translate-x-1/2 pointer-events-none"
      style={{ top: 'calc(env(safe-area-inset-top, 0px) + 0.35rem)' }}
      role="status"
      aria-live="polite"
      title={details || label}
    >
      <div className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold shadow-md backdrop-blur-sm ${
        isOffline
          ? 'border-red-300 bg-red-600/95 text-white'
          : 'border-amber-300 bg-amber-500/95 text-slate-950'
      }`}>
        <Icon className="h-3.5 w-3.5 shrink-0" />
        <span className="whitespace-nowrap">{label}</span>
      </div>
    </div>
  );
}
