/**
 * LiveTempBadge.jsx
 *
 * Floating cooler temperature badge above the stop-card FAB.
 * Uses useInkbirdWorker — the same battle-tested GATT connection logic
 * as the InkbirdRawDiagnostic page (3-attempt connect, FFF2 poll fallback).
 * On every reading it persists to RxTempLogs via recordFridgeTemperature.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Thermometer, Bluetooth, BluetoothSearching, BluetoothOff, RefreshCw, Check } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { isAdmin, isDriver as checkIsDriver } from '@/components/utils/userRoles';
import { useInkbirdWorker } from '@/components/common/useInkbirdWorker';

const TEMP_MIN      = 2;
const TEMP_MAX      = 8;
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

  const todayLocal = (() => {
    const d = new Date(), pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  })();

  const saveTempToDb = useCallback(async (tempC) => {
    const driverId = currentUser?.id;
    if (!driverId || tempC === null) return;
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
          connect, disconnect, forget } = useInkbirdWorker({
    onReading: useCallback((tempC) => {
      saveTempToDb(tempC);
      try { localStorage.setItem('rxdeliver_last_ble_temp', JSON.stringify({ tempC, timestamp: new Date().toISOString() })); } catch (_) {}
      setIsPulsing(true);
      clearTimeout(pulseTimerRef.current);
      pulseTimerRef.current = setTimeout(() => setIsPulsing(false), 600);
    }, [saveTempToDb]),
  });

  // ── Local UI state ──────────────────────────────────────────────────────
  const [lastReading, setLastReading] = useState(null);
  const [avgReading,  setAvgReading]  = useState(null);
  const [isPulsing,   setIsPulsing]   = useState(false);
  const [justSaved,   setJustSaved]   = useState(false);
  const [isUnpairing, setIsUnpairing] = useState(false);

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
    const onRecorded = (e) => {
      const { temperature, timestamp, driverId } = e.detail || {};
      const eid = selectedDriverId === 'all' ? currentUser?.id : selectedDriverId;
      if (driverId !== eid) return;
      setLastReading({ temperature_celsius: temperature, timestamp });
    };
    const onVisibilityRestored = () => { loadFromDb(); };
    window.addEventListener('fridgeTempRecorded', onRecorded);
    window.addEventListener('appVisibilityRestored', onVisibilityRestored);
    return () => {
      window.removeEventListener('fridgeTempRecorded', onRecorded);
      window.removeEventListener('appVisibilityRestored', onVisibilityRestored);
    };
  }, [selectedDriverId, currentUser?.id, loadFromDb]);

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
  const isLive    = showLiveBle && bleStatus === 'active' && bleTemp !== null;

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

    if (!navigator?.bluetooth) return;
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