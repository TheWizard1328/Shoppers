import React, { useEffect, useState } from 'react';

/**
 * MapNorthCompass — the two-pointed Google-Maps-style north needle that rides
 * directly above the map-cycle FAB.
 *
 * OWNER REQUEST (Nov 25 2026): "add the two pointed compass style spinner above
 * the map cycle FAB that only appears when immersive mode is active and the map
 * cycle FAB is in Phase 2 … similar to the Google maps diamond shaped two pointed
 * compass icon with the red half pointing North and the non red half pointing
 * South so that when the map is North up this little pointer points the red
 * upward and once it zooms into the driver's next turn it points North still
 * based on the rotational direction of the map."
 *
 * The map applies its rotation through map.setBearing() (see DeliveryMap's
 * heads-up effect), which also publishes the live angle. A screen angle of
 * north is the negative of the map's bearing, so the needle simply rotates by
 * -bearing: 0° = red straight up (north-up map), and during a turn preview the
 * red tip swings to keep pointing at true north.
 *
 * The readout is polled at 100ms (the bearing is latched per turn, so this is
 * cheap) with a short CSS ease so a bearing change reads as a swing, not a jump.
 */
const POLL_MS = 100;

function readBearing() {
  try {
    if (typeof window === 'undefined') return 0;
    if (typeof window.__getMapBearing === 'function') {
      const v = Number(window.__getMapBearing());
      if (Number.isFinite(v)) return v;
    }
    const fallback = Number(window.__mapBearing);
    return Number.isFinite(fallback) ? fallback : 0;
  } catch {
    return 0;
  }
}

export default function MapNorthCompass({ visible = false, bottomPx = 0, rightPx = 12 }) {
  const [bearing, setBearing] = useState(() => readBearing());

  useEffect(() => {
    if (!visible) return undefined;
    setBearing(readBearing());
    const timer = setInterval(() => setBearing(readBearing()), POLL_MS);
    return () => clearInterval(timer);
  }, [visible]);

  if (!visible) return null;

  // Screen angle of north = -bearing (the map is rotated clockwise by `bearing`).
  const rotation = -bearing;

  return (
    <div
      className="absolute z-[1000] pointer-events-none"
      style={{ bottom: `${bottomPx}px`, right: `${rightPx}px` }}
      aria-hidden="true">
      <div className="w-9 h-9 rounded-full bg-white/95 dark:bg-slate-900/95 border border-slate-200 dark:border-slate-700 shadow-lg flex items-center justify-center">
        <svg
          viewBox="0 0 36 36"
          className="w-6 h-6"
          style={{ transform: `rotate(${rotation}deg)`, transition: 'transform 180ms ease-out' }}>
          {/* Diamond needle: red half = north, slate half = south. */}
          <polygon points="18,3 23,18 13,18" fill="#ef4444" />
          <polygon points="18,33 23,18 13,18" fill="#cbd5e1" />
          <circle cx="18" cy="18" r="1.6" fill="#0f172a" opacity="0.55" />
        </svg>
      </div>
    </div>
  );
}
