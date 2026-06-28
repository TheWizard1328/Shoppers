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

// Fallback retry constants (mirrors InkbirdRawDiagnostic)
const FALLBACK_RETRIES     = 3;
const FALLBACK_RETRY_DELAY = 1000; // ms between retries
const POLL_INTERVAL_MS     = 3000; // FFF2 poll every 3s when notifications are the path

const sleep = ms => new Promise(r => setTimeout(r, ms));

function addLog(level, msg) {
  try {
    const entry = { level, message: msg, timestamp: new Date().toISOString(), source: 'useInkbirdSensor' };
    window.dispatchEvent(new CustomEvent('inkbirdBleLog', { detail: entry }));
  } catch (_) {}
}

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
  const deviceRef         = useRef(null);
  const notifyRef         = useRef(null);
  const notifyHandlerRef  = useRef(null);
  const pollRef           = useRef(null);
  const latestReadingRef  = useRef(null);
  const mountedRef        = useRef(true);
  const fallbackCountRef  = useRef(0);
  const fallbackTimerRef  = useRef(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearInterval(pollRef.current);
      clearTimeout(fallbackTimerRef.current);
      try {
        if (notifyRef.current && notifyHandlerRef.current) {
          notifyRef.current.removeEventListener('characteristicvaluechanged', notifyHandlerRef.current);
          notifyRef.current.stopNotifications().catch(() => {});
        }
        serverRef.current?.disconnect();
      } catch (_) {}
    };
  }, []);

  // ── Forget the current device (resets Bluetooth permission) ──────────
  const forgetDevice = useCallback(async () => {
    addLog('info', '[useInkbirdSensor] Running forget + repair fallback…');
    // Stop everything
    clearInterval(pollRef.current);
    pollRef.current = null;
    try {
      if (notifyRef.current && notifyHandlerRef.current) {
        notifyRef.current.removeEventListener('characteristicvaluechanged', notifyHandlerRef.current);
        await notifyRef.current.stopNotifications().catch(() => {});
      }
    } catch (_) {}
    notifyRef.current = null;
    notifyHandlerRef.current = null;

    try { serverRef.current?.disconnect(); } catch (_) {}
    serverRef.current = null;

    const oldDevice = deviceRef.current;
    deviceRef.current = null;

    // Revoke Bluetooth permission
    if (oldDevice && typeof navigator?.bluetooth?.getDevices === 'function') {
      try {
        const devices = await navigator.bluetooth.getDevices();
        for (const d of devices) {
          if (d.id === oldDevice.id || d.name === oldDevice.name) {
            if (typeof d.forget === 'function') await d.forget();
          }
        }
      } catch (_) {}
    }

    // Clear local sensor name
    try { localStorage.removeItem(LOCAL_STORAGE_KEY); } catch (_) {}
    setSensorName(null);
    setStatus('idle');
    setReading(null);
    latestReadingRef.current = null;
    await sleep(500);
  }, []);

  // ── Open the BLE picker (no filters — let user pick anything) ────────
  const openPickerAndReconnect = useCallback(async () => {
    if (!mountedRef.current || !navigator.bluetooth) return false;
    setStatus('connecting');
    try {
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ name: 'tps' }, { name: 'sps' }, { namePrefix: 'Inkbird' }, { namePrefix: 'IBS' }],
        optionalServices: [INKBIRD_SERVICE_UUID],
      });
      if (!mountedRef.current) return false;
      deviceRef.current = device;
      const name = device.name || 'sensor';
      setSensorName(name);
      saveSensorNameLocally(name);
      persistSensorToUserDevice(currentUser, name);
      return true;
    } catch (err) {
      if (err?.name !== 'NotFoundError' && err?.name !== 'AbortError') {
        console.warn('[useInkbirdSensor] picker error:', err?.message);
      }
      if (mountedRef.current) setStatus('disconnected');
      return false;
    }
  }, [currentUser]);

  // ── Connect GATT + discover service + subscribe notifications + polling ──
  const setupGatt = useCallback(async (device) => {
    if (!mountedRef.current) return false;

    // Connect with retry (mirrors InkbirdRawDiagnostic)
    let server = null;
    for (let attempt = 1; attempt <= FALLBACK_RETRIES; attempt++) {
      if (!mountedRef.current) return false;
      try {
        server = await Promise.race([
          device.gatt.connect(),
          new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 8000)),
        ]);
      } catch (_) {
        if (attempt < FALLBACK_RETRIES) await sleep(FALLBACK_RETRY_DELAY);
        continue;
      }
      await sleep(400);
      if (server?.connected) break;
      if (attempt < FALLBACK_RETRIES) await sleep(FALLBACK_RETRY_DELAY);
    }
    if (!server?.connected) return false;
    serverRef.current = server;

    if (!mountedRef.current) { server.disconnect(); return false; }

    // Get service
    let service;
    try {
      service = await Promise.race([
        server.getPrimaryService(INKBIRD_SERVICE_UUID),
        new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 6000)),
      ]);
    } catch (_) {
      return false;
    }

    // Snapshot read on FFF2
    let hasData = false;
    try {
      const readChar = await service.getCharacteristic(INKBIRD_READ_UUID);
      const dv = await readChar.readValue();
      const parsed = decodeReading(dv);
      if (parsed && mountedRef.current) {
        latestReadingRef.current = parsed;
        setReading(parsed);
        setStatus('connected');
        hasData = true;
        window.dispatchEvent(new CustomEvent('inkbirdReading', { detail: { ...parsed, source: 'gatt-read' } }));
      }
    } catch (_) {}

    // Subscribe FFF6
    try {
      const notifyChar = await service.getCharacteristic(INKBIRD_NOTIFY_UUID);
      notifyRef.current = notifyChar;
      const handler = (evt) => {
        if (!mountedRef.current) return;
        const parsed = decodeReading(evt.target.value);
        if (parsed) {
          latestReadingRef.current = parsed;
          setReading(parsed);
          setStatus('connected');
          fallbackCountRef.current = 0; // reset fallback — data is flowing
          window.dispatchEvent(new CustomEvent('inkbirdReading', { detail: { ...parsed, source: 'gatt-notify' } }));
        }
      };
      notifyHandlerRef.current = handler;
      notifyChar.addEventListener('characteristicvaluechanged', handler);
      await notifyChar.startNotifications();
      // Mark connected regardless of snapshot — notifications will deliver
      if (mountedRef.current) setStatus('connected');
    } catch (_) {
      // Notification failed — status stays as-is (may still have snapshot)
      // Polling will be the fallback
    }

    // ── Poll FFF2 every 3s as safety net ────────────────────────────────
    const fff2Char = await service.getCharacteristic(INKBIRD_READ_UUID).catch(() => null);
    if (fff2Char) {
      clearInterval(pollRef.current);
      const poll = async () => {
        if (!mountedRef.current || !fff2Char) return;
        try {
          const dv = await fff2Char.readValue();
          const parsed = decodeReading(dv);
          if (parsed && mountedRef.current) {
            latestReadingRef.current = parsed;
            setReading(parsed);
            setStatus('connected');
            fallbackCountRef.current = 0;
          }
        } catch (_) {}
      };
      pollRef.current = setInterval(poll, POLL_INTERVAL_MS);
    }

    // Watch disconnect → trigger fallback
    device.addEventListener('gattserverdisconnected', () => {
      if (!mountedRef.current) return;
      serverRef.current = null;
      setStatus('disconnected');
      triggerFallback();
    });

    return true;
  }, []);

  // ── Fallback orchestrator ────────────────────────────────────────────
  const triggerFallback = useCallback(async () => {
    // Avoid stacking multiple fallback cycles
    clearTimeout(fallbackTimerRef.current);
    fallbackTimerRef.current = setTimeout(async () => {
      if (!mountedRef.current) return;
      addLog('warn', '[useInkbirdSensor] Fallback: forgetting device…');
      await forgetDevice();
      if (!mountedRef.current) return;
      addLog('info', '[useInkbirdSensor] Fallback: opening picker…');
      const picked = await openPickerAndReconnect();
      if (picked && deviceRef.current && mountedRef.current) {
        addLog('info', '[useInkbirdSensor] Fallback: reconnecting GATT…');
        const ok = await setupGatt(deviceRef.current);
        if (ok) {
          addLog('info', '[useInkbirdSensor] Fallback: success');
        } else {
          addLog('warn', '[useInkbirdSensor] Fallback: GATT setup failed after re-pair');
        }
      }
    }, 2000); // 2s delay before triggering — allows rapid disconnects to settle
  }, [forgetDevice, openPickerAndReconnect, setupGatt]);

  // ── setConnectedDevice ────────────────────────────────────────────────
  const setConnectedDevice = useCallback(async (device) => {
    if (!mountedRef.current) return;
    fallbackCountRef.current = 0;

    // Clean up previous
    clearInterval(pollRef.current);
    pollRef.current = null;
    try {
      if (notifyRef.current && notifyHandlerRef.current) {
        notifyRef.current.removeEventListener('characteristicvaluechanged', notifyHandlerRef.current);
        await notifyRef.current.stopNotifications().catch(() => {});
      }
    } catch (_) {}
    notifyRef.current = null;
    notifyHandlerRef.current = null;

    deviceRef.current = device;
    const name = device.name || 'sensor';
    setSensorName(name);
    saveSensorNameLocally(name);
    persistSensorToUserDevice(currentUser, name);

    // Mirror the diagnostic: if device is already connected, ensure we use that handle
    if (device.gatt.connected) {
      serverRef.current = device.gatt;
    }

    const ok = await setupGatt(device);
    if (!ok && mountedRef.current) {
      setStatus('error');
      triggerFallback();
    }
  }, [currentUser, setupGatt, triggerFallback]);

  // forceRead
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
        fallbackCountRef.current = 0;
        window.dispatchEvent(new CustomEvent('inkbirdReading', { detail: { ...parsed, source: 'forced-read' } }));
      }
    } catch (_) {}
  }, []);

  return {
    status,
    reading,
    sensorName,
    latestReadingRef,
    setConnectedDevice,
    forceRead,
    triggerFallback,
    forgetDevice,
    connect:          () => {},
    triggerReconnect: () => false,
    isPrimaryDevice:  typeof navigator !== 'undefined' && !!navigator.bluetooth,
  };
}