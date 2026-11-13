import React, { useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Flashlight, FlashlightOff } from 'lucide-react';
import { isAppDarkTheme } from '@/lib/utils';
import { computeSunTimes } from '@/components/utils/sunTimes';
import {
  isTorchBridgeAvailable,
  isNativeTorchOn,
  setNativeTorch,
} from '@/components/utils/torchBridge';

/**
 * TorchFAB — APK-only flashlight button.
 *
 * OWNER SPEC (Nov 10 2026):
 *  - Sits directly ABOVE the map-cycle FAB on the primary Android device.
 *  - Only shows when it is actually dark out: app dark theme, or past sunset
 *    (20 min of lead time) / before sunrise. Sun times come from the local
 *    solar calculation in sunTimes.jsx, never an API call.
 *  - Web/PWA never renders it: navigator has no torch, only the APK bridge does.
 *
 * Props:
 *  bottomPx        – bottom offset for this FAB (map-cycle FAB bottom + its 40px + gap)
 *  rightPx         – right offset (mirrors the map-cycle FAB: 16, or 12 immersive)
 *  driverLocation  – {lat, lon} used for the sun calc; falls back to Edmonton
 *  hideForExpandedCard – collapse with the other FABs when a stop card is open
 *  hidden          – OWNER SPEC (Nov 12 2026): the FAB is gone entirely while
 *                    immersive mode is active (that view keeps only the call /
 *                    navigate pair and the map-cycle FAB). Because `visible`
 *                    drops, the existing cleanup effect also releases the
 *                    native torch — a hidden button must never leave the light on.
 *  enabled         – caller-side gate (primary device + driver + native bridge)
 */

const FALLBACK_COORDS = { lat: 53.5461, lon: -113.4938 }; // Edmonton
const DUSK_LEAD_MS = 20 * 60 * 1000;

const readCoords = (location) => {
  const lat = Number(location?.lat ?? location?.latitude);
  const lon = Number(location?.lon ?? location?.lng ?? location?.longitude);
  if (Number.isFinite(lat) && Math.abs(lat) > 0.01 && Number.isFinite(lon)) {
    return { lat, lon };
  }
  return FALLBACK_COORDS;
};

// App theme wins (a driver in light mode after dark still gets the button);
// the sun calc only decides when the theme says nothing either way.
const isDarkOutside = (location) => {
  const now = new Date();
  const { lat, lon } = readCoords(location);
  const times = computeSunTimes(now, lat, lon);
  if (!times) return false;
  const t = now.getTime();
  return (
    t >= times.sunset.getTime() - DUSK_LEAD_MS || t <= times.sunrise.getTime()
  );
};

export default function TorchFAB({
  bottomPx = 90,
  rightPx = 16,
  driverLocation = null,
  hideForExpandedCard = false,
  hidden = false,
  enabled = false,
}) {
  const [isDark, setIsDark] = useState(() => isAppDarkTheme());
  const [isOn, setIsOn] = useState(false);
  const [hint, setHint] = useState('');
  const bridgeReady = enabled && isTorchBridgeAvailable();
  const hintTimerRef = useRef(null);

  const showHint = useCallback((text) => {
    setHint(text);
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    hintTimerRef.current = setTimeout(() => setHint(''), 2600);
  }, []);

  // Theme follows the app's own dark class (same contract as BatteryIndicator).
  useEffect(() => {
    const root = document.documentElement;
    const sync = () => setIsDark(isAppDarkTheme());
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  // Re-evaluate the sun gate every minute so the button appears at dusk without
  // a reload, and re-sync the native torch state (it is released on background).
  const visible = bridgeReady && isDark && !hidden;

  useEffect(() => {
    if (!bridgeReady) return undefined;
    const tick = () => {
      setIsDark((prev) => {
        const next = isDarkOutside(driverLocation);
        return prev === next ? prev : next;
      });
      setIsOn((prev) => {
        const native = isNativeTorchOn();
        return prev === native ? prev : native;
      });
    };
    tick();
    const id = setInterval(tick, 60 * 1000);
    const onVisible = () => { if (!document.hidden) tick(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [bridgeReady, driverLocation]);

  const toggle = useCallback(() => {
    const next = !isOn;
    const status = setNativeTorch(next);
    if (status === 'on') {
      setIsOn(true);
    } else if (status === 'off') {
      setIsOn(false);
    } else if (status === 'permission') {
      setIsOn(false);
      showHint('Allow camera access for the flashlight');
    } else if (status === 'no_torch') {
      setIsOn(false);
      showHint('This device has no flashlight');
    } else if (status === 'error') {
      setIsOn(false);
      showHint('Flashlight unavailable right now');
    }
  }, [isOn, showHint]);

  // Never leave the light on after the FAB goes away (route change, daytime,
  // device role change, unmount).
  useEffect(() => {
    if (!bridgeReady || visible) return undefined;
    if (isNativeTorchOn()) setNativeTorch(false);
    setIsOn(false);
    return undefined;
  }, [bridgeReady, visible]);

  useEffect(() => () => {
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    if (isNativeTorchOn()) setNativeTorch(false);
  }, []);

  const label = isOn ? 'Turn flashlight off' : 'Turn flashlight on';

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          key="torch-fab"
          initial={{ scale: 0, opacity: 0 }}
          animate={{ scale: 1, opacity: hideForExpandedCard ? 0 : 1 }}
          exit={{ scale: 0, opacity: 0 }}
          transition={{ type: 'spring', stiffness: 260, damping: 20 }}
          className="z-[100]"
          data-torch-fab="true"
          style={{
            position: 'absolute',
            bottom: `${bottomPx}px`,
            right: `${rightPx}px`,
            pointerEvents: hideForExpandedCard ? 'none' : 'auto',
          }}
        >
          {hint && (
            <div className="absolute right-0 bottom-12 whitespace-nowrap rounded-md bg-popover px-2 py-1 text-[11px] font-medium text-popover-foreground border border-border shadow-lg">
              {hint}
            </div>
          )}
          {/* OWNER SPEC (Nov 10 2026): identical size and shape to the map cycle
              FAB (h-10 w-10 rounded-lg shadow-2xl: the same classes that FAB
              uses). OFF = transparent with a white border, ON = filled green
              like the map cycle FAB's green phase. */}
          <button
            type="button"
            onClick={toggle}
            title={label}
            aria-label={label}
            aria-pressed={isOn}
            data-torch-on={isOn ? 'true' : 'false'}
            style={{ touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}
            /* The map cycle FAB is a <Button>, whose base classes carry
               min-h-11 min-w-11 (44px). Its h-10 w-10 is therefore clamped up to
               44x44, which is why a plain h-10 w-10 torch looked narrower. These
               classes reproduce the Button base exactly, so both FABs render at
               44x44 with the same rounded-lg corners. */
            className={`inline-flex h-11 w-11 min-h-11 min-w-11 items-center justify-center rounded-lg p-0 shadow-2xl border transition-all duration-200 ${
              isOn
                ? 'bg-green-600 border-green-600 text-white hover:bg-green-700'
                : 'bg-transparent border-white text-white hover:bg-white/15'
            }`}
          >
            {isOn ? <Flashlight className="h-5 w-5" /> : <FlashlightOff className="h-5 w-5" />}
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}