/**
 * useInkbirdSensor.jsx
 *
 * Pure streaming hook for Inkbird IBS-TH2 BLE sensor.
 *
 * The badge owns the connect gesture (requestDevice / gatt.connect).
 * Once connected, it calls setConnectedDevice(device) and this hook
 * takes over — subscribes to FFF6 notifications, polls FFF2, and
 * exposes live readings + status.
 *
 * Status values:
 *   'idle'          – no device yet
 *   'connected'     – streaming
 *   'disconnected'  – device known but not connected
 *   'error'         – unrecoverable GATT error
 *
 * ── CONFIRMED GATT LAYOUT (Inkbird IBS-TH2, June 2026) ──────────────────
 *   Service  0xFFF0
 *   FFF2     READ    → bytes [0:1] uint16 LE ÷ 100 = temp °C
 *                       byte  [5]  uint8            = humidity %
 *   FFF6     NOTIFY  → same byte layout, pushed every ~1-2 s
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { base44 } from '@/api/base44Client';

const INKBIRD_SERVICE_UUID = '0000fff0-0000-1000-8000-00805f9b34fb';
const INKBIRD_NOTIFY_UUID  = '0000fff6-0000-1000-8000-00805f9b34fb';
const INKBIRD_READ_UUID    = '0000fff2-0000-1000-8000-00805f9b34fb';
const LOCAL_STORAGE_KEY    = 'rxdeliver_inkbird_sensor_name';

function decodeReading(dv) {
  if (!dv || dv.byteLength < 2) return null;
  const tempC = +(dv.getUint16(0, true) / 100).toFixed(2);
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
    const existing = records[0];
    await base44.entities.UserDevice.update(existing.id, {
      device_info: {
        ...(existing.device_info || {}),
        inkbird_sensor: { name: sensorName, paired_at: new Date().toISOString() },
      },
    });
  } catch (_) {}
}

function getSavedSensorName() {
  try { return localStorage.getItem(LOCAL_STORAGE_KEY); } catch (_) { return null; }
}
function saveSensorNameLocally(name) {
  try { localStorage.setItem(LOCAL_STORAGE_KEY, name); } catch (_) {}
}

export function useInkbirdSensor(currentUser) {
  const [status,     setStatus]    = useState('idle');
  const [reading,    setReading]   = useState(null);
  const [sensorName, setSensorName] = useState(getSavedSensorName);

  const serverRef         = useRef(null);
  const notifyRef         = useRef(null);
  const notifyHandlerRef  = useRef(null);
  const latestReadingRef  = useRef(null);
  const mountedRef        = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      try {
        if (notifyRef.current && notifyHandlerRef.current) {
          notifyRef.current.removeEventListener('characteristicvaluechanged', notifyHandlerRef.current);
          notifyRef.current.stopNotifications().catch(() => {});
        }
        serverRef.current?.disconnect();
      } catch (_) {}
    };
  }, []);

  // ── Called by the badge after it has connected the device ────────────
  const setConnectedDevice = useCallback(async (device) => {
    if (!mountedRef.current) return;
    setStatus('connected');

    // Clean up any previous subscription
    try {
      if (notifyRef.current && notifyHandlerRef.current) {
        notifyRef.current.removeEventListener('characteristicvaluechanged', notifyHandlerRef.current);
        await notifyRef.current.stopNotifications().catch(() => {});
      }
    } catch (_) {}
    notifyRef.current = null;
    notifyHandlerRef.current = null;

    const name = device.name || 'sensor';
    setSensorName(name);
    saveSensorNameLocally(name);
    persistSensorToUserDevice(currentUser, name);

    // Re-use the already-connected server passed from the badge
    const server = device.gatt.connected
      ? device.gatt  // already open
      : await device.gatt.connect();

    if (!mountedRef.current) { server.disconnect(); return; }
    serverRef.current = server;

    try {
      const service = await server.getPrimaryService(INKBIRD_SERVICE_UUID);

      // Snapshot read
      try {
        const readChar = await service.getCharacteristic(INKBIRD_READ_UUID);
        const dv = await readChar.readValue();
        const parsed = decodeReading(dv);
        if (parsed && mountedRef.current) {
          latestReadingRef.current = parsed;
          setReading(parsed);
          setStatus('connected');
          window.dispatchEvent(new CustomEvent('inkbirdReading', { detail: { ...parsed, source: 'gatt-read' } }));
        }
      } catch (_) {}

      // Subscribe notifications
      const notifyChar = await service.getCharacteristic(INKBIRD_NOTIFY_UUID);
      notifyRef.current = notifyChar;
      const handler = (evt) => {
        if (!mountedRef.current) return;
        const parsed = decodeReading(evt.target.value);
        if (parsed) {
          latestReadingRef.current = parsed;
          setReading(parsed);
          setStatus('connected');
          window.dispatchEvent(new CustomEvent('inkbirdReading', { detail: { ...parsed, source: 'gatt-notify' } }));
        }
      };
      notifyHandlerRef.current = handler;
      notifyChar.addEventListener('characteristicvaluechanged', handler);
      await notifyChar.startNotifications();

    } catch (err) {
      console.warn('[useInkbirdSensor] GATT setup failed:', err?.message);
      if (mountedRef.current) setStatus('error');
      return;
    }

    // Handle unexpected disconnect
    device.addEventListener('gattserverdisconnected', () => {
      if (!mountedRef.current) return;
      serverRef.current = null;
      setStatus('disconnected');
    });

  }, [currentUser]);

  // forceRead — do a one-shot FFF2 poll on demand
  const forceRead = useCallback(async () => {
    if (!serverRef.current?.connected) return;
    try {
      const service = await serverRef.current.getPrimaryService(INKBIRD_SERVICE_UUID);
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
    setConnectedDevice, // badge calls this after its own gatt.connect()
    forceRead,
    // Legacy shims so bridge/badge callers don't break
    connect:          () => {},
    triggerReconnect: () => false,
    isPrimaryDevice:  typeof navigator !== 'undefined' && !!navigator.bluetooth,
  };
}
