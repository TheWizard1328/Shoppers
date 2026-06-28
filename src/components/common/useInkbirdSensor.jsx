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
  const staleTimerRef    = useRef(null);   // auto-forget if no reading arrives

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
  // The badge does: device.gatt.connect() → gets back a server object
  // and passes BOTH server + device here.
  const setConnectedServer = useCallback(async (server, device) => {
    if (!mountedRef.current) return;

    clearTimeout(staleTimerRef.current);
    _cleanupNotify();

    const name = device.name || 'sensor';
    deviceRef.current = device;
    serverRef.current = server;
    setSensorName(name);
    saveSensorNameLocally(name);
    persistSensorToUserDevice(currentUser, name);

    // Stale guard: if no reading arrives within 10s, mark error and disconnect
    staleTimerRef.current = setTimeout(() => {
      if (!mountedRef.current) return;
      if (!latestReadingRef.current) {
        console.warn('[useInkbirdSensor] No reading received within 10s — disconnecting');
        setStatus('error');
        try { server.disconnect(); } catch (_) {}
      }
    }, 20000);

    try {
      const service = await server.getPrimaryService(INKBIRD_SERVICE_UUID);

      // Snapshot read from FFF2 first
      try {
        const readChar = await service.getCharacteristic(INKBIRD_READ_UUID);
        const dv = await readChar.readValue();
        const parsed = decodeReading(dv);
        if (parsed && mountedRef.current) {
          clearTimeout(staleTimerRef.current); // got a reading — cancel stale timer
          latestReadingRef.current = parsed;
          setReading(parsed);
          setStatus('connected');
          window.dispatchEvent(new CustomEvent('inkbirdReading', { detail: { ...parsed, source: 'gatt-read' } }));
        }
      } catch (_) { /* FFF2 not supported on this firmware — rely on FFF6 */ }

      // Subscribe FFF6 notifications
      const notifyChar = await service.getCharacteristic(INKBIRD_NOTIFY_UUID);
      notifyRef.current = notifyChar;

      const handler = (evt) => {
        if (!mountedRef.current) return;
        const parsed = decodeReading(evt.target.value);
        if (!parsed) return;
        clearTimeout(staleTimerRef.current); // first notification cancels stale timer
        latestReadingRef.current = parsed;
        setReading(parsed);
        setStatus('connected');
        window.dispatchEvent(new CustomEvent('inkbirdReading', { detail: { ...parsed, source: 'gatt-notify' } }));
      };
      notifyHandlerRef.current = handler;
      notifyChar.addEventListener('characteristicvaluechanged', handler);
      await notifyChar.startNotifications();

      if (mountedRef.current) setStatus('connected');

    } catch (err) {
      console.warn('[useInkbirdSensor] GATT setup failed:', err?.message);
      clearTimeout(staleTimerRef.current);
      if (mountedRef.current) setStatus('error');
      return;
    }

    // Watch for unexpected GATT disconnect
    device.addEventListener('gattserverdisconnected', () => {
      if (!mountedRef.current) return;
      serverRef.current = null;
      setStatus('disconnected');
    });

  }, [currentUser]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Forget / unpair — called on double-tap ───────────────────────────
  const forget = useCallback(() => {
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
    setConnectedServer,  // badge calls this with (server, device)
    forget,              // badge calls this on double-tap
    forceRead,
    // Legacy shims
    setConnectedDevice: () => {},
    connect:            () => {},
    triggerReconnect:   () => false,
    isPrimaryDevice:    typeof navigator !== 'undefined' && !!navigator.bluetooth,
  };
}
