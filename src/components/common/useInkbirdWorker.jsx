/**
 * useInkbirdWorker.jsx
 *
 * BLE worker hook extracted from InkbirdRawDiagnostic — uses the exact same
 * connection logic that works reliably on Android Chrome:
 *   • 3-attempt GATT connect with 600ms stabilisation wait per attempt
 *   • FFF2 read on connect for an immediate first reading
 *   • FFF6 notifications subscribed
 *   • FFF2 polled every 2s as a fallback (runs alongside notifications)
 *   • No auto-disconnect / stale-guard timeouts
 *   • Calls onReading(tempC) on every reading so the caller can persist/display
 *
 * Status: 'idle' | 'connecting' | 'active' | 'error' | 'disconnected'
 */

import { useState, useRef, useCallback, useEffect } from 'react';

const INKBIRD_SERVICE  = '0000fff0-0000-1000-8000-00805f9b34fb';
const INKBIRD_NAMES    = ['tps', 'sps'];
const POLL_INTERVAL_MS = 2000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function isInkbird(name) {
  return name && INKBIRD_NAMES.some(n => name === n || name.startsWith(n) ||
    name.startsWith('Inkbird') || name.startsWith('IBS'));
}

function decodeFff2(bytes) {
  if (!bytes || bytes.length < 2) return null;
  const raw = (bytes[1] << 8) | bytes[0]; // uint16LE
  const t   = +(raw / 100).toFixed(2);
  return (t > -40 && t < 85) ? t : null;
}

