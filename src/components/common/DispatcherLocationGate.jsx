import React, { useEffect, useRef, useState, useCallback } from 'react';
import { MapPinOff, MapPin, RefreshCw } from 'lucide-react';
import { useDevice } from '@/components/utils/DeviceContext';
import { useAppData } from '@/components/utils/AppDataContext';
import { userHasRole, isAppOwner } from '@/components/utils/userRoles';
import { haversineKm } from '@/components/utils/geoUtils';

/**
 * DispatcherLocationGate — mobile-only geo-fence for dispatcher accounts.
 *
 * Owner-requested (Sep 15, 2026): if a dispatcher opens the app on a device
 * with a GPS fix (physical mobile phone) and they are NOT near one of their
 * assigned stores, block the whole UI behind a full-screen overlay.
 *
 * Scope / fail-open design (per owner's decisions):
 *  - Only runs on physical phones (deviceType === 'Mobile'). Tablets
 *    (Surface units at the stores) and desktops are never gated and never
 *    asked for location — "no GPS fix = most likely a non-mobile device".
 *  - Exempts driver, admin, and app-owner roles (dual-role users keep full
 *    access so driving isn't broken).
 *  - A fix only LOCKS when it confidently proves the user is off-site:
 *    (distance to nearest assigned store - fix accuracy) > LOCK_RADIUS_M.
 *    Low-accuracy fixes (WiFi/indoors) can never confidently prove
 *    off-site, so they fail open rather than locking someone standing in
 *    the store.
 *  - Requires CONFIRM_LOCK_STREAK consecutive confident off-site reads
 *    (each at least MIN_EVAL_INTERVAL_MS apart) before locking — a single
 *    glitchy fix can't lock anyone out.
 *  - Permission denied / position unavailable / no fix at all → fail open
 *    (no gate). Re-locks automatically the moment fixes return confident
 *    off-site results.
 *  - Unlock is immediate on any fix that is not confidently off-site.
 */

const LOCK_RADIUS_M = 300;          // how far from every assigned store before locking
const MIN_EVAL_INTERVAL_MS = 8000;  // min spacing between counted streak evaluations
const CONFIRM_LOCK_STREAK = 2;      // consecutive confident off-site reads required to lock

const formatDistance = (meters) => {
  if (!Number.isFinite(meters)) return '--';
  if (meters >= 1000) return `${(meters / 1000).toFixed(1)} km`;
  return `${Math.max(1, Math.round(meters))} m`;
};

