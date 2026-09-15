/**
 * useHeadingUpMode — Android Auto / Apple Maps style heading-up navigation for
 * Phase 2 (built Sep 14 2026, app-owner-only pilot).
 *
 * Instead of rotating Leaflet internals (fragile), we rotate the map CONTAINER
 * with a CSS transform and counter-rotate the few upright elements:
 *
 *   container (rotate: Rdeg, origin = driver dot's container point)
 *     ├── tiles / polylines / breadcrumbs → rotate WITH the map (correct — geographic)
 *     ├── marker icons / popups / tooltips → counter-rotated via CSS `rotate`
 *     │   property (independent of Leaflet's inline translate3d transform)
 *     └── control container (attribution) → counter-rotated around the same origin
 *
 * The container is OVERSCANNED to ~145% so rotated corners still show tiles
 * (Leaflet only loads tiles for its own unrotated viewport).
 *
 * Heading = course over ground from consecutive GPS fixes (no compass — phone
 * compasses drift badly in vehicles). Below ~2 m/s the last heading is held
 * (no spinning at red lights). 6° deadband on target updates, max 14°/tick
 * lerp toward the target for a glide instead of jumps.
 *
 * Input safety: while rotated, Leaflet's click/drag math is wrong in screen
 * space (it can't see our CSS rotation), so ANY real user gesture (drag or
 * pinch-zoom) snaps the map back to north-up and pauses auto-rotation for
 * 60s. In Phase 2 the map is gesture-locked anyway; unlocked interactions
 * always start from a north-up map, so Leaflet math is never used while
 * rotated.
 *
 * Gate (no toggle — hard pilot gate): app owner + driver role + mobile +
 * primary device + mapViewPhase 2 + live driver marker present.
 */
import { useEffect, useRef } from 'react';
import { isAppOwner, userHasRole } from '@/components/utils/userRoles';
import { haversineMeters } from '@/components/utils/geoUtils';

const OVERSCAN = 1.45;                 // container enlargement for rotated-corner tile coverage
const MIN_SPEED_MPS = 2.0;             // below this, hold last heading (red lights / at a door)
const MIN_MOVE_M = 4;                  // ignore sub-4m jitter fixes for bearing math
const HEADING_DEADBAND_DEG = 6;        // target only updates on ≥6° course changes
const MAX_TURN_PER_TICK_DEG = 14;      // lerp rate — glide, don't jump
const USER_GESTURE_PAUSE_MS = 60_000;  // after a gesture: snap north + hold 60s

const bearingDeg = (lat1, lon1, lat2, lon2) => {
  const rad = Math.PI / 180;
  const p1 = lat1 * rad, p2 = lat2 * rad, dl = (lon2 - lon1) * rad;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
};

const shortestDelta = (from, to) => {
  let d = (to - from) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
};