export function useInkbirdWorker({ onReading } = {}) {
  const [status,     setStatus]     = useState('idle');
  const [temp,       setTemp]       = useState(null);
  const [sensorName, setSensorName] = useState(() => {
    try { return localStorage.getItem('rxdeliver_inkbird_sensor_name'); } catch (_) { return null; }
  });

  const deviceRef   = useRef(null);
  const serverRef   = useRef(null);
  const subsRef     = useRef([]);
  const pollRef     = useRef(null);
  const fff2Ref     = useRef(null);
  const stoppedRef  = useRef(false);
  const mountedRef  = useRef(true);
  const onReadingRef = useRef(onReading);

  // Keep the callback ref current without causing reconnects
  useEffect(() => { onReadingRef.current = onReading; }, [onReading]);

  useEffect(() => {
    mountedRef.current = true;
    // On mount: find a previously-permitted Inkbird device
    if (typeof navigator !== 'undefined' && navigator.bluetooth &&
        typeof navigator.bluetooth.getDevices === 'function') {
      navigator.bluetooth.getDevices().then(devs => {
        const ink = devs.find(d => isInkbird(d.name));
        if (ink && mountedRef.current) {
          deviceRef.current = ink;
          setSensorName(ink.name);
        }
      }).catch(() => {});
    }
    return () => {
      mountedRef.current = false;
      _stop(false);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const _pushTemp = useCallback((t) => {
    if (!mountedRef.current) return;
    setTemp(t);
    try { onReadingRef.current?.(t); } catch (_) {}
  }, []);

  const _stop = useCallback(async (updateState = true) => {
    stoppedRef.current = true;
    clearInterval(pollRef.current);
    pollRef.current = null;
    fff2Ref.current = null;

    for (const ch of subsRef.current) {
      try { await ch.stopNotifications(); } catch (_) {}
    }
    subsRef.current = [];

    try { serverRef.current?.disconnect(); } catch (_) {}
    serverRef.current = null;

    if (updateState && mountedRef.current) {
      await sleep(200);
      setStatus('disconnected');
    }
  }, []);

  // ── ensureDevice — reuse paired, show picker only on first pair ─────────
  const _ensureDevice = useCallback(async () => {
    if (deviceRef.current) return deviceRef.current;

    if (typeof navigator?.bluetooth?.getDevices === 'function') {
      const devs = await navigator.bluetooth.getDevices();
      const ink  = devs.find(d => isInkbird(d.name));
      if (ink) {
        deviceRef.current = ink;
        setSensorName(ink.name);
        try { localStorage.setItem('rxdeliver_inkbird_sensor_name', ink.name); } catch (_) {}
        return ink;
      }
    }

    const d = await navigator.bluetooth.requestDevice({
      filters: [{ name: 'tps' }, { name: 'sps' }, { namePrefix: 'Inkbird' }, { namePrefix: 'IBS' }],
      optionalServices: [INKBIRD_SERVICE, 'generic_access'],
    });
    deviceRef.current = d;
    setSensorName(d.name);
    try { localStorage.setItem('rxdeliver_inkbird_sensor_name', d.name); } catch (_) {}
    return d;
  }, []);

  // ── Main connect — identical retry/stabilise logic as the diagnostic ────
  const connect = useCallback(async () => {
    if (!mountedRef.current) return;
    stoppedRef.current = false;
    subsRef.current = [];
    setStatus('connecting');
    setTemp(null);

    try {
      const device = await _ensureDevice();

      // 3-attempt GATT connect with 600ms stabilisation
      let server = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          server = await Promise.race([
            device.gatt.connect(),
            new Promise((_, r) => setTimeout(() => r(new Error('timed out')), 10000)),
          ]);
        } catch (e) {
          if (attempt === 3) {
            if (e.message.includes('timed out') || e.message.includes('unknown reason')) {
              deviceRef.current = null;
              setSensorName(null);
              try { localStorage.removeItem('rxdeliver_inkbird_sensor_name'); } catch (_) {}
            }
            if (mountedRef.current) setStatus('error');
            return;
          }
          await sleep(1000 * attempt);
          continue;
        }

        await sleep(600); // wait for connection to stabilise
        if (server.connected) break;
        server = null;
        await sleep(1000 * attempt);
      }

      if (!server?.connected) {
        if (mountedRef.current) setStatus('error');
        return;
      }
      serverRef.current = server;

      // Enumerate services — retry once if server dropped mid-enum
      let services = [];
      for (let enumTry = 1; enumTry <= 2; enumTry++) {
        if (!server.connected) {
          try {
            server = await Promise.race([
              device.gatt.connect(),
              new Promise((_, r) => setTimeout(() => r(new Error('timed out')), 8000)),
            ]);
            serverRef.current = server;
            await sleep(600);
          } catch (_) { if (mountedRef.current) setStatus('error'); return; }
        }
        try {
          services = await server.getPrimaryServices();
          break;
        } catch (_) {
          if (enumTry === 1) {
            try { services = [await server.getPrimaryService(INKBIRD_SERVICE)]; break; } catch (_2) {}
          }
          if (enumTry === 2) { if (mountedRef.current) setStatus('error'); return; }
          await sleep(800);
        }
      }

      if (stoppedRef.current || !mountedRef.current) return;

      // Enumerate characteristics
      const chars = [];
      for (const svc of services) {
        let cs = [];
        try { cs = await svc.getCharacteristics(); } catch (_) {}
        for (const ch of cs) chars.push({ uuid: ch.uuid, svcUuid: svc.uuid, ch });
      }

      // One-shot FFF2 read for immediate first reading
      const fff2CharObj = chars.find(c => c.uuid.slice(4,8).toUpperCase() === 'FFF2');
      if (fff2CharObj) {
        try {
          const dv    = await fff2CharObj.ch.readValue();
          const bytes = Array.from({length: dv.byteLength}, (_, i) => dv.getUint8(i));
          const t     = decodeFff2(bytes);
          if (t !== null && mountedRef.current) _pushTemp(t);
        } catch (_) {}
      }

      // Subscribe notifications on all FFF0 chars
      const fff0Chars = chars.filter(c => c.svcUuid === INKBIRD_SERVICE);
      for (const c of fff0Chars) {
        try {
          await c.ch.startNotifications();
          subsRef.current.push(c.ch);
          const short = c.uuid.slice(4,8).toUpperCase();
          c.ch.addEventListener('characteristicvaluechanged', evt => {
            if (stoppedRef.current || !mountedRef.current) return;
            const dv    = evt.target.value;
            const bytes = Array.from({length: dv.byteLength}, (_, i) => dv.getUint8(i));
            if (short === 'FFF2' || short === 'FFF6') {
              const t = decodeFff2(bytes);
              if (t !== null) _pushTemp(t);
            }
          });
        } catch (_) {}
      }

      // FFF2 poll fallback (runs alongside notifications)
      if (fff2CharObj) {
        fff2Ref.current = fff2CharObj.ch;
        const poll = async () => {
          if (stoppedRef.current || !fff2Ref.current || !mountedRef.current) return;
          try {
            const dv    = await fff2Ref.current.readValue();
            const bytes = Array.from({length: dv.byteLength}, (_, i) => dv.getUint8(i));
            const t     = decodeFff2(bytes);
            if (t !== null) _pushTemp(t);
          } catch (_) {}
        };
        pollRef.current = setInterval(poll, POLL_INTERVAL_MS);
      }

      if (mountedRef.current) setStatus('active');

      // Watch for unexpected GATT disconnect
      device.addEventListener('gattserverdisconnected', () => {
        if (stoppedRef.current || !mountedRef.current) return;
        clearInterval(pollRef.current);
        if (mountedRef.current) setStatus('disconnected');
      });

    } catch (err) {
      if (err?.name === 'NotFoundError' || err?.name === 'AbortError') {
        if (mountedRef.current) setStatus('idle');
      } else {
        if (mountedRef.current) setStatus('error');
      }
    }
  }, [_ensureDevice, _pushTemp]);

  // ── Disconnect ──────────────────────────────────────────────────────────
  const disconnect = useCallback(() => _stop(true), [_stop]);

  // ── Forget / unpair ─────────────────────────────────────────────────────
  const forget = useCallback(async () => {
    if (serverRef.current?.connected) {
      await _stop(false);
      await sleep(200);
    }
    const oldName = deviceRef.current?.name || sensorName;
    serverRef.current = null;
    deviceRef.current = null;
    setSensorName(null);
    try { localStorage.removeItem('rxdeliver_inkbird_sensor_name'); } catch (_) {}
    // Revoke browser-level Bluetooth permission if API available
    try {
      const devices = await navigator.bluetooth.getDevices();
      for (const d of devices) {
        if (d.name === oldName && typeof d.forget === 'function') await d.forget();
      }
    } catch (_) {}
    if (mountedRef.current) setStatus('idle');
    setTemp(null);
  }, [_stop, sensorName]);

  return { status, temp, sensorName, connect, disconnect, forget };
}