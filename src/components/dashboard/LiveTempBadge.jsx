/**
 * LiveTempBadge.jsx
 *
 * Floating cooler temperature badge above the stop-card FAB.
 * Uses useInkbirdUnified — routes to native BLE (Capacitor) or Web Bluetooth
 * as the InkbirdRawDiagnostic page (3-attempt connect, FFF2 poll fallback).
 * On every reading it persists to RxTempLogs via recordFridgeTemperature.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Thermometer, Bluetooth, BluetoothSearching, BluetoothOff, RefreshCw, Check } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { isAdmin, isDriver as checkIsDriver } from '@/components/utils/userRoles';
import { useInkbirdUnified } from '@/components/common/useInkbirdUnified';
import { isCapacitorNativeApp } from '@/components/utils/locationProviders/capacitorRuntime';

// Fridge temp defaults — overridden at runtime by AppSettings.fridge_temp_settings
const DEFAULT_SAFE_MIN     = 2;
const DEFAULT_SAFE_MAX     = 6;
const DEFAULT_DANGER_BUFFER = 2;
const DB_POLL_MS    = 60000;
const DOUBLE_TAP_MS = 2000;

function localISOString() {
  const d = new Date(), pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatTimestamp(ts) {
  if (!ts) return null;
  try {
    return new Date(String(ts).replace('Z','').replace('+00:00','')).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch (_) { return ts; }
}

function Tooltip({ text, children }) {
  const [visible, setVisible] = useState(false);
  if (!text) return <>{children}</>;
  return (
    <span className="relative inline-flex items-center"
      onMouseEnter={() => setVisible(true)} onMouseLeave={() => setVisible(false)}
      onTouchStart={() => setVisible(v => !v)}>
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
  const hasWebBluetooth = typeof navigator !== 'undefined' && !!navigator.bluetooth;
  const hasNativeBle = isCapacitorNativeApp();
  const bleAvailable = hasWebBluetooth || hasNativeBle;

  // ── Fridge temp thresholds — loaded from AppSettings ──────────────────────
  const [fridgeCfg, setFridgeCfg] = React.useState({
    safe_min: DEFAULT_SAFE_MIN,
    safe_max: DEFAULT_SAFE_MAX,
    danger_buffer: DEFAULT_DANGER_BUFFER,
  });
  useEffect(() => {
    base44.entities.AppSettings.filter({ setting_key: 'refresh_intervals' })
      .then((s) => {
        const ft = s?.[0]?.setting_value?.fridge_temp_settings;
        if (ft) setFridgeCfg({
          safe_min:      typeof ft.safe_min      === 'number' ? ft.safe_min      : DEFAULT_SAFE_MIN,
          safe_max:      typeof ft.safe_max      === 'number' ? ft.safe_max      : DEFAULT_SAFE_MAX,
          danger_buffer: typeof ft.danger_buffer === 'number' ? ft.danger_buffer : DEFAULT_DANGER_BUFFER,
        });
      })
      .catch(() => {});
  }, []);

  const todayLocal = (() => {
    const d = new Date(), pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  })();

  const lastSavedTempRef  = useRef(null);
  const lastSavedTimeRef  = useRef(0);
  const MAX_SKIP_MS = 5 * 60 * 1000; // force a save at least every 5 minutes

  const saveTempToDb = useCallback(async (tempC) => {
    const driverId = currentUser?.id;
    if (!driverId || tempC === null) return;

    const now = Date.now();
    const tempUnchanged = lastSavedTempRef.current !== null && lastSavedTempRef.current === tempC;
    const withinWindow  = (now - lastSavedTimeRef.current) < MAX_SKIP_MS;

    // Skip if temp hasn't changed AND we saved within the last 5 minutes
    if (tempUnchanged && withinWindow) {
      // Still update the displayed temp without hitting the backend
      const ts = localISOString();
      if (prevTempRef.current !== null) setTempDirection('right');
      prevTempRef.current = tempC;
      setLastReading({ temperature_celsius: tempC, timestamp: ts });
      return;
    }

    try {
      await base44.functions.invoke('recordFridgeTemperature', {
        temperatureCelsius: tempC,
        deliveryDate: todayLocal,
        driverId,
        timestamp: localISOString(),
        trigger: 'ble',
        input_method: 'ble',
        sensor_mac: workerSensorName || null,
      });
      const ts = localISOString();
      lastSavedTempRef.current = tempC;
      lastSavedTimeRef.current = Date.now();
      // Update direction indicator based on previous reading
      if (prevTempRef.current !== null) {
        if (tempC > prevTempRef.current) setTempDirection('up');
        else if (tempC < prevTempRef.current) setTempDirection('down');
        else setTempDirection('right');
      }
      prevTempRef.current = tempC;
      setLastReading({ temperature_celsius: tempC, timestamp: ts });
      window.dispatchEvent(new CustomEvent('fridgeTempRecorded', {
        detail: { temperature: tempC, timestamp: ts, driverId },
      }));
      setJustSaved(true);
      clearTimeout(savedFlashRef.current);
      savedFlashRef.current = setTimeout(() => setJustSaved(false), 1800);
    } catch (_) {}
  }, [currentUser?.id, todayLocal]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── BLE Worker ─────────────────────────────────────────────────────────
  // onReading fires on every reading from the worker (poll + notify)
  const { status: bleStatus, temp: bleTemp, sensorName: workerSensorName,
          connect, disconnect, forget } = useInkbirdUnified({
    onReading: useCallback((tempC) => {
      saveTempToDb(tempC);
      setIsPulsing(true);
      clearTimeout(pulseTimerRef.current);
      pulseTimerRef.current = setTimeout(() => setIsPulsing(false), 600);
    }, [saveTempToDb]),
  });

  // ── Local UI state ──────────────────────────────────────────────────────
  const [lastReading,   setLastReading]   = useState(null);
  const [avgReading,    setAvgReading]    = useState(null);
  const [isPulsing,     setIsPulsing]     = useState(false);
  const [justSaved,     setJustSaved]     = useState(false);
  const [isUnpairing,   setIsUnpairing]   = useState(false);
  const [tempDirection, setTempDirection] = useState('right'); // 'up' | 'down' | 'right'
  const prevTempRef = useRef(null);

  const dbPollTimerRef = useRef(null);
  const pulseTimerRef  = useRef(null);
  const savedFlashRef  = useRef(null);
  const lastTapTimeRef = useRef(0);

  // ── DB poll — loads persisted readings for display ──────────────────────
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
        if (!allReadings.length) { setAvgReading(null); setLastReading(null); return; }
        const temps = allReadings.map(r => r.temperature_celsius).filter(t => typeof t === 'number');
        if (!temps.length) { setAvgReading(null); setLastReading(null); return; }
        const avg = Math.round((temps.reduce((s, t) => s + t, 0) / temps.length) * 10) / 10;
        const sorted = [...allReadings].sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
        setAvgReading({ avg, count: temps.length, from: sorted[0].timestamp, to: sorted[sorted.length - 1].timestamp });
        setLastReading(null);
      } else {
        setAvgReading(null);
        setLastReading(logRecord.latest_reading || null);

        // Seed prevTempRef from the second-to-last saved reading so the direction
        // arrow compares the next BLE reading against what was actually last persisted,
        // not just against whatever was in memory from this session.
        const allReadings = logRecord.temperature_readings || [];
        if (allReadings.length >= 2) {
          const sorted = [...allReadings]
            .filter(r => typeof r?.temperature_celsius === 'number')
            .sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
          if (sorted.length >= 2) {
            const prevSaved = sorted[sorted.length - 2];
            const latestSaved = sorted[sorted.length - 1];
            // Seed prevTempRef only if we don't already have a live BLE value
            // (avoids overwriting a fresher in-session reading)
            if (prevTempRef.current === null) {
              prevTempRef.current = prevSaved.temperature_celsius;
            }
            // Compute direction from the two most recent DB readings for immediate display
            const cur = latestSaved.temperature_celsius;
            const prv = prevSaved.temperature_celsius;
            if (cur > prv) setTempDirection('up');
            else if (cur < prv) setTempDirection('down');
            else setTempDirection('right');
          } else if (sorted.length === 1 && prevTempRef.current === null) {
            // Only one reading ever — seed prev so next BLE reading can compare
            prevTempRef.current = sorted[0].temperature_celsius;
          }
        }
      }
    } catch (_) {}
  }, [selectedDriverId, selectedDate, currentUser?.id, todayLocal]);

  // Clear stale reading when driver/date changes
  const prevDriverRef = useRef(selectedDriverId);
  const prevDateRef   = useRef(selectedDate);
  useEffect(() => {
    if (prevDriverRef.current !== selectedDriverId || prevDateRef.current !== selectedDate) {
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

  // WS / custom event listeners
  useEffect(() => {
    const eid = selectedDriverId === 'all' ? currentUser?.id : selectedDriverId;

    const onRecorded = (e) => {
      const { temperature, timestamp, driverId } = e.detail || {};
      if (driverId !== eid) return;
      setLastReading({ temperature_celsius: temperature, timestamp });
    };

    // WebSocket-driven update from another device or server
    const onRxTempLogsUpdated = (e) => {
      const { data } = e.detail || {};
      if (!data) return;
      if (data.driver_id !== eid) return;
      if (data.delivery_date && data.delivery_date !== selectedDate) return;
      // Update offline DB record is already handled by realtimeSync; just refresh the badge
      if (data.latest_reading) {
        setLastReading(data.latest_reading);
        // Update direction arrow using the last known persisted temp as baseline
        const newTemp = data.latest_reading.temperature_celsius;
        if (typeof newTemp === 'number' && prevTempRef.current !== null) {
          if (newTemp > prevTempRef.current) setTempDirection('up');
          else if (newTemp < prevTempRef.current) setTempDirection('down');
          else setTempDirection('right');
        }
        prevTempRef.current = typeof newTemp === 'number' ? newTemp : prevTempRef.current;
      } else {
        // No latest_reading in slim payload — reload from offline DB (direction derived there)
        loadFromDb();
      }
    };

    const onVisibilityRestored = () => { loadFromDb(); };
    window.addEventListener('fridgeTempRecorded', onRecorded);
    window.addEventListener('rxTempLogsUpdated', onRxTempLogsUpdated);
    window.addEventListener('appVisibilityRestored', onVisibilityRestored);
    return () => {
      window.removeEventListener('fridgeTempRecorded', onRecorded);
      window.removeEventListener('rxTempLogsUpdated', onRxTempLogsUpdated);
      window.removeEventListener('appVisibilityRestored', onVisibilityRestored);
    };
  }, [selectedDriverId, selectedDate, currentUser?.id, loadFromDb]);

  useEffect(() => () => {
    clearTimeout(pulseTimerRef.current);
    clearTimeout(savedFlashRef.current);
    clearInterval(dbPollTimerRef.current);
  }, []);

  // ── Derived values ──────────────────────────────────────────────────────
  const isPastDate = selectedDate && selectedDate < todayLocal;
  const selectedDriverIsMe = !selectedDriverId || selectedDriverId === 'all' ||
    selectedDriverId === currentUser?.id || selectedDriverId === currentUser?.user_id ||
    !adminMode || driverMode;

  const showLiveBle = !isPastDate && selectedDriverIsMe && driverMode;

  const displayTemp = isPastDate
    ? (avgReading?.avg ?? null)
    : (showLiveBle && bleTemp !== null
        ? bleTemp
        : (lastReading?.temperature_celsius ?? null));

  // Use settings-loaded thresholds with float-safe comparison (no integer rounding).
  // safe zone:    [safe_min, safe_max]   — inclusive on both ends
  // warning zone: [safe_min - danger_buffer, safe_min) ∪ (safe_max, safe_max + danger_buffer]
  // out of range: below (safe_min - danger_buffer) or above (safe_max + danger_buffer)
  const { safe_min, safe_max, danger_buffer } = fridgeCfg;
  const outLow  = safe_min - danger_buffer;
  const outHigh = safe_max + danger_buffer;
  const isOut     = displayTemp !== null && (displayTemp < outLow || displayTemp > outHigh);
  const isWarning = displayTemp !== null && !isOut && (displayTemp < safe_min || displayTemp > safe_max);
  const isLive    = showLiveBle && bleStatus === 'active'; // ring shows as soon as BLE connects, before first reading

  // ── Tap handler ─────────────────────────────────────────────────────────
  const handleTap = useCallback(async () => {
    if (isPastDate || !selectedDriverIsMe || (adminMode && !driverMode)) {
      loadFromDb();
      return;
    }

    const now = Date.now();

    // Double-tap to unpair
    if (now - lastTapTimeRef.current < DOUBLE_TAP_MS &&
        (bleStatus === 'active' || workerSensorName)) {
      lastTapTimeRef.current = 0;
      setIsUnpairing(true);
      forget();
      setTimeout(() => setIsUnpairing(false), 1200);
      return;
    }
    lastTapTimeRef.current = now;

    if (bleStatus === 'active') {
      loadFromDb();
      return;
    }

    // On iOS Capacitor native, navigator.bluetooth is absent but native BLE
    // is available via @capacitor-community/bluetooth-le. The unified hook
    // handles routing internally — just call connect().
    connect();
  }, [isPastDate, selectedDriverIsMe, adminMode, driverMode, bleStatus, workerSensorName,
      loadFromDb, connect, forget]);

  // Silent reconnect on stop-card interactions
  useEffect(() => {
    const onReconnectRequest = async () => {
      if (!showLiveBle) return;
      if (bleStatus === 'active' || bleStatus === 'connecting') return;
      connect();
    };
    window.addEventListener('inkbirdReconnectRequest', onReconnectRequest);
    return () => window.removeEventListener('inkbirdReconnectRequest', onReconnectRequest);
  }, [bleStatus, showLiveBle, connect]);

  // ── Display text ────────────────────────────────────────────────────────
  const labelText = (() => {
    if (isUnpairing)                              return 'Unpaired';
    if (!isPastDate && showLiveBle && bleStatus === 'connecting') return 'Connecting…';
    if (!isPastDate && showLiveBle && bleStatus === 'error')      return 'Tap to retry';
    if (!isPastDate && showLiveBle && !bleAvailable && displayTemp === null)
      return 'No BLE';
    if (!isPastDate && showLiveBle && (bleStatus === 'disconnected' || bleStatus === 'idle') && displayTemp === null)
      return workerSensorName ? 'Tap to reconnect' : 'Tap to pair';
    if (displayTemp !== null) return isPastDate ? `∅ ${displayTemp}°C` : `${displayTemp}°C`;
    if (isPastDate)           return 'No data';
    if (!driverMode || !selectedDriverIsMe) return 'No reading';
    return workerSensorName ? 'Tap to reconnect' : 'Tap to pair';
  })();

  const tempTooltip = (() => {
    if (isPastDate && avgReading) {
      const from = avgReading.from ? formatTimestamp(avgReading.from) : '?';
      const to   = avgReading.to   ? formatTimestamp(avgReading.to)   : '?';
      return `Avg of ${avgReading.count} readings · ${from} – ${to}`;
    }
    if (!isPastDate && showLiveBle && !bleAvailable && displayTemp === null)
      return 'Bluetooth not supported on this browser. Use the native app.';
    const ts = lastReading?.timestamp;
    return ts ? `Last reading: ${formatTimestamp(ts)}` : null;
  })();

  // Badge colors
  const badgeStyle = (() => {
    const ring = isLive ? ', 0 0 0 2.5px #3b82f6' : '';
    if (isUnpairing)          return { background: '#475569', border: '1px solid #334155', color: '#ffffff', boxShadow: `0 2px 8px rgba(0,0,0,0.3)${ring}` };
    if (displayTemp === null) return { background: '#64748b', border: '1px solid #475569', color: '#ffffff', boxShadow: `0 2px 8px rgba(0,0,0,0.2)${ring}` };
    if (isOut)                return { background: '#dc2626', border: '1px solid #b91c1c', color: '#ffffff', boxShadow: `0 2px 8px rgba(0,0,0,0.3)${ring}` };
    if (isWarning)            return { background: '#eab308', border: '1px solid #ca8a04', color: '#000000', boxShadow: `0 2px 8px rgba(0,0,0,0.2)${ring}` };
    return                           { background: '#16a34a', border: '1px solid #15803d', color: '#ffffff', boxShadow: `0 2px 8px rgba(0,0,0,0.2)${ring}` };
  })();
  const iconColor = isWarning ? '#000000' : '#ffffff';

  const rightIcon = (() => {
    if (isUnpairing)
      return <BluetoothOff className="w-3 h-3 flex-shrink-0" style={{ color: iconColor, opacity: 0.7 }} />;
    if (justSaved)
      return <Check className="w-3 h-3 flex-shrink-0" style={{ color: isWarning ? '#166534' : '#86efac' }} />;
    if (!driverMode) return null;
    if (bleStatus === 'connecting')
      return <BluetoothSearching className="w-3.5 h-3.5 animate-pulse flex-shrink-0" style={{ color: iconColor }} />;
    if (bleStatus === 'active')
      return <Bluetooth className="w-3 h-3 flex-shrink-0" style={{ color: isWarning ? '#166534' : '#86efac' }} />;
    if (bleStatus === 'error')
      return <RefreshCw className="w-3 h-3 flex-shrink-0" style={{ color: '#f87171', opacity: 0.9 }} />;
    if (bleStatus === 'disconnected')
      return <RefreshCw className="w-3 h-3 flex-shrink-0" style={{ color: iconColor, opacity: 0.6 }} />;
    return <Bluetooth className="w-3 h-3 flex-shrink-0" style={{ color: iconColor, opacity: 0.3 }} />;
  })();

  // ── Visibility guard ────────────────────────────────────────────────────
  const isVisibleRole = adminMode || driverMode;
  if (!isVisibleRole) return null;
  if (driverMode && !adminMode) {
    const bleActive = bleStatus === 'active' || bleStatus === 'connecting';
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
          onTouchEnd={(e) => { e.preventDefault(); e.stopPropagation(); handleTap(); }}
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

          {displayTemp !== null && (
            <span
              className="text-xs font-bold flex-shrink-0"
              style={{
                color: iconColor,
                display: 'inline-block',
                transition: 'transform 0.4s ease',
                transform: tempDirection === 'up' ? 'rotate(0deg)' : tempDirection === 'down' ? 'rotate(180deg)' : 'rotate(90deg)',
                lineHeight: 1,
              }}
            >▲</span>
          )}
          {rightIcon}

          {isLive && (
            <span className="w-1.5 h-1.5 rounded-full animate-pulse flex-shrink-0" style={{ background: isWarning ? '#166534' : '#86efac' }} />
          )}
        </div>
      </motion.div>
    </AnimatePresence>
  );
}