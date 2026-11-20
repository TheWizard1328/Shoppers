import { useEffect, useMemo, useRef, useState } from 'react';
import { Satellite, WifiOff, WifiLow } from 'lucide-react';
import { connectionMonitor } from '../utils/connectionMonitor';
import { remoteLogger } from '../utils/remoteLogger';

const GPS_ACQUISITION_TIMEOUT_MS = 15000;

// MOMENTARY BLIPS ARE NOISE (owner report Nov 19 2026): the radio and the GPS
// drop for a second or two when the screen wakes, under a bridge, or on a cold
// start, and the old code painted a "Weak Connection" / "Weak GPS Lock" pill and
// wrote a warn row to RemoteLogEntry for every single one — which then filled
// the hourly digest with noise. A weak state must now PERSIST this long before
// it is shown or logged; anything shorter is dropped silently. Offline and
// no-lock are still reported immediately (they are real, and GPS already waits
// out its own acquisition timeout).
const WEAK_PERSIST_MS = 20000;

const connectionState = (health) => {
  if (!health?.isOnline || health?.quality === 'offline') return 'offline';
  if (health?.quality !== 'good') return 'weak';
  return 'good';
};

const eventForConnectionState = (state) =>
  state === 'offline' ? 'NETWORK_OFFLINE' : state === 'weak' ? 'NETWORK_WEAK' : 'NETWORK_RECOVERED';

const eventForGpsState = (state) =>
  state === 'lost' ? 'GPS_LOST' : state === 'weak' ? 'GPS_WEAK' : 'GPS_RECOVERED';

/**
 * Compact device-health badge. It reports connection and GPS state transitions
 * to the durable RemoteLogEntry buffer, which flushes when connectivity returns.
 */
