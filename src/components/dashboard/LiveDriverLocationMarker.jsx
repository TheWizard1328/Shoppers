/**
 * LiveDriverLocationMarker
 *
 * The driver's OWN blue-dot marker on the PRIMARY device.
 *
 * With the Sep 18 2026 battery work, native GPS fixes arrive every ~5s
 * (minIntervalMs 5000 + 10m distance filter) instead of every 1s. A raw 5s
 * cadence would make the dot step, and interpolating BETWEEN fixes trails
 * the car by a full interval (Sep 21 2026 driver report). So the marker
 * renders PREDICTIVELY (see liveMarkerInterpolator.js):
 *
 *   - LEAD: the dot starts at the latest fix and glides FORWARD along the
 *     current-leg road geometry (or the fix-pair bearing off-route) at the
 *     measured speed — it rides at the driver's TRUE current position with
 *     zero lag, rounding upcoming turns with the route. Each new fix
 *     re-anchors the glide smoothly; corrections ease in, never snap.
 *   - SETTLE: if the expected next fix never arrives (slowing / stopped at a
 *     light, where the 10m filter suppresses fixes), the dot eases back to
 *     the last real fix and parks on the driver.
 *   - FALLBACK: if live fixes stop for STALE_FIX_MS (tracker off), the marker
 *     reverts to declarative prop positions (server-synced coords) — exactly
 *     the pre-interpolation behavior for secondary devices / tracker-off.
 *
 * While live fixes flow, React NEVER re-renders the marker position: the
 * position prop is frozen at the first live fix and a rAF loop drives
 * marker.setLatLng() directly, so 20fps animation costs zero Dashboard
 * re-renders. The driverPositionUpdated events only fire on the primary
 * device (locationTracker), so this never affects peer-driver markers.
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

  if (!interpRef.current) interpRef.current = createLiveMarkerInterpolator();

  // Feed road geometry for polyline-follow interpolation.
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
