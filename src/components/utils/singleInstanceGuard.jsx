/**
 * SINGLE INSTANCE GUARD (owner diagnosis Nov 5 2026)
 *
 * "the reason we were having issues with the Kingsway tablet was because they
 *  had two instances of the app opened which means every time an app restart
 *  happened or data was updated it was collecting it twice. We need to figure
 *  out a way to make it so that there's only one instance per device running."
 *
 * Two copies of the app on one machine means two of EVERY periodic worker:
 * two location pollers, two priority-sync passes, two background sync loops and
 * two realtime sockets. Each of them writes and reads independently, so the
 * device burns the platform's request budget twice as fast and its own writes
 * echo back as "new" data to the other copy. That is what produced the Kingsway
 * 429 storm while nobody was even driving.
 *
 * HOW IT WORKS (no server, no permissions):
 *  - Every page load generates a random instance id and tries to CLAIM a
 *    localStorage lock (`rxdeliver_single_instance_v1`).
 *  - A lock older than STALE_MS (14s) is dead and is claimed silently, so a
 *    crashed/force-closed tab can never lock the machine out forever.
 *  - The leader refreshes the lock every HEARTBEAT_MS (4s).
 *  - A second instance finds a fresh lock, so it does NOT mount the app at all:
 *    it shows "RxDeliver is already open on this device" and stops. Nothing is
 *    started, so nothing is collected twice.
 *  - Any instance can take over on purpose ("Use this window"): it writes its
 *    own id, and the previous instance demotes itself to the blocked screen on
 *    the storage event, releasing its workers' page before it can keep syncing.
 *  - On unload the leader removes its lock so the next launch starts instantly.
 *
 * The guard is deliberately per BROWSER PROFILE (localStorage), which is the
 * same boundary the app uses for device identity: two different machines, or
 * two different browser profiles, are two devices and both keep running.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';

const LOCK_KEY = 'rxdeliver_single_instance_v1';
const CHANNEL_NAME = 'rxdeliver_single_instance_channel';
const HEARTBEAT_MS = 2500;
const STALE_MS = 8000;

// ── NATIVE (Android APK / iOS) ENTITLEMENT ──────────────────────────────────
// OWNER REPORT (Nov 6 2026): "the guard for running 2 instances... we need to
// add a guard for the Android APK. It is incapable of running 2 instances at
// the same time. But a few times tonight I closed the app and reopened it and
// it took 5 tries of closing and opening before it would stop showing the
// multiple instance message." Android never runs two copies of an activity in
// one task, so the lock has nothing to protect there — but the WebView often
// dies without a pagehide/beforeunload, leaving the lock held until it goes
// stale (14s), which is exactly the reopen-fails-five-times loop. A native
// cold start therefore skips the lock entirely.
const isNativeShell = () => {
  try { return !!(typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.()); } catch { return false; }
};
const BLOCKED_RECHECK_MS = 3000;

const newInstanceId = () => {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  } catch (_) { /* fall through */ }
  return `inst-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

const readLock = () => {
  try {
    const raw = localStorage.getItem(LOCK_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.id) return null;
    return parsed;
  } catch (_) {
    return null;
  }
};

const writeLock = (id, extra = {}) => {
  try {
    localStorage.setItem(LOCK_KEY, JSON.stringify({ id, ts: Date.now(), ...extra }));
  } catch (_) { /* private mode / quota — the guard degrades to no-op */ }
};

const clearLockIfMine = (id) => {
  try {
    const cur = readLock();
    if (cur && cur.id === id) localStorage.removeItem(LOCK_KEY);
  } catch (_) { /* ignore */ }
};

const isFresh = (lock) => !!lock && typeof lock.ts === 'number' && (Date.now() - lock.ts) < STALE_MS;

/**
 * Returns { status, holderLabel, takeOver, instanceId }.
 * status: 'checking' | 'leader' | 'blocked'
 */
export function useSingleInstanceGuard() {
  const nativeShell = isNativeShell();
  const idRef = useRef(null);
  if (!idRef.current) idRef.current = newInstanceId();
  const [status, setStatus] = useState('checking');
  const [holderLabel, setHolderLabel] = useState(null);
  const statusRef = useRef('checking');
  const channelRef = useRef(null);

  const setBoth = useCallback((next) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const describeHolder = (lock) => {
    if (!lock) return 'another window';
    const when = lock.ts ? new Date(lock.ts).toLocaleTimeString() : '';
    return when ? `another window (last active ${when})` : 'another window';
  };

  // Try to become the leader. Returns true on success.
  const tryClaim = useCallback(({ force = false } = {}) => {
    const me = idRef.current;
    const cur = readLock();
    if (!force && isFresh(cur) && cur.id !== me) {
      setHolderLabel(describeHolder(cur));
      setBoth('blocked');
      return false;
    }
    writeLock(me, force ? { force: true } : {});
    // Verify: a racing tab may have written after us.
    const after = readLock();
    if (after && after.id !== me) {
      setHolderLabel(describeHolder(after));
      setBoth('blocked');
      return false;
    }
    setHolderLabel(null);
    setBoth('leader');
    return true;
  }, [setBoth]);

  useEffect(() => {
    // NATIVE SHELL: Android/iOS cannot host two instances, so skip the lock
    // completely — a WebView killed without pagehide must never leave the
    // reopen blocked (owner: "it took 5 tries of closing and opening").
    if (nativeShell) {
      const cur = readLock();
      if (cur && cur.id !== idRef.current) clearLockIfMine(cur.id);
      setHolderLabel(null);
      setBoth('leader');
      return undefined;
    }
    // First attempt is synchronous and cheap: decides before the app mounts.
    tryClaim();

    let hb = null;
    const startHeartbeat = () => {
      if (hb) return;
      hb = setInterval(() => {
        if (statusRef.current !== 'leader') return;
        const cur = readLock();
        if (cur && cur.id !== idRef.current) {
          // Someone forced a takeover — stand down immediately.
          setHolderLabel(describeHolder(cur));
          setBoth('blocked');
          return;
        }
        writeLock(idRef.current);
      }, HEARTBEAT_MS);
    };
    const stopHeartbeat = () => { if (hb) { clearInterval(hb); hb = null; } };
    startHeartbeat();

    // Cross-tab notifications for instant handoff.
    try {
      if (typeof BroadcastChannel !== 'undefined') {
        channelRef.current = new BroadcastChannel(CHANNEL_NAME);
        channelRef.current.onmessage = (ev) => {
          const msg = ev?.data;
          if (!msg || msg.id === idRef.current) return;
          if (msg.type === 'claimed' && statusRef.current === 'leader') {
            setHolderLabel(describeHolder({ ts: Date.now(), ...msg }));
            setBoth('blocked');
          }
          if (msg.type === 'released' && statusRef.current === 'blocked') tryClaim();
        };
      }
    } catch (_) { channelRef.current = null; }

    const onStorage = (ev) => {
      if (ev.key !== LOCK_KEY) return;
      if (statusRef.current === 'leader') {
        const cur = readLock();
        if (cur && cur.id !== idRef.current) {
          setHolderLabel(describeHolder(cur));
          setBoth('blocked');
        }
        return;
      }
      // Blocked: the lock may have gone stale or been released.
      tryClaim();
    };
    window.addEventListener('storage', onStorage);

    // Blocked instances re-check on a slow timer: a crashed tab never posts a
    // "released" event, and the machine must not be locked out by a dead tab.
    const recheck = setInterval(() => {
      if (statusRef.current !== 'blocked') return;
      const cur = readLock();
      if (!isFresh(cur)) tryClaim();
    }, BLOCKED_RECHECK_MS);

    const onUnload = () => { clearLockIfMine(idRef.current); };
    window.addEventListener('beforeunload', onUnload);
    window.addEventListener('pagehide', onUnload);

    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('beforeunload', onUnload);
      window.removeEventListener('pagehide', onUnload);
      clearInterval(recheck);
      stopHeartbeat();
      try { channelRef.current?.close?.(); } catch (_) {}
      channelRef.current = null;
      clearLockIfMine(idRef.current);
    };
  }, [tryClaim, setBoth]);

  // Leader status can also arrive after the heartbeat block above, so keep the
  // heartbeat in sync with it.
  useEffect(() => {
    if (status !== 'leader') return undefined;
    const iv = setInterval(() => {
      const cur = readLock();
      if (cur && cur.id !== idRef.current) {
        setHolderLabel(describeHolder(cur));
        setBoth('blocked');
      }
    }, HEARTBEAT_MS);
    return () => clearInterval(iv);
  }, [status, setBoth]);

  const takeOver = useCallback(() => {
    const ok = tryClaim({ force: true });
    if (ok) {
      try { channelRef.current?.postMessage?.({ type: 'claimed', id: idRef.current }); } catch (_) {}
    }
    return ok;
  }, [tryClaim]);

  return { status, holderLabel, takeOver, instanceId: idRef.current };
}

export function SingleInstanceNotice({ holderLabel, onTakeOver }) {
  return (
    <div className="fixed inset-0 z-[100000] flex items-center justify-center p-5 bg-slate-900 text-white">
      <div className="w-full max-w-sm text-center space-y-4">
        <div className="text-4xl">🪟</div>
        <h1 className="text-lg font-semibold">RxDeliver is already open on this device</h1>
        <p className="text-sm text-slate-300">
          Only one copy may run at a time, otherwise every route update and location
          check is collected twice and the app gets rate limited.
        </p>
        <p className="text-xs text-slate-400">Detected: {holderLabel || 'another window'}</p>
        <button
          type="button"
          onClick={onTakeOver}
          className="w-full h-11 rounded-lg bg-emerald-600 hover:bg-emerald-700 font-semibold touch-manipulation"
        >
          Use this window instead
        </button>
        <p className="text-xs text-slate-400">
          Close the other tab/window first if you just want to go back to it.
        </p>
      </div>
    </div>
  );
}

/**
 * Wrap the app: the blocked instance renders the notice INSTEAD of the app, so
 * none of its background workers (pollers, sync loops, sockets) ever start.
 */
export function SingleInstanceGate({ children }) {
  const { status, holderLabel, takeOver } = useSingleInstanceGuard();
  if (status === 'leader') return children;
  if (status === 'checking') return null;
  return <SingleInstanceNotice holderLabel={holderLabel} onTakeOver={takeOver} />;
}

// Pure lock primitives, exported for verification tests.
export const __instanceLock = { readLock, writeLock, clearLockIfMine, isFresh, LOCK_KEY, STALE_MS };

export default SingleInstanceGate;
