/**
 * LiveDriverLocationMarker
 *
 * The driver's OWN blue-dot marker on the PRIMARY device.
 *
 * With the Sep 18 2026 battery work, native GPS fixes arrive every ~5s
 * (minIntervalMs 5000 + 10m distance filter).
 *
 * OWNER DIRECTIVE Oct 22 2026 — RAW GPS MODE: the predictive glide (LEAD
 * along the road geometry / SETTLE back on missed fixes) is RETIRED for the
 * own-dot. It overshot when the driver suddenly slowed and lagged when they
 * suddenly sped up. The dot now shows the driver's ACTUAL GPS position only:
 * each real fix eases the dot from its current displayed position to the
 * fresh fix over a short ~0.8s glide (owner follow-up Oct 22: a glide spanning
 * the full fix interval trailed 5s behind the driver; the quick glide lands
 * on the fresh fix almost immediately), then it parks exactly
 * on the fix until the next one lands (see liveMarkerInterpolator.js RAW
 * mode). It can never run ahead of the driver and never disagrees by more
 * than one fix interval.
 *
 *   - FALLBACK: if live fixes stop for STALE_FIX_MS (tracker off), the marker
 *     reverts to declarative prop positions (server-synced coords) — exactly
 *     the pre-interpolation behavior for secondary devices / tracker-off.
 *
 * While live fixes flow, React NEVER re-renders the marker position: the
 * position prop is frozen at the first live fix and a rAF loop drives
 * marker.setLatLng() directly, so 20fps animation costs zero Dashboard
 * re-renders. GPS cadence and server uploads are untouched (5s fixes / 15s
 * AppUser writes — no battery change). The driverPositionUpdated events only
 * fire on the primary device (locationTracker); peer/shared markers keep
 * their own trail-mode interpolation in DriverLocationMarkers.jsx.
 */

import React, { useEffect, useRef, useState } from "react";
import { Marker, Popup } from "react-leaflet";
import { format } from "date-fns";
import { createLiveLocationDot } from "./MapIcons";
import { createLiveMarkerInterpolator } from "../utils/liveMarkerInterpolator";

const FRAME_MIN_MS = 50;    // cap repaints at ~20fps — plenty smooth for a dot
const STALE_FIX_MS = 15000; // no fix for 15s → back to declarative prop mode

const LiveDriverLocationMarker = React.memo(function LiveDriverLocationMarker({
  marker,
  pathCoords,
  onMarkerClick,
}) {
  const markerRef = useRef(null);
  const interpRef = useRef(null);
  const rafRef = useRef(0);
  const lastPaintRef = useRef(0);
  const frozenRef = useRef(null);
  const liveRef = useRef(false);
  const [isLive, setIsLive] = useState(false);

  // RAW mode (owner Oct 22): no road-geometry following — the path feed is
  // kept wired for a quick revert but raw mode ignores it.
  if (!interpRef.current) interpRef.current = createLiveMarkerInterpolator({ mode: "raw" });

  // Feed road geometry for polyline-follow interpolation (raw mode ignores).
  useEffect(() => {
    interpRef.current.setPath(pathCoords || null);
  }, [pathCoords]);

  // Fix intake — driverPositionUpdated fires per native GPS fix (primary device).
  useEffect(() => {
    const interp = interpRef.current;
    const onFix = (event) => {
      const { latitude, longitude, timestamp } = event.detail || {};
      if (!latitude || !longitude) return;
      const ts = timestamp ? new Date(timestamp).getTime() : Date.now();
      interp.onFix(latitude, longitude, Number.isFinite(ts) ? ts : Date.now());
      if (!liveRef.current) {
        liveRef.current = true;
        setIsLive(true);
      }
    };
    window.addEventListener("driverPositionUpdated", onFix);
    return () => window.removeEventListener("driverPositionUpdated", onFix);
  }, []);

  // rAF animation loop — only runs while live fixes flow.
  useEffect(() => {
    if (!isLive) return;
    const interp = interpRef.current;
    const loop = () => {
      rafRef.current = requestAnimationFrame(loop);
      const now = Date.now();
      // Tracker stopped / stale → revert to declarative prop mode.
      if (now - interp.getLastFixTime() > STALE_FIX_MS) {
        liveRef.current = false;
        setIsLive(false);
        return;
      }
      if (now - lastPaintRef.current < FRAME_MIN_MS) return;
      lastPaintRef.current = now;
      const p = interp.getDisplayPosition(now);
      if (p && markerRef.current) markerRef.current.setLatLng([p.latitude, p.longitude]);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [isLive]);

  // Freeze the declarative position while live mode drives the dot — React
  // re-renders (marker prop changes per fix) must NOT fight the rAF loop.
  if (isLive && !frozenRef.current) {
    frozenRef.current = [marker.latitude, marker.longitude];
  }
  if (!isLive) {
    frozenRef.current = null;
  }
  const position = isLive ? frozenRef.current : [marker.latitude, marker.longitude];

  return (
    <Marker
      key="current-driver-location"
      ref={markerRef}
      position={position}
      icon={createLiveLocationDot()}
      zIndexOffset={6000}
      pane="driverMarkerPane"
      eventHandlers={{ click: () => onMarkerClick?.(marker, "driver") }}
    >
      <Popup autoPan={false} closeButton={false} offset={[0, -10]} className="custom-popup">
        <div className="min-w-[150px]">
          <div className="font-semibold text-xs">Your Location</div>
          {marker.timestamp && (
            <div className="text-[11px] text-gray-600 dark:text-slate-400">
              Updated: {format(new Date(marker.timestamp), "HH:mm:ss")}
            </div>
          )}
        </div>
      </Popup>
    </Marker>
  );
});

export default LiveDriverLocationMarker;
