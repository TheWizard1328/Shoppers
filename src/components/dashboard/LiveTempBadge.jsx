/**
 * LiveTempBadge.jsx
 *
 * Floating cooler temperature badge above the stop-card FAB.
 * BLE is handled by useInkbirdSensorBridge which auto-selects:
 *   - Native Capacitor BLE  (isCapacitorNativeApp() === true)
 *   - Web Bluetooth GATT    (browser / PWA)
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Thermometer, Bluetooth, BluetoothSearching, RefreshCw, Check } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { isAdmin, isDriver as checkIsDriver } from '@/components/utils/userRoles';
import { useInkbirdSensorBridge } from '@/components/common/useInkbirdSensorBridge';

// ── Constants ──────────────────────────────────────────────────────────────
const TEMP_MIN        = 2;
const TEMP_MAX        = 8;
const DB_POLL_MS      = 60000;
const PULSE_MS        = 600;
const HEARTBEAT_MS    = 60 * 1000; // 1 minute — FFF6 notifications flow continuously, we persist once/min
const CHANGE_THRESHOLD = 0.1;           // °C — secondary gate; primary gate is heartbeat every 1 min

function localISOString() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatTimestamp(ts) {
  if (!ts) return null;
  try {
    const clean = String(ts).replace('Z', '').replace('+00:00', '');
    return new Date(clean).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch (_) { return ts; }
}

// ── Tooltip ────────────────────────────────────────────────────────────────
function Tooltip({ text, children }) {
  const [visible, setVisible] = useState(false);
  if (!text) return <>{children}</>;
  return (
    <span
      className="relative inline-flex items-center"
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
      onTouchStart={() => setVisible(v => !v)}
    >
      {children}
      {visible && (
        <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2 py-1 rounded text-[11px] font-normal whitespace-nowrap bg-slate-900 text-white shadow-lg pointer-events-none z-[9999]">
          {text}
          <span className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-slate-900" />
        </span>
      )}
    </span>
  );
}

// ══════════════════════════════════════════════════════════════════════════
export default function LiveTempBadge({
  currentUser,
  selectedDriverId,
  selectedDate,
  immersiveHidden,
  fabPosition        = 'absolute',
  bottomOffset       = 80,
  immersiveTopOffset = 0,
  hasVisibleCards    = false,
  stopCardsHeight    = 0,
}) {
  const adminMode  = isAdmin(currentUser);
  const driverMode = checkIsDriver(currentUser);

  // ── Bridge: auto-selects native or web BLE ─────────────────────────────
  // Always pass currentUser — the hook itself decides whether to activate BLE.
  // Previously passing null when !driverMode caused the hook to initialize dead
  // and never recover when app_roles loaded later (mount effect runs only once).
  const { status: bleStatus, reading: bleReading, sensorName, latestReadingRef, connect, triggerReconnect, forceRead } =
    useInkbirdSensorBridge(currentUser);

  // bleReading = { tempC, humidity, timestamp } | null
  const bleTemp = bleReading?.tempC ?? null;

  // ── Local state ────────────────────────────────────────────────────────
  const [lastReading, setLastReading] = useState(null);
  const [avgReading,  setAvgReading]  = useState(null);
  const [isPulsing,   setIsPulsing]   = useState(false);
  const [justSaved,   setJustSaved]   = useState(false);

  const dbPollTimerRef    = useRef(null);
  const pulseTimerRef     = useRef(null);
  const savedFlashRef     = useRef(null);
  const heartbeatTimerRef = useRef(null);  // 1-min save interval — fires regardless of temp change
  const lastSavedTempRef  = useRef(null);
  const lastSavedTimeRef  = useRef(0);
  const prevTempRef       = useRef(null);

  // ── Helpers ───────────────────────────────────────────────────────────
  const triggerPulse = useCallback(() => {
    setIsPulsing(true);
    clearTimeout(pulseTimerRef.current);
    pulseTimerRef.current = setTimeout(() => setIsPulsing(false), PULSE_MS);
  }, []);

  const flashSaved = useCallback(() => {
    setJustSaved(true);
    clearTimeout(savedFlashRef.current);
    savedFlashRef.current = setTimeout(() => setJustSaved(false), 1800);
  }, []);

  // ── Save BLE reading to DB ────────────────────────────────────────────
  const saveBleReading = useCallback(async (tempC) => {
    const driverId = currentUser?.id;
    if (!driverId || tempC === null) return;
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    const todayLocal = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
    const now = Date.now();
    const lastTemp = lastSavedTempRef.current;
    const timeSinceLast = now - lastSavedTimeRef.current;
    const tempChanged = lastTemp === null || Math.abs(tempC - lastTemp) >= CHANGE_THRESHOLD;
    const heartbeatDue = timeSinceLast >= HEARTBEAT_MS;
    if (!tempChanged && !heartbeatDue) return;
    lastSavedTempRef.current = tempC;
    lastSavedTimeRef.current = now;
    const trigger = heartbeatDue && !tempChanged ? 'heartbeat' : 'change';
    try {
      await base44.functions.invoke('recordFridgeTemperature', {
        temperatureCelsius: tempC,
        deliveryDate: todayLocal,
        driverId,
        timestamp: localISOString(),
        trigger,
        input_method: 'ble',
        sensor_mac: sensorName || null,
      });
      const ts = localISOString();
      setLastReading({ temperature_celsius: tempC, timestamp: ts });
      window.dispatchEvent(new CustomEvent('fridgeTempRecorded', {
        detail: { temperature: tempC, timestamp: ts, driverId },
      }));
      flashSaved();
    } catch (_) {}
  }, [currentUser?.id, sensorName, flashSaved]);

  // ── React to new BLE readings — pulse animation + localStorage only ────
  // DB save is handled by the heartbeat interval below so it fires even when
  // temperature is perfectly stable and bleTemp never changes value.
  useEffect(() => {
    if (bleTemp === null) return;
    if (prevTempRef.current !== bleTemp) {
      triggerPulse();
      prevTempRef.current = bleTemp;
    }
    // Persist last known temp to localStorage so it survives BLE disconnects
    try { localStorage.setItem('rxdeliver_last_ble_temp', JSON.stringify({ tempC: bleTemp, timestamp: new Date().toISOString() })); } catch (_) {}
  }, [bleTemp, triggerPulse]);

  // ── 1-minute heartbeat save — completely decoupled from temp changes ───
  // Notifications flow continuously every 1-2s. This interval fires every
  // minute and saves whatever latestReadingRef.current holds — even if tempC
  // has been rock-steady and bleTemp never caused a re-render.
  useEffect(() => {
    // Kick off an immediate save on first connect so we don't wait a full minute
    if (bleStatus === 'connected' && latestReadingRef.current) {
      saveBleReading(latestReadingRef.current.tempC);
    }
    clearInterval(heartbeatTimerRef.current);
    if (bleStatus === 'connected') {
      heartbeatTimerRef.current = setInterval(() => {
        const latest = latestReadingRef.current;
        if (latest?.tempC != null) saveBleReading(latest.tempC);
      }, HEARTBEAT_MS);
    }
    return () => clearInterval(heartbeatTimerRef.current);
  }, [bleStatus, latestReadingRef, saveBleReading]);

  // ── Computed date values ──────────────────────────────────────────────
  const todayLocal = (() => {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  })();

  // selectedDriverId may be the AppUser record ID or the auth user ID — check both.
  // For admin+driver users, always treat as "self" — they carry the sensor regardless
  // of which driver route they're currently viewing on screen.
  const selectedDriverIsMe = !selectedDriverId || selectedDriverId === 'all' ||
    selectedDriverId === currentUser?.id ||
    selectedDriverId === currentUser?.user_id ||
    !adminMode || // pure driver: always self
    driverMode;   // admin+driver: always self (they have the sensor)
  const isPastDate = selectedDate && selectedDate < todayLocal;

  // ── DB poll ───────────────────────────────────────────────────────────
  const loadFromDb = useCallback(async () => {
    if (!selectedDriverId || !selectedDate) return;
    try {
      const driverId = (selectedDriverId && selectedDriverId !== 'all') ? selectedDriverId : currentUser?.id;
      if (!driverId) return;

      let logRecord = null;
      try {
        const { offlineDB } = await import('@/components/utils/offlineDatabase');
        const all = await offlineDB.getAll(offlineDB.STORES.RX_TEMP_LOGS);
        logRecord = (all || []).find(l => l?.driver_id === driverId && l?.delivery_date === selectedDate) || null;
      } catch (_) {}
      if (!logRecord) {
        const logs = await base44.entities.RxTempLogs.filter({ driver_id: driverId, delivery_date: selectedDate });
        logRecord = logs?.[0] || null;
      }

      if (!logRecord) { setLastReading(null); setAvgReading(null); return; }

      if (selectedDate < todayLocal) {
        const allReadings = logRecord.temperature_readings || [];
        if (allReadings.length === 0) { setAvgReading(null); setLastReading(null); return; }

        let routeStart = null, routeEnd = null;
        try {
          const DONE = new Set(['completed', 'failed']);
          let delivs = [];
          try {
            const { offlineDB: odb } = await import('@/components/utils/offlineDatabase');
            const cached = await odb.getAll(odb.STORES.DELIVERIES);
            delivs = (cached || []).filter(d => d?.driver_id === driverId && d?.delivery_date === selectedDate && DONE.has(d.status) && d.actual_delivery_time);
          } catch (_) {}
          if (!delivs.length) {
            const fresh = await base44.entities.Delivery.filter({ driver_id: driverId, delivery_date: selectedDate });
            delivs = (fresh || []).filter(d => DONE.has(d.status) && d.actual_delivery_time);
          }
          if (delivs.length) {
            const times = delivs
              .map(d => String(d.actual_delivery_time).replace('Z','').replace(/\+.*$/,'').slice(11, 16))
              .filter(t => /^\d{2}:\d{2}$/.test(t))
              .sort();
            if (times.length) { routeStart = times[0]; routeEnd = times[times.length - 1]; }
          }
        } catch (_) {}

        const sorted = [...allReadings].sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
        const windowReadings = (routeStart && routeEnd)
          ? sorted.filter(r => { const hhmm = String(r.timestamp || '').replace('Z','').slice(11, 16); return hhmm >= routeStart && hhmm <= routeEnd; })
          : sorted;
        const source = windowReadings.length ? windowReadings : sorted;
        const temps = source.map(r => r.temperature_celsius).filter(t => typeof t === 'number');
        if (temps.length === 0) { setAvgReading(null); setLastReading(null); return; }
        const avg = Math.round((temps.reduce((s, t) => s + t, 0) / temps.length) * 10) / 10;
        setAvgReading({ avg, count: temps.length, from: source[0].timestamp, to: source[source.length - 1].timestamp });
        setLastReading(null);
      } else {
        setAvgReading(null);
        setLastReading(logRecord.latest_reading || null);
      }
    } catch (_) {}
  }, [selectedDriverId, selectedDate, currentUser?.id, todayLocal]);

  // Clear stale reading when driver/date changes
  const prevDriverRef = useRef(selectedDriverId);
  const prevDateRef   = useRef(selectedDate);
  useEffect(() => {
    const driverChanged = prevDriverRef.current !== selectedDriverId;
    const dateChanged   = prevDateRef.current   !== selectedDate;
    if (driverChanged || dateChanged) {
      prevDriverRef.current = selectedDriverId;
      prevDateRef.current   = selectedDate;
      setLastReading(null);
      setAvgReading(null);
    }
  }, [selectedDriverId, selectedDate]);

  useEffect(() => {
    loadFromDb();
    clearInterval(dbPollTimerRef.current);
    dbPollTimerRef.current = setInterval(loadFromDb, DB_POLL_MS);
    return () => clearInterval(dbPollTimerRef.current);
  }, [loadFromDb]);

  // ── WS / custom event listeners ───────────────────────────────────────
  useEffect(() => {
    const onRecorded = (e) => {
      const { temperature, timestamp, driverId } = e.detail || {};
      const eid = selectedDriverId === 'all' ? currentUser?.id : selectedDriverId;
      if (driverId !== eid) return;
      setLastReading({ temperature_celsius: temperature, timestamp });
      triggerPulse();
    };
    const onWs = async (e) => {
      const { data, id: recordId } = e.detail || {};
      if (!data && !recordId) return;
      const eid = selectedDriverId === 'all' ? currentUser?.id : selectedDriverId;
      if (data?.driver_id !== eid) return;
      if (!data.latest_reading && recordId) {
        try {
          const full = await base44.entities.RxTempLogs.get(recordId);
          if (full?.latest_reading) { setLastReading(full.latest_reading); triggerPulse(); }
        } catch (_) {}
        return;
      }
      if (data.latest_reading) { setLastReading(data.latest_reading); triggerPulse(); }
    };
    const onVisibilityRestored = () => {
      // App regained focus — reconnect BLE if needed and take a fresh reading
      triggerReconnect();
      forceRead();
      // Reset the DB poll timer so a fresh read fires immediately
      clearInterval(dbPollTimerRef.current);
      loadFromDb();
      dbPollTimerRef.current = setInterval(loadFromDb, DB_POLL_MS);
    };

    window.addEventListener('fridgeTempRecorded', onRecorded);
    window.addEventListener('rxTempLogsUpdated', onWs);
    window.addEventListener('appVisibilityRestored', onVisibilityRestored);
    return () => {
      window.removeEventListener('fridgeTempRecorded', onRecorded);
      window.removeEventListener('rxTempLogsUpdated', onWs);
      window.removeEventListener('appVisibilityRestored', onVisibilityRestored);
    };
  }, [selectedDriverId, currentUser?.id, triggerPulse, triggerReconnect, forceRead, loadFromDb]);

  // Cleanup on unmount
  useEffect(() => () => {
    clearTimeout(pulseTimerRef.current);
    clearTimeout(savedFlashRef.current);
    clearInterval(dbPollTimerRef.current);
  }, []);

  // ── Tap handler ───────────────────────────────────────────────────────
  const handleTap = useCallback(() => {
    if (isPastDate || !selectedDriverIsMe) { loadFromDb(); triggerPulse(); return; }
    if (adminMode && !driverMode)          { loadFromDb(); triggerPulse(); return; }

    if (bleStatus === 'connected') {
      forceRead();
      loadFromDb();
      triggerPulse();
      return;
    }

    // In-flight — do nothing
    if (bleStatus === 'connecting' || bleStatus === 'scanning') return;

    // Try silent reconnect first — checks getDevices() in the hook first.
    // If it returns false, no device was ever permitted — show the picker.
    Promise.resolve(triggerReconnect()).then(reconnected => {
      if (!reconnected) connect();
    });
  }, [isPastDate, selectedDriverIsMe, adminMode, driverMode, bleStatus,
      loadFromDb, triggerPulse, connect, triggerReconnect, forceRead]);

  // ── Display values ────────────────────────────────────────────────────
  const showLiveBle = !isPastDate && selectedDriverIsMe && driverMode;

  // Fallback: last BLE reading saved to localStorage (survives BLE disconnects between sessions)
  const localStorageFallbackTemp = (() => {
    if (bleTemp !== null || lastReading?.temperature_celsius != null) return null;
    try {
      const saved = JSON.parse(localStorage.getItem('rxdeliver_last_ble_temp') || 'null');
      return saved?.tempC ?? null;
    } catch (_) { return null; }
  })();

  const displayTemp = isPastDate
    ? (avgReading?.avg ?? null)
    : (showLiveBle && bleTemp !== null
        ? bleTemp
        : (lastReading?.temperature_celsius ?? localStorageFallbackTemp ?? null));

  const isOut     = displayTemp !== null && (displayTemp < TEMP_MIN || displayTemp > TEMP_MAX);
  const isWarning = displayTemp !== null && !isOut && (displayTemp < TEMP_MIN + 1 || displayTemp > TEMP_MAX - 1);
  const isLive    = showLiveBle && bleStatus === 'connected' && bleTemp !== null;

  const tempTooltip = (() => {
    if (isPastDate && avgReading) {
      const from = avgReading.from ? formatTimestamp(avgReading.from) : '?';
      const to   = avgReading.to   ? formatTimestamp(avgReading.to)   : '?';
      return `Avg of ${avgReading.count} readings · ${from} – ${to}`;
    }
    const ts = lastReading?.timestamp;
    return ts ? `Last reading: ${formatTimestamp(ts)}` : null;
  })();

  const labelText = (() => {
    if (!isPastDate && showLiveBle && (bleStatus === 'connecting' || bleStatus === 'scanning')) return 'Connecting…';
    // If disconnected but we have a cached/DB reading, show the temperature instead of "Tap to reconnect"
    if (!isPastDate && showLiveBle && bleStatus === 'disconnected' && displayTemp === null) return sensorName ? 'Tap to reconnect' : 'Tap to pair';
    if (displayTemp !== null) return isPastDate ? `∅ ${displayTemp}°C` : `${displayTemp}°C`;
    if (isPastDate)           return 'No data';
    if (!driverMode || !selectedDriverIsMe) return 'No reading';
    return sensorName ? 'Tap to reconnect' : 'Tap to pair';
  })();

  // Badge color
  const badgeStyle = (() => {
    if (displayTemp === null) return { background: '#64748b', border: '1px solid #475569', color: '#ffffff' };
    if (isOut)                return { background: '#dc2626', border: '1px solid #b91c1c', color: '#ffffff' };
    if (isWarning)            return { background: '#eab308', border: '1px solid #ca8a04', color: '#000000' };
    return                           { background: '#16a34a', border: '1px solid #15803d', color: '#ffffff' };
  })();
  const iconColor = isWarning ? '#000000' : '#ffffff';

  // Right icon
  const rightIcon = (() => {
    if (justSaved)
      return <Check className="w-3 h-3 flex-shrink-0" style={{ color: isWarning ? '#166534' : '#86efac' }} />;
    if (!driverMode) return null;
    if (bleStatus === 'connecting' || bleStatus === 'scanning')
      return <BluetoothSearching className="w-3.5 h-3.5 animate-pulse flex-shrink-0" style={{ color: iconColor }} />;
    if (bleStatus === 'connected')
      return <Bluetooth className="w-3 h-3 flex-shrink-0" style={{ color: isWarning ? '#166534' : '#86efac' }} />;
    if (bleStatus === 'error' || bleStatus === 'disconnected')
      return <RefreshCw className="w-3 h-3 flex-shrink-0" style={{ color: iconColor, opacity: 0.6 }} />;
    return <Bluetooth className="w-3 h-3 flex-shrink-0" style={{ color: iconColor, opacity: 0.3 }} />;
  })();

  // ── Visibility guard ──────────────────────────────────────────────────
  const isVisibleRole = adminMode || driverMode;
  if (!isVisibleRole) return null;
  if (driverMode && !adminMode) {
    const bleActive = bleStatus === 'connected' || bleStatus === 'connecting' || bleStatus === 'scanning';
    // Always show badge for the driver's own route/today so they can tap to pair
    if (!bleActive && displayTemp === null && (!selectedDriverIsMe || isPastDate)) return null;
  }

  return (
    <AnimatePresence mode="wait">
      <motion.div
        key="temp-badge"
        initial={{ opacity: 0, scale: 0.92 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.92 }}
        transition={{ duration: 0.2 }}
        className="flex justify-center z-[100] pointer-events-none"
        style={(() => {
            const bottomNavHeight = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--bottom-nav-height') || '0') || 0;
            // In immersive mode: match the FABs — sit 10px from the bottom with no stop cards offset
            const bottom = immersiveHidden
              ? bottomNavHeight + 10
              : ((hasVisibleCards) ? stopCardsHeight + bottomNavHeight : bottomNavHeight) + 10;
            return { position: fabPosition, bottom: `${bottom}px`,
              left: fabPosition === 'fixed' ? 'var(--sidebar-width)' : 0, right: 0 };
          })()}
      >
        <div
          role="button"
          tabIndex={0}
          onClick={handleTap}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleTap(); }}
          className={`pointer-events-auto flex items-center gap-1.5 px-3 py-1.5 rounded-full shadow-lg text-sm font-semibold select-none cursor-pointer active:scale-95 ${isPulsing ? 'scale-110' : 'scale-100'}`}
          style={{
            ...badgeStyle,
            WebkitTapHighlightColor: 'transparent',
            transition: isPulsing ? 'transform 0.1s ease-out' : 'transform 0.5s ease-in',
          }}
        >
          <Thermometer className="w-3.5 h-3.5 flex-shrink-0" style={{ color: iconColor }} />

          <Tooltip text={tempTooltip}>
            <span style={{ color: iconColor }}>{labelText}</span>
          </Tooltip>

          {(isOut || isWarning) && <span className="text-xs font-bold opacity-90" style={{ color: iconColor }}>⚠</span>}
          {rightIcon}

          {isLive && (
            <span className="w-1.5 h-1.5 rounded-full animate-pulse flex-shrink-0" style={{ background: isWarning ? '#166534' : '#86efac' }} />
          )}
        </div>
      </motion.div>
    </AnimatePresence>
  );
}