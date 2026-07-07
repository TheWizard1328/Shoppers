/**
 * useInkbirdSensor.jsx
 *
 * Pure streaming hook for Inkbird IBS-TH2 BLE sensor.
 *
 * The badge owns the connect gesture (requestDevice / gatt.connect).
 * It passes the already-connected BluetoothRemoteGATTServer to
 * setConnectedServer(server, device) — this hook then subscribes
 * FFF6 notifications and exposes live readings + status.
 *
 * Status values:
 *   'idle'         – no device yet
 *   'connected'    – streaming (FFF6 notifications active)
 *   'disconnected' – was connected, now gone
 *   'error'        – GATT setup failed
 *
 * ── CONFIRMED GATT LAYOUT (Inkbird IBS-TH2, June 2026) ──────────────
 *   Service  0xFFF0
 *   FFF2     READ    → bytes [0:1] uint16 LE ÷ 100 = temp °C
 *                       byte  [5]  uint8            = humidity %
 *   FFF6     NOTIFY  → same byte layout, pushed every ~1-2 s
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { base44 } from '@/api/base44Client';

export const INKBIRD_SERVICE_UUID = '0000fff0-0000-1000-8000-00805f9b34fb';
export const INKBIRD_NOTIFY_UUID  = '0000fff6-0000-1000-8000-00805f9b34fb';
export const INKBIRD_READ_UUID    = '0000fff2-0000-1000-8000-00805f9b34fb';
export const INKBIRD_FILTERS      = [
  { name: 'tps' }, { name: 'sps' },
  { namePrefix: 'Inkbird' }, { namePrefix: 'IBS' },
];

const LOCAL_STORAGE_KEY = 'rxdeliver_inkbird_sensor_name';

function decodeReading(dv) {
  if (!dv || dv.byteLength < 2) return null;
  const raw = dv.getUint16(0, true);
  const tempC = +(raw / 100).toFixed(2);
  if (tempC < -40 || tempC > 85) return null;
  const humidity = dv.byteLength >= 6 ? dv.getUint8(5) : null;
  return { tempC, humidity, timestamp: new Date().toISOString() };
}

async function persistSensorToUserDevice(currentUser, sensorName) {
  if (!currentUser?.id) return;
  try {
    const deviceId = localStorage.getItem('rxdeliver_device_id');
    if (!deviceId) return;
    const records = await base44.entities.UserDevice.filter({ device_identifier: deviceId });
    if (!records?.length) return;
    await base44.entities.UserDevice.update(records[0].id, {
      device_info: {
        ...(records[0].device_info || {}),
        inkbird_sensor: { name: sensorName, paired_at: new Date().toISOString() },
      },
    });
  } catch (_) {}
}

export function getSavedSensorName() {
  try { return localStorage.getItem(LOCAL_STORAGE_KEY); } catch (_) { return null; }
}
export function saveSensorNameLocally(name) {
  try {
    if (name) localStorage.setItem(LOCAL_STORAGE_KEY, name);
    else localStorage.removeItem(LOCAL_STORAGE_KEY);
  } catch (_) {}
}

export function useInkbirdSensor(currentUser) {
  const [status,     setStatus]     = useState('idle');
  const [reading,    setReading]    = useState(null);
  const [sensorName, setSensorName] = useState(getSavedSensorName);

  const serverRef        = useRef(null);   // BluetoothRemoteGATTServer
  const deviceRef        = useRef(null);   // BluetoothDevice
  const notifyRef        = useRef(null);   // FFF6 characteristic
  const notifyHandlerRef = useRef(null);
  const latestReadingRef = useRef(null);
  const mountedRef       = useRef(true);
  const staleTimerRef    = useRef(null);
  // Tracks the "session ID" of the current connection so stale disconnect
  // listeners from previous connections don't fire on newer ones.
  const connectionIdRef  = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimeout(staleTimerRef.current);
      _cleanupNotify();
      try { serverRef.current?.disconnect(); } catch (_) {}
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function _cleanupNotify() {
    try {
      if (notifyRef.current && notifyHandlerRef.current) {
        notifyRef.current.removeEventListener('characteristicvaluechanged', notifyHandlerRef.current);
        notifyRef.current.stopNotifications().catch(() => {});
      }
    } catch (_) {}
    notifyRef.current = null;
    notifyHandlerRef.current = null;
  }

  // ── Called by the badge with an already-open GATT server ────────────
  const setConnectedServer = useCallback(async (server, device) => {
    if (!mountedRef.current) return;

    // Bump session ID — any listener from a previous connection sees a different
    // ID and ignores its gattserverdisconnected event.
    const myConnectionId = ++connectionIdRef.current;

    clearTimeout(staleTimerRef.current);
    _cleanupNotify();

    const name = device.name || 'sensor';
    deviceRef.current = device;
    serverRef.current = server;
    setSensorName(name);
    saveSensorNameLocally(name);
    persistSensorToUserDevice(currentUser, name);

    // Stale guard: 60s without a reading → mark error but keep GATT alive
    staleTimerRef.current = setTimeout(() => {
      if (!mountedRef.current || connectionIdRef.current !== myConnectionId) return;
      if (!latestReadingRef.current) {
        console.warn('[useInkbirdSensor] No reading in 60s — marking error (GATT kept alive)');
        setStatus('error');
      }
    }, 60000);

    try {
      const service = await server.getPrimaryService(INKBIRD_SERVICE_UUID);

      // Snapshot read from FFF2 first
      try {
        const readChar = await service.getCharacteristic(INKBIRD_READ_UUID);
        const dv = await readChar.readValue();
        const parsed = decodeReading(dv);
        if (parsed && mountedRef.current && connectionIdRef.current === myConnectionId) {
          clearTimeout(staleTimerRef.current);
          latestReadingRef.current = parsed;
          setReading(parsed);
          setStatus('connected');
          window.dispatchEvent(new CustomEvent('inkbirdReading', { detail: { ...parsed, source: 'gatt-read' } }));
        }
      } catch (_) { /* FFF2 not available — rely on FFF6 */ }

      // Subscribe FFF6 notifications
      const notifyChar = await service.getCharacteristic(INKBIRD_NOTIFY_UUID);
      notifyRef.current = notifyChar;

      const handler = (evt) => {
        if (!mountedRef.current || connectionIdRef.current !== myConnectionId) return;
        const parsed = decodeReading(evt.target.value);
        if (!parsed) return;
        clearTimeout(staleTimerRef.current);
        latestReadingRef.current = parsed;
        setReading(parsed);
        setStatus('connected');
        window.dispatchEvent(new CustomEvent('inkbirdReading', { detail: { ...parsed, source: 'gatt-notify' } }));
      };
      notifyHandlerRef.current = handler;
      notifyChar.addEventListener('characteristicvaluechanged', handler);
      await notifyChar.startNotifications();

      if (mountedRef.current && connectionIdRef.current === myConnectionId) {
        setStatus('connected');
      }

    } catch (err) {
      console.warn('[useInkbirdSensor] GATT setup failed:', err?.message);
      clearTimeout(staleTimerRef.current);
      if (mountedRef.current && connectionIdRef.current === myConnectionId) setStatus('error');
      return;
    }

    // Watch for GATT disconnect — scoped to this session only
    device.addEventListener('gattserverdisconnected', () => {
      if (!mountedRef.current || connectionIdRef.current !== myConnectionId) return;
      serverRef.current = null;
      setStatus('disconnected');
    });

  }, [currentUser]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Visibility recovery — when PWA returns to foreground ────────────
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      const server = serverRef.current;
      if (!server?.connected) return;
      // Attempt a fresh FFF2 read to wake the notification stream
      const recover = async () => {
        try {
          const service = await server.getPrimaryService(INKBIRD_SERVICE_UUID);
          const readChar = await service.getCharacteristic(INKBIRD_READ_UUID);
          const dv = await readChar.readValue();
          const parsed = decodeReading(dv);
          if (parsed && mountedRef.current) {
            clearTimeout(staleTimerRef.current);
            latestReadingRef.current = parsed;
            setReading(parsed);
            setStatus('connected');
            window.dispatchEvent(new CustomEvent('inkbirdReading', { detail: { ...parsed, source: 'visibility-recovery' } }));
          }
        } catch (_) {}
      };
      recover();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Forget / unpair ──────────────────────────────────────────────────
  const forget = useCallback(() => {
    connectionIdRef.current++; // invalidate any active session
    clearTimeout(staleTimerRef.current);
    _cleanupNotify();
    try { serverRef.current?.disconnect(); } catch (_) {}
    serverRef.current = null;
    deviceRef.current = null;
    latestReadingRef.current = null;
    saveSensorNameLocally(null);
    setSensorName(null);
    setReading(null);
    setStatus('idle');
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── forceRead — one-shot FFF2 poll ───────────────────────────────────
  const forceRead = useCallback(async () => {
    const server = serverRef.current;
    if (!server?.connected) return;
    try {
      const service = await server.getPrimaryService(INKBIRD_SERVICE_UUID);
      const readChar = await service.getCharacteristic(INKBIRD_READ_UUID);
      const dv = await readChar.readValue();
      const parsed = decodeReading(dv);
      if (parsed && mountedRef.current) {
        latestReadingRef.current = parsed;
        setReading(parsed);
        setStatus('connected');
        window.dispatchEvent(new CustomEvent('inkbirdReading', { detail: { ...parsed, source: 'forced-read' } }));
      }
    } catch (_) {}
  }, []);

  return {
    status,
    reading,
    sensorName,
    latestReadingRef,
    setConnectedServer,
    forget,
    forceRead,
    // Legacy shims
    setConnectedDevice: () => {},
    connect:            () => {},
    triggerReconnect:   () => false,
    isPrimaryDevice:    typeof navigator !== 'undefined' && !!navigator.bluetooth,
  };
}