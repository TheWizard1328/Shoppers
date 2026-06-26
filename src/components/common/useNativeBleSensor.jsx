/**
 * useNativeBleSensor.js
 *
 * Native BLE implementation for Inkbird IBS-TH2 using
 * @capacitor-community/bluetooth-le. Used ONLY when isCapacitorNativeApp()
 * is true. Provides the same API surface as useInkbirdSensor.
 *
 * BleClient is lazy-imported so this module doesn't crash on web/PWA builds
 * where the native plugin bridge is absent.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { base44 } from '@/api/base44Client';

const INKBIRD_SERVICE_UUID    = '0000fff0-0000-1000-8000-00805f9b34fb';
const INKBIRD_NOTIFY_UUID     = '0000fff6-0000-1000-8000-00805f9b34fb';
const INKBIRD_READ_UUID       = '0000fff2-0000-1000-8000-00805f9b34fb';
const INKBIRD_NAME_PREFIXES   = ['tps', 'sps', 'inkbird', 'ibs'];
const LOCAL_STORAGE_KEY       = 'rxdeliver_inkbird_sensor_name';
const DEVICE_ID_KEY           = 'rxdeliver_inkbird_device_id';
const RECONNECT_INTERVAL_MS   = 10000;
const PERIODIC_READ_MS        = 60 * 1000; // 1 minute — FFF6 notifications fire every ~1-2s; we force an FFF2 read once/min as a keepalive
const SCAN_DURATION_MS        = 5000;

// ── Lazy BleClient loader ─────────────────────────────────────────────────────
// The native plugin is only registered on APK/IPA builds. On web/PWA the
// package still installs but the bridge doesn't exist, so we defer the import
// until we actually need it (inside async functions, never at module top-level).
let _BleClient = null;
async function getBleClient() {
  if (_BleClient) return _BleClient;
  try {
    const mod = await import('@capacitor-community/bluetooth-le');
    _BleClient = mod.BleClient;
    return _BleClient;
  } catch (_) {
    return null;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function decodeReading(dataView) {
  if (!dataView || dataView.byteLength < 2) return null;
  const tempC = +(dataView.getUint16(0, true) / 100).toFixed(2);
  if (tempC < -40 || tempC > 85) return null;
  const humidity = dataView.byteLength >= 6 ? dataView.getUint8(5) : null;
  return { tempC, humidity, timestamp: new Date().toISOString() };
}

function getSavedDeviceId() {
  try { return localStorage.getItem(DEVICE_ID_KEY); } catch (_) { return null; }
}
function saveDeviceId(id) {
  try { localStorage.setItem(DEVICE_ID_KEY, id); } catch (_) {}
}
function getSavedSensorName() {
  try { return localStorage.getItem(LOCAL_STORAGE_KEY); } catch (_) { return null; }
}
function saveSensorName(name) {
  try { localStorage.setItem(LOCAL_STORAGE_KEY, name); } catch (_) {}
}

async function persistSensorToUserDevice(currentUser, sensorName, deviceId) {
  if (!currentUser?.id) return;
  try {
    const storedDeviceId = localStorage.getItem('rxdeliver_device_id');
    if (!storedDeviceId) return;
    const records = await base44.entities.UserDevice.filter({ device_identifier: storedDeviceId });
    if (!records?.length) return;
    await base44.entities.UserDevice.update(records[0].id, {
      device_info: {
        ...(records[0].device_info || {}),
        inkbird_sensor: { name: sensorName, device_id: deviceId, paired_at: new Date().toISOString() },
      },
    });
  } catch (_) {}
}

// ── Hook ──────────────────────────────────────────────────────────────────────
export function useNativeBleSensor(currentUser) {
  const [status,     setStatus]     = useState('idle');
  const [reading,    setReading]    = useState(null);
  const [sensorName, setSensorName] = useState(getSavedSensorName);

  const deviceIdRef       = useRef(getSavedDeviceId());
  const mountedRef        = useRef(true);
  const connectingRef     = useRef(false);
  const connectedRef      = useRef(false);
  const reconnectTimerRef = useRef(null);
  const bleInitRef        = useRef(false);
  const periodicReadTimerRef = useRef(null); // 1-min FFF2 keepalive read

  // ── Init BleClient once ───────────────────────────────────────────────────
  const initBle = useCallback(async () => {
    if (bleInitRef.current) return true;
    const BleClient = await getBleClient();
    if (!BleClient) return false;
    try {
      await BleClient.initialize({ androidNeverForLocation: true });
      bleInitRef.current = true;
      return true;
    } catch (err) {
      console.warn('[NativeBLE] BleClient.initialize failed:', err?.message);
      return false;
    }
  }, []);

  // ── Schedule background reconnect ────────────────────────────────────────
  // Declared before connectToDevice/scanAndConnect so they can reference it.
  const scheduleReconnect = useCallback(() => {
    clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = setTimeout(() => {
      if (!mountedRef.current || connectedRef.current) return;
      console.log('[NativeBLE] Attempting background reconnect...');
      // connectToDevice / scanAndConnect are referenced via refs below
      if (deviceIdRef.current) {
        connectToDeviceRef.current?.(deviceIdRef.current);
      } else {
        scanAndConnectRef.current?.();
      }
    }, RECONNECT_INTERVAL_MS);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const connectToDeviceRef = useRef(null);
  const scanAndConnectRef  = useRef(null);

  // ── Connect to a known device ID ─────────────────────────────────────────
  const connectToDevice = useCallback(async (deviceId) => {
    if (!mountedRef.current || connectingRef.current || connectedRef.current) return;
    const BleClient = await getBleClient();
    if (!BleClient) return;

    connectingRef.current = true;
    setStatus('connecting');

    try {
      await BleClient.connect(deviceId, () => {
        if (!mountedRef.current) return;
        connectedRef.current = false;
        connectingRef.current = false;
        setStatus('disconnected');
        scheduleReconnect();
      });

      if (!mountedRef.current) {
        await BleClient.disconnect(deviceId).catch(() => {});
        connectingRef.current = false;
        return;
      }

      connectedRef.current = true;

      // Snapshot read from FFF2
      try {
        const dv = await BleClient.read(deviceId, INKBIRD_SERVICE_UUID, INKBIRD_READ_UUID);
        const parsed = decodeReading(dv);
        if (parsed && mountedRef.current) {
          setReading(parsed);
          window.dispatchEvent(new CustomEvent('inkbirdReading', { detail: { ...parsed, source: 'native-read' } }));
        }
      } catch (_) {}

      // Subscribe to FFF6 notifications
      await BleClient.startNotifications(deviceId, INKBIRD_SERVICE_UUID, INKBIRD_NOTIFY_UUID, (dv) => {
        if (!mountedRef.current) return;
        const parsed = decodeReading(dv);
        if (parsed) {
          setReading(parsed);
          window.dispatchEvent(new CustomEvent('inkbirdReading', { detail: { ...parsed, source: 'native-notify' } }));
        }
      });

      if (mountedRef.current) setStatus('connected');

    } catch (err) {
      if (!mountedRef.current) { connectingRef.current = false; return; }
      console.warn('[NativeBLE] Connection failed:', err?.message);
      connectedRef.current = false;
      setStatus('disconnected');
      scheduleReconnect();
    } finally {
      connectingRef.current = false;
    }
  }, [scheduleReconnect]);

  // ── Scan for known sensor by name prefix ─────────────────────────────────
  const scanAndConnect = useCallback(async () => {
    if (!mountedRef.current || connectingRef.current || connectedRef.current) return;
    const ok = await initBle();
    if (!ok) return;
    const BleClient = await getBleClient();
    if (!BleClient) return;

    setStatus('scanning');
    let found = false;

    try {
      await BleClient.requestLEScan(
        { services: [INKBIRD_SERVICE_UUID], allowDuplicates: false },
        (result) => {
          if (found || !mountedRef.current) return;
          const name = (result.device?.name || result.localName || '').toLowerCase();
          const isInkbird = INKBIRD_NAME_PREFIXES.some(p => name.startsWith(p));
          if (!isInkbird) return;

          found = true;
          BleClient.stopLEScan().catch(() => {});

          const newId = result.device.deviceId;
          deviceIdRef.current = newId;
          saveDeviceId(newId);
          saveSensorName(result.device.name || name);
          setSensorName(result.device.name || name);
          persistSensorToUserDevice(currentUser, result.device.name || name, newId);
          connectToDevice(newId);
        }
      );

      setTimeout(async () => {
        if (!found) {
          try { await BleClient.stopLEScan(); } catch (_) {}
          if (mountedRef.current && !connectedRef.current) setStatus('disconnected');
        }
      }, SCAN_DURATION_MS);

    } catch (err) {
      console.warn('[NativeBLE] Scan failed:', err?.message);
      if (mountedRef.current) setStatus('disconnected');
    }
  }, [currentUser, initBle, connectToDevice]);

  // Keep refs up-to-date so scheduleReconnect can call them
  connectToDeviceRef.current = connectToDevice;
  scanAndConnectRef.current  = scanAndConnect;

  // ── forceRead — demand a fresh FFF2 read from the sensor ──────────────
  const forceRead = useCallback(async () => {
    const id = deviceIdRef.current;
    if (!id || !connectedRef.current) return;
    const BleClient = await getBleClient();
    if (!BleClient) return;
    try {
      const dv = await BleClient.read(id, INKBIRD_SERVICE_UUID, INKBIRD_READ_UUID);
      const parsed = decodeReading(dv);
      if (parsed && mountedRef.current) {
        setReading(parsed);
        window.dispatchEvent(new CustomEvent('inkbirdReading', { detail: { ...parsed, source: 'native-force-read' } }));
      }
    } catch (_) {}
  }, []);

  // ── Periodic 1-minute FFF2 read — keeps readings flowing in stable temps ────
  // FFF6 notifications arrive every ~1-2s so the reading state stays live,
  // but LiveTempBadge only persists once per HEARTBEAT_MS. This forceRead
  // ensures the FFF2 characteristic is polled as a keepalive and refreshes
  // the reading even if the temp hasn't changed (stable cooler scenario).
  useEffect(() => {
    if (status === 'connected') {
      clearInterval(periodicReadTimerRef.current);
      periodicReadTimerRef.current = setInterval(() => {
        if (connectedRef.current) forceRead();
      }, PERIODIC_READ_MS);
    } else {
      clearInterval(periodicReadTimerRef.current);
    }
    return () => clearInterval(periodicReadTimerRef.current);
  }, [status, forceRead]);

  // ── Mount: auto-connect if we have a saved device ID, else scan ───────────
  useEffect(() => {
    mountedRef.current = true;

    const startup = async () => {
      // Inactive branch — bridge passed null user to disable this hook
      if (!currentUser && currentUser !== undefined) return;

      const ok = await initBle();
      if (!ok || !mountedRef.current) return;

      if (deviceIdRef.current) {
        connectToDevice(deviceIdRef.current);
      } else if (getSavedSensorName()) {
        scanAndConnect();
      } else {
        setStatus('idle');
      }
    };

    startup();

    return () => {
      mountedRef.current = false;
      clearTimeout(reconnectTimerRef.current);
      clearInterval(periodicReadTimerRef.current);
      const id = deviceIdRef.current;
      if (id && connectedRef.current) {
        getBleClient().then(BleClient => {
          if (!BleClient) return;
          BleClient.stopNotifications(id, INKBIRD_SERVICE_UUID, INKBIRD_NOTIFY_UUID).catch(() => {});
          BleClient.disconnect(id).catch(() => {});
        });
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── First-time manual pair ────────────────────────────────────────────────
  const connect = useCallback(async () => {
    const ok = await initBle();
    if (!ok) return;
    const BleClient = await getBleClient();
    if (!BleClient) return;

    setStatus('connecting');
    try {
      const device = await BleClient.requestDevice({
        services: [INKBIRD_SERVICE_UUID],
        optionalServices: [],
      });
      if (!mountedRef.current) return;
      const newId = device.deviceId;
      deviceIdRef.current = newId;
      saveDeviceId(newId);
      saveSensorName(device.name || newId);
      setSensorName(device.name || newId);
      persistSensorToUserDevice(currentUser, device.name || newId, newId);
      await connectToDevice(newId);
    } catch (err) {
      if (!mountedRef.current) return;
      setStatus(err?.name === 'NotFoundError' || err?.code === 'cancelled' ? 'idle' : 'error');
    }
  }, [currentUser, initBle, connectToDevice]);

  // ── Manual disconnect ─────────────────────────────────────────────────────
  const disconnect = useCallback(async () => {
    clearTimeout(reconnectTimerRef.current);
    clearInterval(periodicReadTimerRef.current);
    const id = deviceIdRef.current;
    if (id) {
      const BleClient = await getBleClient();
      if (BleClient) {
        try {
          await BleClient.stopNotifications(id, INKBIRD_SERVICE_UUID, INKBIRD_NOTIFY_UUID);
          await BleClient.disconnect(id);
        } catch (_) {}
      }
    }
    connectedRef.current = false;
    connectingRef.current = false;
    setStatus('idle');
  }, []);

  // ── triggerReconnect — API compat with web hook ───────────────────────────
  const triggerReconnect = useCallback(() => {
    if (connectedRef.current || connectingRef.current) return;
    if (deviceIdRef.current) {
      connectToDevice(deviceIdRef.current);
    } else {
      scanAndConnect();
    }
  }, [connectToDevice, scanAndConnect]);

  return {
    status,
    reading,
    sensorName,
    isPrimaryDevice: true,
    connect,
    disconnect,
    triggerReconnect,
    forceRead,
  };
}