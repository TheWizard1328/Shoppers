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
 *    This is the "piggyback on button taps" strategy — Chrome is happy because
 *    there IS a user gesture in the call stack.
 * 3. First-time pair: connect() shows the OS picker once, saves sensor name.
 * 4. On GATT connect: subscribe FFF6 notifications + do a FFF2 read snapshot.
 * 5. On unexpected disconnect: scheduleReconnect() — waits for next button tap.
 *
 * ── CONFIRMED GATT LAYOUT (Inkbird IBS-TH2, June 2026) ──────────────────────
 *   Service  0xFFF0
 *   FFF2     READ    → bytes [0:1] uint16 LE ÷ 100 = temp °C
 *                       byte  [5]  uint8            = humidity %
 *   FFF6     NOTIFY  → same byte layout, pushed every ~1-2 s
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
// getCurrentDevice import removed — BLE gating no longer uses device DB

const INKBIRD_SERVICE_UUID = '0000fff0-0000-1000-8000-00805f9b34fb';
const INKBIRD_NOTIFY_UUID  = '0000fff6-0000-1000-8000-00805f9b34fb';
const INKBIRD_READ_UUID    = '0000fff2-0000-1000-8000-00805f9b34fb';
const INKBIRD_NAMES        = ['tps', 'sps'];
const LOCAL_STORAGE_KEY    = 'rxdeliver_inkbird_sensor_name';
const MAX_RETRIES          = 5;
const PERIODIC_READ_MS     = 60 * 1000; // 1 minute

// ── Decode FFF2 / FFF6 DataView ───────────────────────────────────────────
function decodeReading(dv) {
  if (!dv || dv.byteLength < 2) return null;
  const tempC = +(dv.getUint16(0, true) / 100).toFixed(2);
  if (tempC < -40 || tempC > 85) return null;
  const humidity = dv.byteLength >= 6 ? dv.getUint8(5) : null;
  return { tempC, humidity, timestamp: new Date().toISOString() };
}

// ── Persist sensor name to UserDevice entity ──────────────────────────────
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
  } catch (err) {
    console.warn('[useInkbirdSensor] Could not persist sensor to UserDevice:', err?.message);
  }
}

function getSavedSensorName() {
  try { return localStorage.getItem(LOCAL_STORAGE_KEY); } catch (_) { return null; }
}
function saveSensorNameLocally(name) {
  try { localStorage.setItem(LOCAL_STORAGE_KEY, name); } catch (_) {}
}

