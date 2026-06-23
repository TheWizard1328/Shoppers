/**
 * useInkbirdSensor.js
 *
 * Manages a persistent BLE connection to the driver's Inkbird IBS-TH2 sensor.
 *
 * ── PERSISTENCE ─────────────────────────────────────────────────────────────
 * Web Bluetooth remembers devices the user permitted via the OS picker.
 * navigator.bluetooth.getDevices() returns those devices WITHOUT showing the
 * picker again — but Chrome still requires a user gesture to actually call
 * gatt.connect(). This is why we hook into stop card button taps.
 *
 * ── CONNECTION STRATEGY ──────────────────────────────────────────────────────
 * 1. Mount: call getDevices() — if the Inkbird is already permitted, store the
 *    device reference but DON'T connect yet (no gesture available at mount).
 * 2. triggerReconnect() — called on any stop card button tap (user gesture).
 *    If we have a device reference and are not already connected, connect now.
 * 3. First-time pair: connect() shows the OS picker once, saves sensor name.
 * 4. On GATT connect: subscribe FFF6 notifications + do a FFF2 read snapshot.
 * 5. On unexpected disconnect: sets status to 'disconnected' — waits for next tap.
 *
 * ── CONFIRMED GATT LAYOUT (Inkbird IBS-TH2, June 2026) ──────────────────────
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
const INKBIRD_NAMES        = ['tps', 'sps'];
const LOCAL_STORAGE_KEY    = 'rxdeliver_inkbird_sensor_name';

// ── Decode FFF2 / FFF6 DataView ───────────────────────────────────────────
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
  const [status,     setStatus]     = useState('idle');
  const [reading,    setReading]    = useState(null);
  const [sensorName, setSensorName] = useState(getSavedSensorName);

  const deviceRef        = useRef(null);   // BluetoothDevice
  const serverRef        = useRef(null);   // BluetoothRemoteGATTServer
  const notifyRef        = useRef(null);   // FFF6 characteristic
  const notifyHandlerRef = useRef(null);
  const mountedRef       = useRef(true);
  const connectingRef    = useRef(false);

  // Check Web Bluetooth availability — only gate on API presence, NOT on touch/device type.
  // Tablets and phones both report hasBluetooth correctly; maxTouchPoints was unreliable.
  const hasBluetooth  = typeof navigator !== 'undefined' && !!navigator.bluetooth;
  const hasGetDevices = hasBluetooth && typeof navigator.bluetooth.getDevices === 'function';

  // ── Internal: GATT connect + subscribe ─────────────────────────────────
  const connectDevice = useCallback(async (device) => {
    if (!mountedRef.current || connectingRef.current) return;
    connectingRef.current = true;
    setStatus('connecting');

    try {
      // Cleanup any stale server/notifications
      try { serverRef.current?.disconnect(); } catch (_) {}
      try {
        if (notifyRef.current && notifyHandlerRef.current) {
          notifyRef.current.removeEventListener('characteristicvaluechanged', notifyHandlerRef.current);
          await notifyRef.current.stopNotifications().catch(() => {});
        }
      } catch (_) {}
      notifyRef.current = null;
      notifyHandlerRef.current = null;

      const server = await device.gatt.connect();
      if (!mountedRef.current) { server.disconnect(); connectingRef.current = false; return; }
      serverRef.current = server;

      const service = await server.getPrimaryService(INKBIRD_SERVICE_UUID);

      // Snapshot read from FFF2
      try {
        const readChar = await service.getCharacteristic(INKBIRD_READ_UUID);
        const dv       = await readChar.readValue();
        const parsed   = decodeReading(dv);
        if (parsed && mountedRef.current) {
          setReading(parsed);
          setStatus('connected');
          window.dispatchEvent(new CustomEvent('inkbirdReading', { detail: { ...parsed, source: 'gatt-read' } }));
        }
      } catch (_) { /* FFF2 not supported on this sensor — fall through */ }

      // Subscribe to FFF6 notifications
      const notifyChar = await service.getCharacteristic(INKBIRD_NOTIFY_UUID);
      notifyRef.current = notifyChar;

      const handler = (evt) => {
        if (!mountedRef.current) return;
        const parsed = decodeReading(evt.target.value);
        if (parsed) {
          setReading(parsed);
          setStatus('connected');
          window.dispatchEvent(new CustomEvent('inkbirdReading', { detail: { ...parsed, source: 'gatt-notify' } }));
        }
      };
      notifyHandlerRef.current = handler;
      notifyChar.addEventListener('characteristicvaluechanged', handler);
      await notifyChar.startNotifications();

      if (mountedRef.current) setStatus('connected');

      // Handle unexpected GATT disconnect
      device.addEventListener('gattserverdisconnected', () => {
        if (!mountedRef.current) return;
        serverRef.current = null;
        connectingRef.current = false;
        setStatus('disconnected');
      });

    } catch (err) {
      if (!mountedRef.current) { connectingRef.current = false; return; }
      setStatus('disconnected');
    } finally {
      connectingRef.current = false;
    }
  }, []);

  // ── triggerReconnect — call from any user-gesture handler ──────────────
  const triggerReconnect = useCallback(() => {
    if (!mountedRef.current) return;
    if (!hasBluetooth) return;
    if (!deviceRef.current) return;     // no device known — need manual pair
    if (connectingRef.current) return;  // already in progress
    if (status === 'connected') return; // already good
    connectDevice(deviceRef.current);
  }, [status, connectDevice, hasBluetooth]);

  // ── forceRead — demand a fresh FFF2 read from the sensor ──────────────
  const forceRead = useCallback(async () => {
    if (!serverRef.current?.connected) return;
    try {
      const service  = await serverRef.current.getPrimaryService(INKBIRD_SERVICE_UUID);
      const readChar = await service.getCharacteristic(INKBIRD_READ_UUID);
      const dv       = await readChar.readValue();
      const parsed   = decodeReading(dv);
      if (parsed && mountedRef.current) {
        setReading(parsed);
        setStatus('connected');
        window.dispatchEvent(new CustomEvent('inkbirdReading', { detail: { ...parsed, source: 'gatt-force-read' } }));
      }
    } catch (_) {}
  }, []);

  // ── First-time manual pair ─────────────────────────────────────────────
  const connect = useCallback(async () => {
    if (!hasBluetooth) return;
    setStatus('connecting');
    try {
      const device = await navigator.bluetooth.requestDevice({
        filters: [
          { name: 'tps' },
          { name: 'sps' },
          { namePrefix: 'Inkbird' },
          { namePrefix: 'IBS' },
        ],
        optionalServices: [INKBIRD_SERVICE_UUID],
      });
      if (!mountedRef.current) return;
      deviceRef.current = device;
      setSensorName(device.name);
      saveSensorNameLocally(device.name);
      persistSensorToUserDevice(currentUser, device.name);
      await connectDevice(device);
    } catch (err) {
      if (!mountedRef.current) return;
      setStatus(err?.name === 'NotFoundError' || err?.name === 'AbortError' ? 'idle' : 'error');
    }
  }, [hasBluetooth, currentUser, connectDevice]);

  // ── Manual disconnect ──────────────────────────────────────────────────
  const disconnect = useCallback(() => {
    connectingRef.current = false;
    try {
      if (notifyRef.current && notifyHandlerRef.current) {
        notifyRef.current.removeEventListener('characteristicvaluechanged', notifyHandlerRef.current);
        notifyRef.current.stopNotifications().catch(() => {});
      }
      serverRef.current?.disconnect();
    } catch (_) {}
    notifyRef.current = null;
    serverRef.current = null;
    notifyHandlerRef.current = null;
    setStatus('idle');
  }, []);

  // ── Mount: find previously-permitted device, store ref for first tap ───
  useEffect(() => {
    mountedRef.current = true;

    if (!hasBluetooth) { setStatus('unsupported'); return; }

    if (!hasGetDevices) {
      setStatus('idle');
      return;
    }

    navigator.bluetooth.getDevices().then(devices => {
      if (!mountedRef.current) return;
      const inkbird = devices.find(d => INKBIRD_NAMES.includes(d.name));
      if (inkbird) {
        deviceRef.current = inkbird;
        setSensorName(inkbird.name);
        saveSensorNameLocally(inkbird.name);
        setStatus('waiting-gesture');
      } else {
        setStatus('idle');
      }
    }).catch(() => {
      if (mountedRef.current) setStatus('idle');
    });

    return () => {
      mountedRef.current = false;
      try {
        notifyRef.current?.stopNotifications?.().catch(() => {});
        serverRef.current?.disconnect?.();
      } catch (_) {}
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    status,
    reading,
    sensorName,
    isPrimaryDevice: hasBluetooth,
    connect,
    disconnect,
    triggerReconnect,
    forceRead,
  };
}