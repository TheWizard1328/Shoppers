/**
 * useInkbirdUnified.jsx
 *
 * Unified BLE hook that works on ALL platforms:
 *   • Capacitor native (iOS/Android) → useNativeBleSensor (@capacitor-community/bluetooth-le)
 *   • Web Bluetooth (Android Chrome) → useInkbirdWorker (navigator.bluetooth)
 *   • Neither (iOS Safari PWA, editor) → graceful no-op with informative status
 *
 * Normalizes the API to match useInkbirdWorker's surface:
 *   { status, temp, sensorName, connect, disconnect, forget }
 * and fires the onReading callback on every new temperature value.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useInkbirdWorker } from './useInkbirdWorker';
import { useNativeBleSensor } from './useNativeBleSensor';
import { isCapacitorNativeApp } from '@/components/utils/locationProviders/capacitorRuntime';

const USE_NATIVE = isCapacitorNativeApp();

export function useInkbirdUnified({ onReading } = {}) {
  const onReadingRef = useRef(onReading);
  useEffect(() => { onReadingRef.current = onReading; }, [onReading]);

  // ── Web Bluetooth path (Android Chrome / desktop) ──────────────────────────
  const webWorker = useInkbirdWorker({
    onReading: useCallback((tempC) => {
      onReadingRef.current?.(tempC);
    }, []),
  });

  // ── Native Capacitor path (iOS / Android APK) ─────────────────────────────
  // Pass null to disable when not native; pass undefined to enable (active scan).
  const nativeSensor = useNativeBleSensor(USE_NATIVE ? undefined : null);

  // ── Choose active source ───────────────────────────────────────────────────
  const source = USE_NATIVE ? 'native' : 'web';

  // For native path: listen to 'inkbirdReading' events and fire onReading
  const [nativeTemp, setNativeTemp] = useState(null);
  useEffect(() => {
    if (source !== 'native') return;
    const handler = (e) => {
      const tempC = e.detail?.tempC;
      if (typeof tempC === 'number') {
        setNativeTemp(tempC);
        onReadingRef.current?.(tempC);
      }
    };
    window.addEventListener('inkbirdReading', handler);
    return () => window.removeEventListener('inkbirdReading', handler);
  }, [source]);

  // ── Normalize status: native 'connected' → 'active' ────────────────────────
  const normalizeStatus = (s) => {
    if (s === 'connected') return 'active';
    if (s === 'scanning') return 'connecting';
    return s;
  };

  if (source === 'native') {
    return {
      status: normalizeStatus(nativeSensor.status),
      temp: nativeSensor.reading?.tempC ?? nativeTemp,
      sensorName: nativeSensor.sensorName,
      connect: nativeSensor.connect,
      disconnect: nativeSensor.disconnect,
      forget: nativeSensor.forget,
      _source: 'native',
    };
  }

  // Web Bluetooth path (or no-op if navigator.bluetooth absent)
  return {
    status: webWorker.status,
    temp: webWorker.temp,
    sensorName: webWorker.sensorName,
    connect: webWorker.connect,
    disconnect: webWorker.disconnect,
    forget: webWorker.forget,
    _source: 'web',
  };
}
