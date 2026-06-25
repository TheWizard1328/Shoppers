/**
 * useInkbirdSensor.js  — Web Bluetooth GATT interface for Inkbird IBS-TH2
 *
 * Always receives currentUser (never null from call site).
 * BLE is only activated when currentUser has the 'driver' app_role.
 * Gating on app_roles here (not at the call site) avoids the "hook initialized
 * with null before AppUser loads" race that kept BLE permanently dead.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import { appendInkbirdLog } from '@/components/devices/InkbirdBleLog';

const INKBIRD_SERVICE_UUID = '0000fff0-0000-1000-8000-00805f9b34fb';
const INKBIRD_NOTIFY_UUID  = '0000fff6-0000-1000-8000-00805f9b34fb';
const INKBIRD_READ_UUID    = '0000fff2-0000-1000-8000-00805f9b34fb';
const INKBIRD_NAMES        = ['tps', 'sps'];
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
  const [status,     setStatus]     = useState('idle');
  const [reading,    setReading]    = useState(null);
  const [sensorName, setSensorName] = useState(getSavedSensorName);

  const deviceRef        = useRef(null);
  const serverRef        = useRef(null);
  const notifyRef        = useRef(null);
  const notifyHandlerRef = useRef(null);
  const mountedRef       = useRef(true);
  const connectingRef    = useRef(false);

  // Gate BLE on driver role — check here so the hook stays alive when app_roles
  // load after first render (hook mount effect only fires once; can't re-init).
  const isDriverRole  = Array.isArray(currentUser?.app_roles) && currentUser.app_roles.includes('driver');
  const hasBluetooth  = isDriverRole && typeof navigator !== 'undefined' && !!navigator.bluetooth;
  const hasGetDevices = hasBluetooth && typeof navigator.bluetooth.getDevices === 'function';

  // ── Internal: GATT connect + subscribe ─────────────────────────────────
  const connectDevice = useCallback(async (device) => {
    if (!mountedRef.current || connectingRef.current) return;
    connectingRef.current = true;
    setStatus('connecting');
    appendInkbirdLog('info', `connectDevice() called`, { deviceName: device?.name, gattConnected: device?.gatt?.connected });

    try {
      try { serverRef.current?.disconnect(); } catch (_) {}
      try {
        if (notifyRef.current && notifyHandlerRef.current) {
          notifyRef.current.removeEventListener('characteristicvaluechanged', notifyHandlerRef.current);
          await notifyRef.current.stopNotifications().catch(() => {});
        }
      } catch (_) {}
      notifyRef.current = null;
      notifyHandlerRef.current = null;

      appendInkbirdLog('info', 'Calling device.gatt.connect()…', { deviceName: device?.name });
      const server = await device.gatt.connect();
      if (!mountedRef.current) { server.disconnect(); connectingRef.current = false; return; }
      serverRef.current = server;
      appendInkbirdLog('success', 'GATT connected, getting primary service…');

      const service = await server.getPrimaryService(INKBIRD_SERVICE_UUID);
      appendInkbirdLog('success', 'Got primary service FFF0');

      // Snapshot read from FFF2
      try {
        const readChar = await service.getCharacteristic(INKBIRD_READ_UUID);
        const dv       = await readChar.readValue();
        const parsed   = decodeReading(dv);
        if (parsed && mountedRef.current) {
          setReading(parsed);
          setStatus('connected');
          appendInkbirdLog('success', `FFF2 snapshot read: ${parsed.tempC}°C, ${parsed.humidity}% RH`);
          window.dispatchEvent(new CustomEvent('inkbirdReading', { detail: { ...parsed, source: 'gatt-read' } }));
        } else {
          appendInkbirdLog('warn', 'FFF2 read returned no valid data');
        }
      } catch (readErr) {
        appendInkbirdLog('warn', `FFF2 read skipped: ${readErr?.message || readErr}`);
      }

      // Subscribe to FFF6 notifications
      appendInkbirdLog('info', 'Subscribing to FFF6 notifications…');
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
      appendInkbirdLog('success', 'FFF6 notifications active — sensor fully connected');

      device.addEventListener('gattserverdisconnected', () => {
        if (!mountedRef.current) return;
        serverRef.current = null;
        connectingRef.current = false;
        setStatus('disconnected');
        appendInkbirdLog('warn', 'GATT server disconnected unexpectedly');
      });

    } catch (err) {
      if (!mountedRef.current) { connectingRef.current = false; return; }
      appendInkbirdLog('error', `connectDevice() failed: ${err?.message || err}`, { name: err?.name });
      setStatus('disconnected');
    } finally {
      connectingRef.current = false;
    }
  }, []);

  // ── triggerReconnect — returns true if it can attempt, false if caller should fall back ──
  const triggerReconnect = useCallback(() => {
    if (!mountedRef.current || !hasBluetooth) {
      appendInkbirdLog('warn', `triggerReconnect() skipped: hasBluetooth=${hasBluetooth}, mounted=${mountedRef.current}`);
      return false;
    }
    if (!deviceRef.current) {
      appendInkbirdLog('warn', 'triggerReconnect() skipped: no device ref — caller should show picker');
      return false;
    }
    if (connectingRef.current) {
      appendInkbirdLog('info', 'triggerReconnect() skipped: already connecting');
      return true; // in-flight, don't show picker
    }
    if (status === 'connected') return true;
    appendInkbirdLog('info', `triggerReconnect() fired, status was: ${status}`);
    connectDevice(deviceRef.current);
    return true;
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
    if (!hasBluetooth) {
      appendInkbirdLog('error', `connect() blocked: hasBluetooth=${hasBluetooth}, isDriverRole=${isDriverRole}, secureCtx=${window?.isSecureContext}, topFrame=${window === window?.top}`);
      return;
    }
    appendInkbirdLog('info', 'connect() called — opening BLE device picker');
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
      appendInkbirdLog('success', `Device selected from picker: "${device.name}"`);
      await connectDevice(device);
    } catch (err) {
      if (!mountedRef.current) return;
      const nextStatus = err?.name === 'NotFoundError' || err?.name === 'AbortError' ? 'idle' : 'error';
      appendInkbirdLog('error', `connect() picker failed: ${err?.message || err}`, { name: err?.name, nextStatus });
      setStatus(nextStatus);
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

    appendInkbirdLog('info', 'Hook mounted', {
      hasBluetooth,
      hasGetDevices,
      isDriverRole,
      isSecureContext: window?.isSecureContext,
      isTopFrame: window === window?.top,
      savedSensor: getSavedSensorName(),
    });

    if (!hasBluetooth) {
      const reason = !isDriverRole ? 'not a driver role' : 'navigator.bluetooth unavailable';
      appendInkbirdLog('warn', `BLE unavailable on mount: ${reason}`);
      setStatus(isDriverRole ? 'unsupported' : 'idle');
      return;
    }

    if (!hasGetDevices) {
      appendInkbirdLog('warn', 'getDevices() not available — need manual pair');
      setStatus('idle');
      return;
    }

    navigator.bluetooth.getDevices().then(devices => {
      if (!mountedRef.current) return;
      appendInkbirdLog('info', `getDevices() returned ${devices.length} device(s)`, { names: devices.map(d => d.name) });
      const inkbird = devices.find(d => INKBIRD_NAMES.includes(d.name));
      if (inkbird) {
        deviceRef.current = inkbird;
        setSensorName(inkbird.name);
        saveSensorNameLocally(inkbird.name);
        setStatus('waiting-gesture');
        appendInkbirdLog('success', `Known Inkbird found: "${inkbird.name}" — waiting for user gesture`);
      } else {
        setStatus('idle');
        appendInkbirdLog('info', 'No known Inkbird in permitted devices list');
      }
    }).catch((err) => {
      appendInkbirdLog('error', `getDevices() threw: ${err?.message || err}`);
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