export function useHeadingUpMode({ map, mapReady, currentUser, isMobile, mapViewPhase, currentDriverMarker }) {
  const supported = typeof window !== 'undefined' && typeof CSS !== 'undefined'
    && typeof CSS.supports === 'function' && CSS.supports('rotate: 45deg');
  const eligible = supported && !!currentUser && !!isMobile && isAppOwner(currentUser)
    && userHasRole(currentUser, 'driver')
    && (typeof window === 'undefined' || window.__isPrimaryDevice === true);
  const active = eligible && mapViewPhase === 2 && !!currentDriverMarker?.latitude && !!currentDriverMarker?.longitude;

  const sRef = useRef({
    lastFix: null, targetDeg: null, displayDeg: 0, pausedUntil: 0, applied: false, saved: null,
  });
  // Keep the latest marker readable from the gesture handler (registered once per active period)
  const markerRef = useRef(currentDriverMarker);
  markerRef.current = currentDriverMarker;

  // ── Apply / tear down the overscan + class ────────────────────────────────
  useEffect(() => {
    if (!map || !mapReady) return;
    const container = map.getContainer();
    const s = sRef.current;

    if (active && !s.applied) {
      s.applied = true;
      s.saved = {
        position: container.style.position,
        width: container.style.width,
        height: container.style.height,
        left: container.style.left,
        top: container.style.top,
        rotate: container.style.rotate,
        transformOrigin: container.style.transformOrigin,
        transition: container.style.transition,
      };
      container.classList.add('heading-up-map');
      container.style.position = 'absolute';
      container.style.width = `${OVERSCAN * 100}%`;
      container.style.height = `${OVERSCAN * 100}%`;
      container.style.left = `${-((OVERSCAN - 1) * 50)}%`;
      container.style.top = `${-((OVERSCAN - 1) * 50)}%`;
      container.style.transition = 'rotate 1s ease-out';
      map.invalidateSize({ animate: false, pan: false });
    }

    if (!active && s.applied) {
      const sv = s.saved || {};
      container.classList.remove('heading-up-map');
      container.style.removeProperty('--hud-rot');
      container.style.removeProperty('--hud-origin');
      container.style.rotate = sv.rotate || '0deg';
      container.style.transformOrigin = sv.transformOrigin || '';
      container.style.transition = sv.transition || '';
      container.style.position = sv.position || '';
      container.style.width = sv.width || '100%';
      container.style.height = sv.height || '100%';
      container.style.left = sv.left || '';
      container.style.top = sv.top || '';
      map.invalidateSize({ animate: false, pan: false });
      s.applied = false;
      s.lastFix = null; s.targetDeg = null; s.displayDeg = 0; s.pausedUntil = 0; s.saved = null;
    }

    return () => {
      if (s.applied && (!active || !map)) {
        // unmount/phase-exit cleanup happens via the !active branch on the next
        // run; this guard covers hard unmount while active.
      }
    };
  }, [active, map, mapReady]);

  // ── Unmount safety: restore the container if we're still applied ──────────
  useEffect(() => {
    return () => {
      const s = sRef.current;
      if (!s.applied || !map) return;
      try {
        const container = map.getContainer();
        const sv = s.saved || {};
        container.classList.remove('heading-up-map');
        container.style.removeProperty('--hud-rot');
        container.style.removeProperty('--hud-origin');
        container.style.rotate = sv.rotate || '0deg';
        container.style.transformOrigin = sv.transformOrigin || '';
        container.style.transition = sv.transition || '';
        container.style.position = sv.position || '';
        container.style.width = sv.width || '100%';
        container.style.height = sv.height || '100%';
        container.style.left = sv.left || '';
        container.style.top = sv.top || '';
        map.invalidateSize({ animate: false, pan: false });
      } catch (_) { /* container already gone */ }
      s.applied = false;
    };
  }, [map]);

  // ── Gesture safety: snap north + pause on real user interaction ───────────
  useEffect(() => {
    if (!map || !active) return;
    const snapNorth = () => {
      const s = sRef.current;
      s.pausedUntil = Date.now() + USER_GESTURE_PAUSE_MS;
      s.displayDeg = 0;
      const container = map.getContainer();
      container.style.setProperty('--hud-rot', '0deg');
      container.style.rotate = '0deg';
    };
    const onZoomStart = () => {
      // Only react to REAL user gestures (GPS ticks re-fit constantly in Phase 2)
      const sinceGesture = Date.now() - (window._lastUserGestureStart || 0);
      if (sinceGesture < 500) snapNorth();
    };
    map.on('dragstart', snapNorth);
    map.on('zoomstart', onZoomStart);
    return () => {
      map.off('dragstart', snapNorth);
      map.off('zoomstart', onZoomStart);
    };
  }, [map, active]);

  // ── Per-GPS-tick heading + rotation update ─────────────────────────────────
  useEffect(() => {
    if (!active || !map) return;
    const s = sRef.current;
    const { latitude, longitude, timestamp } = currentDriverMarker;
    const t = timestamp ? new Date(timestamp).getTime() : Date.now();

    // Course over ground from consecutive fixes
    if (s.lastFix) {
      const distM = haversineMeters(s.lastFix.lat, s.lastFix.lon, latitude, longitude);
      const dt = Math.max((t - s.lastFix.t) / 1000, 0.001);
      if (distM >= MIN_MOVE_M && distM / dt >= MIN_SPEED_MPS) {
        const b = bearingDeg(s.lastFix.lat, s.lastFix.lon, latitude, longitude);
        if (s.targetDeg == null || Math.abs(shortestDelta(s.targetDeg, b)) >= HEADING_DEADBAND_DEG) {
          s.targetDeg = b;
        }
      }
    }
    s.lastFix = { lat: latitude, lon: longitude, t };

    // Glide toward the target heading
    if (s.targetDeg != null) {
      const d = shortestDelta(s.displayDeg, s.targetDeg);
      const step = Math.max(-MAX_TURN_PER_TICK_DEG, Math.min(MAX_TURN_PER_TICK_DEG, d));
      s.displayDeg = (s.displayDeg + step + 360) % 360;
    }

    const paused = Date.now() < s.pausedUntil;
    const deg = (!paused && s.targetDeg != null) ? s.displayDeg : 0;

    // Rotate around the driver dot's actual position in the (overscanned) container
    const container = map.getContainer();
    const p = map.latLngToContainerPoint([latitude, longitude]);
    container.style.setProperty('--hud-rot', `${deg}deg`);
    container.style.transformOrigin = `${p.x}px ${p.y}px`;
    container.style.setProperty('--hud-origin', `${p.x}px ${p.y}px`);
    container.style.rotate = `${deg}deg`;
  }, [currentDriverMarker, active, map]);
}

export default useHeadingUpMode;