export default function ConnectionRecoveryBanner({ currentUser = null }) {
  const [health, setHealth] = useState(() => connectionMonitor.getQuality());
  const [gpsHealth, setGpsHealth] = useState({ status: 'disabled', accuracy: null, error: null });
  // Committed (displayed) states — only advanced once a weak blip has proven
  // itself, so a 2-second dip never reaches the pill.
  const [netState, setNetState] = useState(() => connectionState(connectionMonitor.getQuality()));
  const connectionRef = useRef({ state: connectionState(connectionMonitor.getQuality()), since: Date.now() });
  const gpsRef = useRef({ state: 'disabled', since: Date.now() });
  const acquisitionTimerRef = useRef(null);
  const pendingNetworkRef = useRef(null);
  const pendingGpsRef = useRef(null);
  const weakNetworkTimerRef = useRef(null);
  const weakGpsTimerRef = useRef(null);

  const isDriver = Array.isArray(currentUser?.app_roles) && currentUser.app_roles.includes('driver');

  // LEAK FIX (Oct 22 2026, owner-approved perf fix 1): this effect previously
  // subscribed WITHOUT returning the unsubscribe — every re-render of Layout
  // (which re-renders on each deliveries/patients/appUsers state change) added
  // another permanent listener to connectionMonitor; over a shift the listener
  // set grew into the hundreds and every network state change ran all of them.
  useEffect(() => {
  const commitNetworkState = (nextState, nextHealth) => {
    const now = Date.now();
    const previous = connectionRef.current;
    if (previous.state === nextState) return;

    const durationMs = previous.state ? now - previous.since : 0;
    if (nextState !== 'good' || (previous.state && previous.state !== 'good')) {
      remoteLogger.event(
        eventForConnectionState(nextState),
        nextState === 'offline' ? 'Device has no network connection'
          : nextState === 'weak' ? 'Device network connection is weak'
            : 'Device network connection recovered',
        {
          category: 'connectivity',
          state: nextState,
          previous_state: previous.state,
          previous_state_duration_ms: durationMs,
          quality: nextHealth.quality,
          effective_type: nextHealth.effectiveType,
          downlink_mbps: nextHealth.downlink,
          rtt_ms: nextHealth.rtt,
          api_response_ms: nextHealth.avgResponseTime,
          last_error_type: nextHealth.lastErrorType,
        },
        nextState === 'good' ? 'info' : 'warn'
      );
    }
    connectionRef.current = { state: nextState, since: now };
    setNetState(nextState);
  };

  const _unsub = connectionMonitor.subscribe((nextHealth) => {
    setHealth(nextHealth);
    const nextState = connectionState(nextHealth);

    if (nextState === 'weak') {
      // Hold the blip: arm one timer, keep the newest reading, and commit only
      // if the connection is STILL weak when it fires.
      pendingNetworkRef.current = nextHealth;
      if (!weakNetworkTimerRef.current) {
        weakNetworkTimerRef.current = setTimeout(() => {
          weakNetworkTimerRef.current = null;
          const pendingHealth = pendingNetworkRef.current;
          if (!pendingHealth) return;
          commitNetworkState('weak', pendingHealth);
        }, WEAK_PERSIST_MS);
      }
      return;
    }

    if (weakNetworkTimerRef.current) {
      clearTimeout(weakNetworkTimerRef.current);
      weakNetworkTimerRef.current = null;
    }
    pendingNetworkRef.current = null;
    commitNetworkState(nextState, nextHealth);
  });
  return () => {
    _unsub();
    if (weakNetworkTimerRef.current) clearTimeout(weakNetworkTimerRef.current);
    weakNetworkTimerRef.current = null;
  };
  }, []);

  useEffect(() => {
    const clearAcquisitionTimer = () => {
      if (acquisitionTimerRef.current) clearTimeout(acquisitionTimerRef.current);
      acquisitionTimerRef.current = null;
    };

    const commitGpsState = (next, detail = {}) => {
      const now = Date.now();
      const previous = gpsRef.current;
      setGpsHealth({ status: next, accuracy: detail.accuracy ?? null, error: detail.error || null });
      if (previous.state === next) return;

      const durationMs = now - previous.since;
      if (next === 'disabled') {
        gpsRef.current = { state: next, since: now };
        return;
      }
      if (next !== 'good' || ['weak', 'lost'].includes(previous.state)) {
        remoteLogger.event(
          eventForGpsState(next),
          next === 'lost' ? 'Device has no GPS lock'
            : next === 'weak' ? 'Device GPS lock is weak'
              : 'Device GPS lock recovered',
          {
            category: 'gps',
            state: next,
            previous_state: previous.state,
            previous_state_duration_ms: durationMs,
            accuracy_m: detail.accuracy ?? null,
            error: detail.error || null,
            error_code: detail.code ?? null,
            source: detail.source || null,
          },
          next === 'good' ? 'info' : 'warn'
        );
      }
      gpsRef.current = { state: next, since: now };
    };

    // A momentary weak lock (screen wake, underpass, cold start) is held back
    // until it has lasted WEAK_PERSIST_MS, so neither the pill nor the log sees it.
    const applyGpsState = (next, detail = {}) => {
      const now = Date.now();
      if (next === 'weak') {
        pendingGpsRef.current = detail;
        if (!weakGpsTimerRef.current) {
          weakGpsTimerRef.current = setTimeout(() => {
            weakGpsTimerRef.current = null;
            const pendingDetail = pendingGpsRef.current;
            if (!pendingDetail) return;
            commitGpsState('weak', pendingDetail);
          }, WEAK_PERSIST_MS);
        }
        return;
      }
      if (weakGpsTimerRef.current) {
        clearTimeout(weakGpsTimerRef.current);
        weakGpsTimerRef.current = null;
      }
      pendingGpsRef.current = null;
      void now;
      commitGpsState(next, detail);
    };

    const onGpsHealth = (event) => {
      const detail = event?.detail || {};
      if (detail.status === 'searching') {
        clearAcquisitionTimer();
        gpsRef.current = { state: 'searching', since: Date.now() };
        setGpsHealth({ status: 'searching', accuracy: null, error: null });
        acquisitionTimerRef.current = setTimeout(() => {
          if (typeof document !== 'undefined' && document.hidden) return;
          applyGpsState('lost', { ...detail, error: 'GPS acquisition timed out' });
        }, GPS_ACQUISITION_TIMEOUT_MS);
        return;
      }
      clearAcquisitionTimer();
      applyGpsState(detail.status || 'lost', detail);
    };

    window.addEventListener('gpsHealthChanged', onGpsHealth);
    return () => {
      clearAcquisitionTimer();
      if (weakGpsTimerRef.current) clearTimeout(weakGpsTimerRef.current);
      weakGpsTimerRef.current = null;
      window.removeEventListener('gpsHealthChanged', onGpsHealth);
    };
  }, []);

  const networkState = netState;
  const gpsState = isDriver ? gpsHealth.status : 'disabled';
  const networkIssue = networkState !== 'good';
  const gpsIssue = gpsState === 'weak' || gpsState === 'lost';

  const details = useMemo(() => [
    health.effectiveType ? `Network: ${health.effectiveType}` : null,
    health.rtt != null ? `RTT: ${health.rtt}ms` : null,
    health.avgResponseTime != null ? `API: ${health.avgResponseTime}ms` : null,
    gpsHealth.accuracy != null ? `GPS accuracy: ${Math.round(gpsHealth.accuracy)}m` : null,
    gpsHealth.error || null,
  ].filter(Boolean).join(' · '), [health, gpsHealth]);

  if (!networkIssue && !gpsIssue) return null;

  const networkLabel = networkState === 'offline' ? 'Off Line' : networkState === 'weak' ? 'Weak Connection' : null;
  const gpsLabel = gpsState === 'lost' ? 'No GPS Lock' : gpsState === 'weak' ? 'Weak GPS Lock' : null;
  const label = [networkLabel, gpsLabel].filter(Boolean).join(' · ');
  const isCritical = networkState === 'offline' || gpsState === 'lost';
  const Icon = networkIssue ? (networkState === 'offline' ? WifiOff : WifiLow) : Satellite;

  return (
    <div
      className="fixed left-1/2 z-[10002] -translate-x-1/2 pointer-events-none"
      style={{ top: 'calc(var(--app-inset-top) + 0.35rem)' }}
      role="status"
      aria-live="polite"
      title={details || label}
    >
      <div className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold shadow-md backdrop-blur-sm ${
        isCritical
          ? 'border-red-300 bg-red-600/95 text-white'
          : 'border-amber-300 bg-amber-500/95 text-slate-950'
      }`}>
        <Icon className="h-3.5 w-3.5 shrink-0" />
        <span className="whitespace-nowrap">{label}</span>
      </div>
    </div>
  );
}