export default function DispatcherLocationGate() {
  const { deviceType } = useDevice();
  const { currentUser, stores } = useAppData();

  const [locked, setLocked] = useState(false);
  const [lockInfo, setLockInfo] = useState(null); // { storeName, distanceM }
  const [isRechecking, setIsRechecking] = useState(false);

  const streakRef = useRef(0);
  const lastEvalAtRef = useRef(0);
  const lockInfoRef = useRef(null);

  // ── Eligibility ──────────────────────────────────────────────────────────
  const isEligible = !!(
    currentUser &&
    deviceType === 'Mobile' &&
    userHasRole(currentUser, 'dispatcher') &&
    !userHasRole(currentUser, 'driver') &&
    !userHasRole(currentUser, 'admin') &&
    !isAppOwner(currentUser) &&
    Array.isArray(currentUser.store_ids) && currentUser.store_ids.length > 0
  );

  const assignedStoresRef = useRef([]);
  useEffect(() => {
    if (!isEligible || !Array.isArray(stores)) { assignedStoresRef.current = []; return; }
    assignedStoresRef.current = stores.filter(
      (s) => s && currentUser.store_ids.includes(s.id)
        && Number.isFinite(Number(s.latitude)) && Number.isFinite(Number(s.longitude))
    );
  }, [isEligible, stores, currentUser]);

  // ── Fix evaluation ───────────────────────────────────────────────────────
  const evaluatePosition = useCallback((coords) => {
    const assigned = assignedStoresRef.current;
    if (!assigned.length) return; // no geo-coordinated assigned stores → fail open

    const lat = Number(coords.latitude);
    const lon = Number(coords.longitude);
    const accuracy = Number.isFinite(Number(coords.accuracy)) ? Number(coords.accuracy) : 0;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

    // Nearest assigned store (straight-line)
    let nearest = null;
    let nearestDistM = Infinity;
    for (const store of assigned) {
      const dKm = haversineKm(lat, lon, Number(store.latitude), Number(store.longitude));
      const dM = dKm * 1000;
      if (dM < nearestDistM) { nearestDistM = dM; nearest = store; }
    }

    const info = { storeName: nearest?.name || 'your assigned store', distanceM: nearestDistM };
    lockInfoRef.current = info;

    // Confident off-site only when even the BEST case (distance minus accuracy
    // radius) puts them beyond the lock radius. Poor-accuracy fixes fail open.
    const isConfidentOffSite = (nearestDistM - accuracy) > LOCK_RADIUS_M;

    const now = Date.now();
    if (!isConfidentOffSite) {
      streakRef.current = 0;
      setLocked(false);
      return;
    }

    // Streak confirmation, min-interval spaced
    if (now - lastEvalAtRef.current < MIN_EVAL_INTERVAL_MS) return;
    lastEvalAtRef.current = now;
    streakRef.current += 1;

    if (streakRef.current >= CONFIRM_LOCK_STREAK) {
      setLockInfo(info);
      setLocked(true);
    }
  }, []);

  // ── Watch while eligible ────────────────────────────────────────────────
  useEffect(() => {
    if (!isEligible) {
      streakRef.current = 0;
      setLocked(false);
      setLockInfo(null);
      lockInfoRef.current = null;
      return;
    }
    if (typeof navigator === 'undefined' || !navigator.geolocation) return;

    const watchId = navigator.geolocation.watchPosition(
      (pos) => evaluatePosition(pos.coords),
      (err) => {
        // PERMISSION_DENIED / POSITION_UNAVAILABLE / TIMEOUT → fail open.
        // Never lock without a fix (owner: "no GPS fix = non-mobile device").
        console.log('[DispatcherLocationGate] geolocation error — failing open:', err?.code, err?.message);
      },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 30000 }
    );

    return () => navigator.geolocation.clearWatch(watchId);
  }, [isEligible, evaluatePosition]);

  // ── Manual recheck (button on the overlay) ───────────────────────────────
  const handleRecheck = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return;
    setIsRechecking(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => { evaluatePosition(pos.coords); setIsRechecking(false); },
      () => setIsRechecking(false),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  }, [evaluatePosition]);

  if (!locked) return null;

  return (
    <div
      className="fixed inset-0 z-[21000] flex items-center justify-center p-4"
      style={{ background: 'rgba(15, 23, 42, 0.97)' }}
    >
      <div className="w-full max-w-sm rounded-2xl bg-slate-800 border border-slate-700 p-6 text-center shadow-2xl">
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-red-500/15">
          <MapPinOff className="h-8 w-8 text-red-400" />
        </div>

        <h2 className="mb-2 text-xl font-bold text-white">Location Restricted</h2>

        <p className="mb-3 text-sm text-slate-300">
          You're not at one of your assigned store locations. RxDeliver access on
          this device is limited to your assigned stores.
        </p>

        {lockInfo && (
          <div className="mb-4 rounded-lg bg-slate-900/80 px-4 py-3 text-sm">
            <div className="flex items-center justify-center gap-2 text-slate-200">
              <MapPin className="h-4 w-4 text-emerald-400" />
              <span className="font-semibold">{lockInfo.storeName}</span>
            </div>
            <div className="mt-1 text-slate-400">
              {formatDistance(lockInfo.distanceM)} away
            </div>
          </div>
        )}

        <button
          type="button"
          onClick={handleRecheck}
          disabled={isRechecking}
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-emerald-700 disabled:opacity-60"
        >
          <RefreshCw className={`h-4 w-4 ${isRechecking ? 'animate-spin' : ''}`} />
          {isRechecking ? 'Checking…' : 'Recheck location'}
        </button>

        <p className="mt-4 text-xs text-slate-500">
          Access resumes automatically when you're back at an assigned store.
        </p>
      </div>
    </div>
  );
}
