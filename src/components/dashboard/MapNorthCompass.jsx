import React, { useEffect, useState } from 'react';
import { startDeviceCompass, requestCompassPermission, getCompassHeading } from '@/components/utils/deviceCompass';

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

export default function MapNorthCompass({ visible = false, alwaysShowWhenRotated = false, bottomPx = 0, rightPx = 12 }) {
  // OWNER REQUEST (Nov 26 2026): the needle is driven by the PHONE'S compass,
  // not the map's bearing, so it points at real north wherever the device is
  // facing. The map bearing is only a fallback for a device with no magnetometer
  // (or a refused iOS prompt), so the icon never freezes or lies.
  const [rotation, setRotation] = useState(0);
  const [source, setSource] = useState('map');

  useEffect(() => {
    // Android needs nothing; iOS needs one gesture, so the first touch anywhere
    // on the map page asks. A refusal simply leaves the map-bearing fallback.
    startDeviceCompass();
    const ask = () => { requestCompassPermission(); };
    try {
      window.addEventListener('pointerdown', ask, { once: true, capture: true });
      window.addEventListener('touchstart', ask, { once: true, capture: true, passive: true });
    } catch { /* no window */ }
    return () => {
      try {
        window.removeEventListener('pointerdown', ask, { capture: true });
        window.removeEventListener('touchstart', ask, { capture: true });
      } catch { /* no window */ }
    };
  }, []);

  useEffect(() => {
    const tick = () => {
      const heading = getCompassHeading();
      if (heading != null) {
        // Compass heading H = the device's top edge faces H. North therefore
        // sits at -H on screen, so the red tip swings to true north.
        setRotation(-heading);
        setSource('device');
      } else {
        // Fallback: screen angle of north = -mapBearing.
        setRotation(-readBearing());
        setSource('map');
      }
    };
    tick();
    const timer = setInterval(tick, POLL_MS);
    return () => clearInterval(timer);
  }, []);

  // OWNER REQUEST (Nov 26 2026): the needle is ALWAYS visible above the map-cycle
  // FAB, in every phase and layout, so it reads as the driver's compass.
  const handleReset = () => {
    // Tapping still snaps the map north-up (and re-arms heads-up).
    try { requestCompassPermission(); } catch { /* ignore */ }
    try {
      if (typeof window !== 'undefined' && typeof window.__resetMapNorth === 'function') {
        window.__resetMapNorth();
      }
    } catch { /* no window */ }
  };

  return (
    <button
      type="button"
      onClick={handleReset}
      aria-label={source === 'device' ? 'Device compass — tap to point the map north up' : 'North up'}
      title={source === 'device' ? 'Compass — tap for north up' : 'North up'}
      /* OWNER REQUEST (Nov 26 2026): sit ONE step below the stop cards
         (StopCardsSection is z-[10070]) so an expanded card always wins, while
         the needle still rides far above the map-cycle FAB (z-[100]). */
      className="absolute z-[10069] p-0 bg-transparent border-0 cursor-pointer"
      style={{ bottom: `${bottomPx}px`, right: `${rightPx}px` }}>
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
    </button>
  );
}
