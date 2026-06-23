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
const NOOP = () => {};
const NOOP_ASYNC = async () => {};

export function useInkbirdSensor(currentUser) {
  // When this hook is the inactive branch (bridge passes null), return a stable no-op.
  // We still need to call all hooks unconditionally (Rules of Hooks).
  const [status,     setStatus]     = useState('idle');
  const [reading,    setReading]    = useState(null);
  const [sensorName, setSensorName] = useState(getSavedSensorName);

  const deviceRef          = useRef(null);   // BluetoothDevice (persists across connects)
  const serverRef          = useRef(null);   // BluetoothRemoteGATTServer
  const notifyRef          = useRef(null);   // FFF6 characteristic
  const notifyHandlerRef   = useRef(null);
  const retryCount         = useRef(0);
  const retryTimer         = useRef(null);
  const mountedRef         = useRef(true);
  const connectingRef      = useRef(false);  // guard: prevent concurrent connect attempts

  const hasBluetooth  = typeof navigator !== 'undefined' && !!navigator.bluetooth;
  const hasGetDevices = hasBluetooth && typeof navigator.bluetooth.getDevices === 'function';

  // ── BLE capability guard ───────────────────────────────────────────────
  // Allow BLE on any device that has Web Bluetooth. The maxTouchPoints check
  // was meant to exclude desktop, but it can return 0 on Android PWA before
  // the first interaction — causing connect() to silently no-op on phones.
  // If the user is a driver tapping the badge, they are on a mobile device.
  const canUseBle = hasBluetooth;
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
          setReading(parsed);
          setStatus('connected');
          retryCount.current = 0;
          window.dispatchEvent(new CustomEvent('inkbirdReading', {
            detail: { ...parsed, source: 'gatt-read' }
          }));
        }
      } catch (_) { /* FFF2 read not supported — fall through to notify */ }

      // ── Subscribe to FFF6 notifications ──────────────────────────────
      const notifyChar = await service.getCharacteristic(INKBIRD_NOTIFY_UUID);
      notifyRef.current = notifyChar;

      const handler = (evt) => {
        if (!mountedRef.current) return;
        const parsed = decodeReading(evt.target.value);
        if (parsed) {
          setReading(parsed);
          setStatus('connected');
          retryCount.current = 0;
          window.dispatchEvent(new CustomEvent('inkbirdReading', {
            detail: { ...parsed, source: 'gatt-notify' }
          }));
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
    if (!mountedRef.current) return;
    if (!canUseBle) return; // desktop or no Bluetooth — skip BLE
    if (!deviceRef.current) return; // no device known yet — need manual pair first
    if (connectingRef.current) return; // already connecting
    if (status === 'connected') return; // already good
    connectDevice(deviceRef.current);
  }, [status, connectDevice, canUseBle]);

  // ── First-time manual pair ─────────────────────────────────────────────
  const connect = useCallback(async () => {
    if (!hasBluetooth) return;
    if (!canUseBle) return; // desktop or no Bluetooth — skip
    setStatus('connecting');
    try {
      // Try with name filters first; if the OS returns NotFoundError (device list
      // is empty — common on Android tablets when the BLE radio is in a low-power
      // state or the sensor advertises with a slight name variation), fall back to
      // acceptAllDevices so the picker still opens and the user can select manually.
      let device;
      try {
        device = await navigator.bluetooth.requestDevice({
          filters: [
            { name: 'tps' },
            { name: 'sps' },
            { namePrefix: 'tps' },
            { namePrefix: 'sps' },
            { namePrefix: 'Inkbird' },
            { namePrefix: 'IBS' },
          ],
          optionalServices: [INKBIRD_SERVICE_UUID],
        });
      } catch (filterErr) {
        // Only fall back if the picker was dismissed due to an empty filter list,
        // not if the user cancelled (NotFoundError with no devices shown yet).
        // We detect the "no matching devices" case by checking the error name AND
        // whether it likely came from an empty list vs. a user cancel.
        // On Android the error is still NotFoundError in both cases, so we always
        // try the fallback — the user will still see all BLE devices and can pick.
        if (filterErr?.name === 'NotFoundError' || filterErr?.name === 'TypeError') {
          device = await navigator.bluetooth.requestDevice({
            acceptAllDevices: true,
            optionalServices: [INKBIRD_SERVICE_UUID],
          });
        } else {
          throw filterErr;
        }
      }
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
    clearTimeout(retryTimer.current);
    connectingRef.current = false;
    try {
      if (notifyRef.current && notifyHandlerRef.current) {
        notifyRef.current.removeEventListener('characteristicvaluechanged', notifyHandlerRef.current);
        notifyRef.current.stopNotifications().catch(() => {});
      }
      serverRef.current?.disconnect();
    } catch (_) {}
    notifyRef.current  = null;
    serverRef.current  = null;
    notifyHandlerRef.current = null;
    setStatus('idle');
  }, []);

  // ── Mount: find previously-permitted device but don't connect yet ──────
  // We just store the device ref so triggerReconnect() can use it on first tap.
  useEffect(() => {
    mountedRef.current = true;

    // Inactive branch — bridge passed null user to disable this hook
    if (!currentUser && currentUser !== undefined) { setStatus('idle'); return; }

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
      const inkbird = devices.find(d =>
        d.name && (
          INKBIRD_NAMES.includes(d.name) ||
          INKBIRD_NAMES.some(n => d.name.startsWith(n)) ||
          d.name.startsWith('Inkbird') ||
          d.name.startsWith('IBS')
        )
      );
      if (inkbird) {
        deviceRef.current = inkbird;
        setSensorName(inkbird.name);
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
  };
}