// ── Auto-save periodic BLE readings ─────────────────────────────────────────
async function persistHeartbeatReading(parsed, currentUser, sensorName) {
  const user = currentUser;
  if (!user?.id) return;
  // Throttle: at most once per 60 seconds to avoid DB spam from FFF6 notifications
  const now = Date.now();
  if (now - lastHeartbeatSave.current < 60000) return;
  lastHeartbeatSave.current = now;
  const pad = (n) => String(n).padStart(2, '0');
  const d = new Date();
  const dateStr = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const localTimestamp = `${dateStr}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const reading = {
    tempC: parsed.tempC,
    humidity: parsed.humidity,
    timestamp: localTimestamp,
    dateStr,
    driverId: user.id,
    sensorName,
  };
  // Save offline first
  try {
    const { offlineDB } = await import('../utils/offlineDatabase');
    const existing = await offlineDB.getByCompoundIndex('rx_temp_logs', 'date_driver', [dateStr, user.id]);
    const existingLog = existing?.[0];
    const entry = { timestamp: localTimestamp, temperature_celsius: parsed.tempC, recorded_by_driver_id: user.id, trigger: 'heartbeat', input_method: 'ble', sensor_mac: sensorName };
    if (existingLog) {
      const readings = Array.isArray(existingLog.temperature_readings) ? existingLog.temperature_readings : [];
      readings.push(entry);
      await offlineDB.save('rx_temp_logs', { ...existingLog, temperature_readings: readings, latest_reading: entry, updated_date: new Date().toISOString() });
    } else {
      const id = `offline_temp_${dateStr}_${user.id}`;
      await offlineDB.save('rx_temp_logs', { id, delivery_date: dateStr, driver_id: user.id, temperature_readings: [entry], latest_reading: entry, updated_date: new Date().toISOString() });
    }
  } catch (_) { /* offline save non-critical */ }
  // Fire backend call (fire-and-forget)
  base44.functions.invoke('recordFridgeTemperature', {
    temperatureCelsius: parsed.tempC,
    deliveryDate: dateStr,
    driverId: user.id,
    timestamp: localTimestamp,
    trigger: 'heartbeat',
    input_method: 'ble',
    sensor_mac: sensorName,
  }).catch(() => {});
}
// Ref shared outside hook
const lastHeartbeatSave = { current: 0 };

/**
 * useInkbirdSensor(currentUser)
 *
 * Returns:
 *   status          – 'idle' | 'waiting-gesture' | 'connecting' | 'reading'
 *                     | 'connected' | 'disconnected' | 'error' | 'unsupported'
 *   reading         – { tempC, humidity, timestamp } | null
 *   sensorName      – 'tps' | 'sps' | null
 *   connect()       – show OS picker (first-time pair)
 *   disconnect()    – manual disconnect
 *   triggerReconnect() – call this from any user-gesture handler (button tap).
 *                        Silently reconnects if disconnected/idle. No-op if
 *                        already connected. This is the key to hands-free
 *                        reconnection without ever showing the picker again.
 */
export function useInkbirdSensor(currentUser) {
  const [status,     setStatus]     = useState('idle');
  const [reading,    setReading]    = useState(null);
  const [sensorName, setSensorName] = useState(getSavedSensorName);

  const currentUserRef    = useRef(currentUser);
  currentUserRef.current  = currentUser;

  const deviceRef          = useRef(null);   // BluetoothDevice (persists across connects)
  const serverRef          = useRef(null);   // BluetoothRemoteGATTServer
  const notifyRef          = useRef(null);   // FFF6 characteristic
  const notifyHandlerRef   = useRef(null);
  const latestReadingRef   = useRef(null);   // always holds the most recent decoded reading
  const retryCount         = useRef(0);
  const retryTimer         = useRef(null);
  const periodicReadTimer  = useRef(null);
  const sensorNameRef      = useRef(getSavedSensorName());

  const mountedRef         = useRef(true);
  const connectingRef      = useRef(false);  // guard: prevent concurrent connect attempts

  const hasBluetooth  = typeof navigator !== 'undefined' && !!navigator.bluetooth;
  const hasGetDevices = hasBluetooth && typeof navigator.bluetooth.getDevices === 'function';

  // ── BLE capability guard ───────────────────────────────────────────────
  // Any touch device (phone or tablet) with Web Bluetooth can connect BLE.
  // Desktop PCs are excluded — not in the field, no Bluetooth sensor nearby.
  // is_primary_tracker is for GPS location only — it must NOT gate BLE here.
  const isTouchDevice = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0;
  const canUseBle = hasBluetooth && isTouchDevice;
  // isPrimaryDevice kept in return for API compat — now equals canUseBle

  // ── Internal: GATT connect + subscribe ─────────────────────────────────
  const connectDevice = useCallback(async (device) => {
    if (!mountedRef.current || connectingRef.current) return;
    connectingRef.current = true;
    setStatus('reading');

    try {
      // Cleanup any stale server
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

      // ── Snapshot read from FFF2 ───────────────────────────────────────
      try {
        const readChar = await service.getCharacteristic(INKBIRD_READ_UUID);
        const dv       = await readChar.readValue();
        const parsed   = decodeReading(dv);
        if (parsed && mountedRef.current) {
          latestReadingRef.current = parsed;
          setReading(parsed);
          setStatus('connected');
          retryCount.current = 0;
          window.dispatchEvent(new CustomEvent('inkbirdReading', {
            detail: { ...parsed, source: 'gatt-read' }
          }));
          persistHeartbeatReading(parsed, currentUserRef.current, sensorNameRef.current);
        }
      } catch (_) { /* FFF2 read not supported — fall through to notify */ }

      // ── Subscribe to FFF6 notifications ──────────────────────────────
      const notifyChar = await service.getCharacteristic(INKBIRD_NOTIFY_UUID);
      notifyRef.current = notifyChar;

      const handler = (evt) => {
        if (!mountedRef.current) return;
        const parsed = decodeReading(evt.target.value);
        if (parsed) {
          latestReadingRef.current = parsed;
          setReading(parsed);
          setStatus('connected');
          retryCount.current = 0;
          window.dispatchEvent(new CustomEvent('inkbirdReading', {
            detail: { ...parsed, source: 'gatt-notify' }
          }));
          // Auto-save periodic BLE readings to DB
          persistHeartbeatReading(parsed, currentUserRef.current, sensorNameRef.current);
        }
      };
      notifyHandlerRef.current = handler;
      notifyChar.addEventListener('characteristicvaluechanged', handler);
      await notifyChar.startNotifications();

      if (mountedRef.current) setStatus('connected');

      // ── Handle unexpected GATT disconnect ─────────────────────────────
      device.addEventListener('gattserverdisconnected', () => {
        if (!mountedRef.current) return;
        serverRef.current  = null;
        connectingRef.current = false;
        setStatus('disconnected');
        // Don't auto-reconnect via timer — wait for the next button tap gesture
        // to call triggerReconnect(). This avoids Chrome gesture requirement issues.
      });

    } catch (err) {
      if (!mountedRef.current) { connectingRef.current = false; return; }
      // If we've hit the retry limit, mark as error so the UI shows manual fallback
      if (retryCount.current >= MAX_RETRIES) {
        setStatus('error');
      } else {
        // Brief delay then mark as disconnected — triggerReconnect on next tap
        setStatus('disconnected');
      }
    } finally {
      connectingRef.current = false;
    }
  }, []);

  // ── triggerReconnect — call from any button tap handler ────────────────
  // This is the key API. StopCard wires this into every action button so that
  // any interaction from the driver silently reconnects the sensor if needed.
  const triggerReconnect = useCallback(() => {
    if (!mountedRef.current) return false;
    if (!canUseBle) return false;       // desktop or no Bluetooth
    if (!deviceRef.current) return false; // no device known yet — need manual pair
    if (connectingRef.current) return true; // already in-flight — treat as handled
    if (status === 'connected') return true; // already good
    connectDevice(deviceRef.current);
    return true; // reconnect initiated — caller should NOT fall back to picker
  }, [status, connectDevice, canUseBle]);

  // ── First-time manual pair ─────────────────────────────────────────────
  const connect = useCallback(async () => {
    if (!hasBluetooth) return;
    if (!canUseBle) return; // desktop or no Bluetooth — skip
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
      sensorNameRef.current = device.name;
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
    clearTimeout(retryTimer.current);
    clearInterval(periodicReadTimer.current);
    connectingRef.current = false;
    try {
      if (notifyRef.current && notifyHandlerRef.current) {
        notifyRef.current.removeEventListener('characteristicvaluechanged', notifyHandlerRef.current);
        notifyRef.current.stopNotifications().catch(() => {});
      }
      serverRef.current?.disconnect();
    } catch (_) {}
    // Revoke the browser's BLE permission so the sensor becomes discoverable
    // by other apps/devices. Only called on explicit disconnect (not unexpected
    // gattserverdisconnected).
    const device = deviceRef.current;
    if (device && typeof device.forget === 'function') {
      device.forget().catch(() => {});
    }
    notifyRef.current  = null;
    serverRef.current  = null;
    notifyHandlerRef.current = null;
    deviceRef.current  = null;
    setStatus('idle');
  }, []);

  // ── Force a fresh FFF2 read (callable externally) ─────────────────────
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
        window.dispatchEvent(new CustomEvent('inkbirdReading', {
          detail: { ...parsed, source: 'gatt-force-read' },
        }));
        persistHeartbeatReading(parsed, currentUserRef.current, sensorNameRef.current);
      }
    } catch (_) {}
  }, []);

  // ── Periodic 1-minute FFF2 read — keepalive for stable-temp scenarios ──────
  useEffect(() => {
    if (status === 'connected') {
      clearInterval(periodicReadTimer.current);
      periodicReadTimer.current = setInterval(() => {
        forceRead();
      }, PERIODIC_READ_MS);
    } else {
      clearInterval(periodicReadTimer.current);
    }
    return () => clearInterval(periodicReadTimer.current);
  }, [status, forceRead]);

  // ── Mount: find previously-permitted device but don't connect yet ──────
  // We just store the device ref so triggerReconnect() can use it on first tap.
  useEffect(() => {
    mountedRef.current = true;

    if (!hasBluetooth) { setStatus('unsupported'); return; }

    // Any touch device with Web Bluetooth can use BLE.
    // Desktop devices (maxTouchPoints === 0) are excluded — they don't have
    // Bluetooth in the field and the 'non-primary' block was causing the
    // tablet tap to silently no-op.
    if (!canUseBle) {
      setStatus('non-primary');
      return;
    }

    if (!hasGetDevices) {
      // Can't auto-find permitted devices — need manual pair
      setStatus('idle');
      return;
    }

    navigator.bluetooth.getDevices().then(devices => {
      if (!mountedRef.current) return;
      const inkbird = devices.find(d => INKBIRD_NAMES.includes(d.name));
      if (inkbird) {
        deviceRef.current = inkbird;
        setSensorName(inkbird.name);
        sensorNameRef.current = inkbird.name;
        saveSensorNameLocally(inkbird.name);
        // Mark as waiting for a gesture to connect
        setStatus('waiting-gesture');
      } else {
        setStatus('idle');
      }
    }).catch(() => {
      if (mountedRef.current) setStatus('idle');
    });

    return () => {
      mountedRef.current = false;
      clearTimeout(retryTimer.current);
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
    isPrimaryDevice: canUseBle, // kept for API compat — true means BLE is available on this device
    connect,
    disconnect,
    triggerReconnect,
    forceRead,
  };
}