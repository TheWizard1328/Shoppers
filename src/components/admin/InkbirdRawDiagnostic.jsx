/**
 * InkbirdRawDiagnostic.jsx
 *
 * BLE diagnostic for Inkbird IBS-TH2 sensors.
 *
 * GATT is the only reliable path on Android Chrome.
 * requestLEScan (advertisement scanning) is partially implemented on Android
 * Chrome behind an experimental flag and does not reliably fire
 * advertisementreceived events — dropped from this diagnostic.
 *
 * GATT approach confirmed working:
 *   Service  0xFFF0
 *   FFF2  READ   → uint16LE ÷ 100 @ bytes [0:1] = temperature °C
 *   FFF6  NOTIFY → same layout, pushed every ~1-2 s when subscribed
 */

import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Bluetooth, BluetoothSearching, Thermometer, Trash2, RefreshCw, Unplug } from 'lucide-react';

const INKBIRD_SERVICE  = '0000fff0-0000-1000-8000-00805f9b34fb';
const INKBIRD_NAMES    = ['tps', 'sps'];
const POLL_INTERVAL_MS = 2000;   // FFF2 poll rate when notifications unavailable
const LISTEN_MS        = 60000;  // auto-stop after 60 s

function bytesToHex(arr) {
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

function decodeFff2(bytes) {
  if (!bytes || bytes.length < 2) return null;
  const raw = (bytes[1] << 8) | bytes[0]; // uint16LE
  const t   = +(raw / 100).toFixed(2);
  return (t > -40 && t < 85) ? t : null;
}

function decodeAllTemps(bytes) {
  if (!bytes || bytes.length < 2) return [];
  const dv  = new DataView(new Uint8Array(bytes).buffer);
  const out = [];
  for (let i = 0; i <= bytes.length - 2; i++) {
    for (const div of [100, 10]) {
      for (const [raw, label] of [
        [dv.getInt16(i, true),   `int16LE÷${div}`],
        [dv.getInt16(i, false),  `int16BE÷${div}`],
        [dv.getUint16(i, true),  `uint16LE÷${div}`],
        [dv.getUint16(i, false), `uint16BE÷${div}`],
      ]) {
        const val = +(raw / div).toFixed(2);
        if (val > -40 && val < 85) out.push({ offset: i, label, val });
      }
    }
  }
  return out;
}

function isInkbird(name) {
  return name && INKBIRD_NAMES.some(n => name === n || name.startsWith(n));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Temp history sparkline (pure SVG, no deps) ────────────────────────────
function TempSparkline({ history }) {
  if (history.length < 2) return null;
  const W = 200, H = 40, PAD = 4;
  const vals = history.map(h => h.temp);
  const min  = Math.min(...vals) - 0.5;
  const max  = Math.max(...vals) + 0.5;
  const range = max - min || 1;
  const pts = vals.map((v, i) => {
    const x = PAD + (i / (vals.length - 1)) * (W - PAD * 2);
    const y = H - PAD - ((v - min) / range) * (H - PAD * 2);
    return `${x},${y}`;
  }).join(' ');
  return (
    <svg width={W} height={H} className="overflow-visible">
      <polyline points={pts} fill="none" stroke="#0891b2" strokeWidth="1.5" strokeLinejoin="round" />
      {history.slice(-1).map((h, _) => {
        const x = W - PAD;
        const y = H - PAD - ((h.temp - min) / range) * (H - PAD * 2);
        return <circle key="dot" cx={x} cy={y} r="3" fill="#0891b2" />;
      })}
    </svg>
  );
}

export default function InkbirdRawDiagnostic() {
  const [status,    setStatus]    = useState('idle');
  // idle | connecting | reading | polling | error
  const [temp,      setTemp]      = useState(null);
  const [history,   setHistory]   = useState([]);  // [{temp, ts}]
  const [charList,  setCharList]  = useState([]);
  const [packets,   setPackets]   = useState([]);
  const [log,       setLog]       = useState([]);
  const [error,     setError]     = useState('');
  const [paired,    setPaired]    = useState(null);

  const deviceRef   = useRef(null);
  const serverRef   = useRef(null);
  const subsRef     = useRef([]);
  const pollRef     = useRef(null);
  const fff2Ref     = useRef(null);
  const stoppedRef  = useRef(false);
  const packetsRef  = useRef([]);
  const autoStopRef = useRef(null);

  const hasBluetooth  = typeof navigator !== 'undefined' && !!navigator.bluetooth;
  const hasGetDevices = hasBluetooth && typeof navigator.bluetooth.getDevices === 'function';

  const addLog = useCallback(msg =>
    setLog(p => [`[${new Date().toLocaleTimeString()}] ${msg}`, ...p.slice(0, 149)]), []);

  const pushTemp = useCallback((t, source, uuid, hex, bytes) => {
    setTemp(t);
    setHistory(h => [...h.slice(-59), { temp: t, ts: new Date().toLocaleTimeString() }]);
    const pkt = {
      id: Date.now() + Math.random(),
      ts: new Date().toLocaleTimeString(),
      type: source,
      uuid, hex, bytes,
      temp: t,
      allTemps: decodeAllTemps(bytes),
    };
    packetsRef.current = [pkt, ...packetsRef.current.slice(0, 99)];
    setPackets([...packetsRef.current]);
  }, []);

  // ── On mount: look for previously-permitted Inkbird ───────────────────────
  useEffect(() => {
    if (!hasGetDevices) return;
    navigator.bluetooth.getDevices().then(devs => {
      const ink = devs.find(d => isInkbird(d.name));
      if (ink) { deviceRef.current = ink; setPaired(ink.name); }
    }).catch(() => {});
  }, [hasGetDevices]);

  // ── Stop & teardown ───────────────────────────────────────────────────────
  const stop = useCallback(async () => {
    stoppedRef.current = true;
    clearInterval(pollRef.current);
    clearTimeout(autoStopRef.current);
    pollRef.current = null;
    fff2Ref.current = null;

    for (const ch of subsRef.current) {
      try { await ch.stopNotifications(); } catch (_) {}
    }
    subsRef.current = [];

    try { serverRef.current?.disconnect(); } catch (_) {}
    serverRef.current = null;

    await sleep(300);
    setStatus('idle');
    addLog('Stopped.');
  }, [addLog]);

  useEffect(() => () => { stoppedRef.current = true; stop(); }, []); // eslint-disable-line

  // ── ensureDevice — reuses paired device, shows picker only first time ─────
  const ensureDevice = useCallback(async () => {
    if (deviceRef.current) {
      addLog(`Reusing paired device: "${deviceRef.current.name}"`);
      return deviceRef.current;
    }
    if (hasGetDevices) {
      const devs = await navigator.bluetooth.getDevices();
      const ink  = devs.find(d => isInkbird(d.name));
      if (ink) {
        deviceRef.current = ink; setPaired(ink.name);
        addLog(`Auto-found: "${ink.name}"`);
        return ink;
      }
    }
    addLog('Opening device picker…');
    const d = await navigator.bluetooth.requestDevice({
      filters: [{ name: 'tps' }, { name: 'sps' }, { namePrefix: 'Inkbird' }, { namePrefix: 'IBS' }],
      optionalServices: [INKBIRD_SERVICE, 'generic_access'],
    });
    deviceRef.current = d; setPaired(d.name);
    addLog(`Selected: "${d.name}"`);
    return d;
  }, [addLog, hasGetDevices]);

  // ── Main scan ─────────────────────────────────────────────────────────────
  const start = useCallback(async () => {
    setPackets([]); packetsRef.current = [];
    setLog([]); setError(''); setCharList([]);
    setHistory([]); setTemp(null);
    stoppedRef.current = false;
    subsRef.current    = [];
    setStatus('connecting');

    try {
      const device = await ensureDevice();

      // ── Connect with retry — Android Chrome drops the link immediately
      // after connect() resolves if the OS BLE stack isn't ready yet.
      // Wait 600ms after connect, verify server.connected, retry up to 3x.
      let server = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        addLog(`gatt.connect() attempt ${attempt}/3…`);
        try {
          server = await Promise.race([
            device.gatt.connect(),
            new Promise((_, r) => setTimeout(() => r(new Error('timed out')), 10000)),
          ]);
        } catch (e) {
          addLog(`✗ connect attempt ${attempt}: ${e.message}`);
          if (attempt === 3) {
            if (e.message.includes('timed out') || e.message.includes('unknown reason')) {
              addLog('Device ref stale — click Forget and re-pair.');
              deviceRef.current = null; setPaired(null);
            }
            setError(e.message); setStatus('error'); return;
          }
          await sleep(1000 * attempt);
          continue;
        }
        // Wait for connection to stabilise before enumerating
        await sleep(600);
        if (server.connected) {
          addLog(`✓ GATT connected (attempt ${attempt})`);
          break;
        } else {
          addLog(`Connection dropped immediately (attempt ${attempt}) — retrying…`);
          server = null;
          await sleep(1000 * attempt);
        }
      }
      if (!server || !server.connected) {
        setError('GATT connect failed after 3 attempts. Move closer to sensor and retry.');
        setStatus('error'); return;
      }
      serverRef.current = server;

      // ── Enumerate services — retry once if server dropped mid-enum ────
      addLog('Enumerating services…');
      let services = [];
      for (let enumTry = 1; enumTry <= 2; enumTry++) {
        if (!server.connected) {
          addLog(`Server disconnected before enum (try ${enumTry}) — reconnecting…`);
          try {
            server = await Promise.race([
              device.gatt.connect(),
              new Promise((_, r) => setTimeout(() => r(new Error('timed out')), 8000)),
            ]);
            serverRef.current = server;
            await sleep(600);
          } catch (e) { setError(`Reconnect failed: ${e.message}`); setStatus('error'); return; }
        }
        try {
          services = await server.getPrimaryServices();
          addLog(`✓ ${services.length} service(s)`);
          break;
        } catch (e) {
          addLog(`Services failed (try ${enumTry}): ${e.message}`);
          if (enumTry === 1) {
            // Fallback: try direct FFF0 service lookup
            try { services = [await server.getPrimaryService(INKBIRD_SERVICE)]; addLog('✓ FFF0 direct'); break; }
            catch (_) {}
          }
          if (enumTry === 2) { setError('No services accessible'); setStatus('error'); return; }
          await sleep(800);
        }
      }

      // ── Enumerate characteristics ──────────────────────────────────────
      const chars = [];
      for (const svc of services) {
        let cs = [];
        try { cs = await svc.getCharacteristics(); } catch (_) {}
        for (const ch of cs) {
          const props = ch.properties ? Object.keys(ch.properties).filter(k => ch.properties[k]) : [];
          addLog(`  ${svc.uuid.slice(4,8).toUpperCase()} / ${ch.uuid.slice(4,8).toUpperCase()} [${props.join(', ')||'—'}]`);
          chars.push({ uuid: ch.uuid, svcUuid: svc.uuid, props, ch });
        }
      }
      setCharList(chars.map(({ uuid, svcUuid, props }) => ({ uuid, svcUuid, props })));

      // ── ONE-SHOT READ of all chars ─────────────────────────────────────
      addLog('Reading all characteristics…');
      for (const c of chars) {
        try {
          const dv    = await c.ch.readValue();
          const bytes = Array.from({length: dv.byteLength}, (_, i) => dv.getUint8(i));
          const hex   = bytesToHex(bytes);
          const short = c.uuid.slice(4,8).toUpperCase();
          const t     = short === 'FFF2' ? decodeFff2(bytes) : null;
          if (t !== null) {
            addLog(`🌡 FFF2 = ${t}°C  (${hex})`);
            pushTemp(t, 'read', c.uuid, hex, bytes);
          } else {
            addLog(`READ ${short}: ${hex}`);
          }
        } catch (_) {}
      }

      // ── Try FFF6 notifications ─────────────────────────────────────────
      const fff0Chars = chars.filter(c => c.svcUuid === INKBIRD_SERVICE);
      let notifyWorking = false;

      for (const c of fff0Chars) {
        try {
          await c.ch.startNotifications();
          subsRef.current.push(c.ch);
          const short = c.uuid.slice(4,8).toUpperCase();
          addLog(`✓ Notifications: ${short}`);
          c.ch.addEventListener('characteristicvaluechanged', evt => {
            if (stoppedRef.current) return;
            const dv    = evt.target.value;
            const bytes = Array.from({length: dv.byteLength}, (_, i) => dv.getUint8(i));
            const hex   = bytesToHex(bytes);
            const t     = short === 'FFF2' || short === 'FFF6' ? decodeFff2(bytes) : null;
            if (t !== null) {
              addLog(`🌡 NOTIFY ${short} = ${t}°C`);
              pushTemp(t, 'notify', c.uuid, hex, bytes);
            }
          });
          if (c.uuid.slice(4,8).toUpperCase() === 'FFF6') notifyWorking = true;
        } catch (e) {
          addLog(`  ✗ NOTIFY ${c.uuid.slice(4,8).toUpperCase()}: ${e.message}`);
        }
      }

      // ── FFF2 poll fallback if notifications unavailable/not firing ─────
      // Poll FFF2 every 2 s — always runs alongside notifications as a safety net.
      // If FFF6 notifications work, we'll see duplicate readings (harmless).
      const fff2Char = chars.find(c => c.uuid.slice(4,8).toUpperCase() === 'FFF2');
      if (fff2Char) {
        fff2Ref.current = fff2Char.ch;
        addLog(`Polling FFF2 every ${POLL_INTERVAL_MS/1000}s…`);
        setStatus('polling');

        const poll = async () => {
          if (stoppedRef.current || !fff2Ref.current) return;
          try {
            const dv    = await fff2Ref.current.readValue();
            const bytes = Array.from({length: dv.byteLength}, (_, i) => dv.getUint8(i));
            const hex   = bytesToHex(bytes);
            const t     = decodeFff2(bytes);
            if (t !== null) {
              addLog(`🌡 POLL FFF2 = ${t}°C`);
              pushTemp(t, 'poll', fff2Char.uuid, hex, bytes);
            }
          } catch (e) {
            if (!stoppedRef.current) addLog(`Poll error: ${e.message}`);
          }
        };

        poll(); // immediate first read
        pollRef.current = setInterval(poll, POLL_INTERVAL_MS);
      } else {
        setStatus('reading');
      }

      // Watch for unexpected GATT disconnect
      device.addEventListener('gattserverdisconnected', () => {
        if (stoppedRef.current) return;
        addLog('⚠️ GATT disconnected unexpectedly.');
        clearInterval(pollRef.current);
        setStatus('error');
        setError('Device disconnected. Click Reconnect to resume.');
      });

      addLog(`Live — ${notifyWorking ? 'notifications active' : 'polling FFF2 every 2s'}. Auto-stop in 60s.`);
      autoStopRef.current = setTimeout(() => { if (!stoppedRef.current) stop(); }, LISTEN_MS);

    } catch (err) {
      if (err?.name === 'NotFoundError' || err?.name === 'AbortError') {
        setStatus('idle'); addLog('Cancelled.');
      } else {
        setError(err.message); setStatus('error'); addLog(`✗ ${err.message}`);
      }
    }
  }, [addLog, ensureDevice, pushTemp, stop]);

  const forgetDevice = useCallback(() => {
    deviceRef.current = null; setPaired(null);
    addLog('Forgot device — next scan will show picker.');
  }, [addLog]);

  // ── Derived display ───────────────────────────────────────────────────────
  const isActive  = ['connecting','reading','polling'].includes(status);
  const latestTemp = temp;
  const tempColor = latestTemp == null ? 'text-slate-400' :
    latestTemp < 2 || latestTemp > 8 ? 'text-red-600' : 'text-emerald-600';

  return (
    <Card style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
      <CardHeader>
        <CardTitle className="flex items-center justify-between flex-wrap gap-2" style={{ color: 'var(--text-slate-900)' }}>
          <div className="flex items-center gap-2 flex-wrap">
            <Thermometer className="w-5 h-5 text-cyan-600" />
            <span>Inkbird BLE Diagnostic</span>
            {paired && (
              <span className="text-xs font-normal text-emerald-600 flex items-center gap-1.5">
                · <strong>{paired}</strong>
                <button onClick={forgetDevice}
                  className="text-slate-400 hover:text-red-500 underline text-xs" title="Forget device">
                  Forget
                </button>
              </span>
            )}
          </div>
          <div className="flex gap-2">
            {isActive ? (
              <Button variant="destructive" size="sm" onClick={stop}>
                <Unplug className="w-4 h-4 mr-1" /> Disconnect
              </Button>
            ) : (
              <Button size="sm" className="bg-cyan-600 hover:bg-cyan-700 text-white"
                onClick={start} disabled={!hasBluetooth}>
                <Bluetooth className="w-4 h-4 mr-1" />
                {paired ? 'Reconnect' : 'Connect Sensor'}
              </Button>
            )}
          </div>
        </CardTitle>
        <CardDescription style={{ color: 'var(--text-slate-500)' }}>
          Connects via GATT, reads FFF2 (confirmed temp source), subscribes FFF6 notifications,
          and polls FFF2 every 2s as a fallback. Reuses the paired device automatically — no picker after first use.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">

          {/* ── Left: live temp + chart + log ── */}
          <div className="space-y-4">

            {/* Live temp readout */}
            <div className={`rounded-2xl border p-5 text-center space-y-1 ${
              latestTemp == null ? 'border-slate-200 bg-slate-50' :
              latestTemp < 2 || latestTemp > 8 ? 'border-red-200 bg-red-50' :
              'border-emerald-200 bg-emerald-50'
            }`}>
              <p className="text-xs text-slate-500 uppercase tracking-wide">Live Temperature</p>
              <p className={`text-6xl font-bold tabular-nums ${tempColor}`}>
                {latestTemp !== null ? `${latestTemp}°C` : '—'}
              </p>
              {latestTemp !== null && (latestTemp < 2 || latestTemp > 8) && (
                <p className="text-xs text-red-600 font-medium">⚠️ Outside target range (2–8°C)</p>
              )}
              {isActive && (
                <p className="text-xs text-cyan-600 animate-pulse">
                  {status === 'polling' ? `Polling every ${POLL_INTERVAL_MS/1000}s…` : 'Listening for notifications…'}
                </p>
              )}
              {history.length > 0 && (
                <div className="flex justify-center pt-1">
                  <TempSparkline history={history} />
                </div>
              )}
              {history.length > 1 && (
                <p className="text-xs text-slate-400">
                  min {Math.min(...history.map(h=>h.temp))}°C · max {Math.max(...history.map(h=>h.temp))}°C
                  · {history.length} readings
                </p>
              )}
            </div>

            {/* Status / error */}
            {!hasBluetooth && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-800 text-sm">
                ⚠️ Web Bluetooth not available. Use Chrome or Edge on Android/desktop.
              </div>
            )}
            {error && (
              <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-red-700 text-sm flex items-start gap-2">
                <span>❌ {error}</span>
                {!isActive && (
                  <Button size="sm" variant="outline" className="ml-auto shrink-0 h-7 text-xs" onClick={start}>
                    <RefreshCw className="w-3 h-3 mr-1" /> Retry
                  </Button>
                )}
              </div>
            )}

            {/* Characteristics */}
            {charList.length > 0 && (
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <p className="text-xs font-semibold text-slate-500 mb-2">Characteristics</p>
                <div className="space-y-1">
                  {charList.map(cp => {
                    const short = cp.uuid.slice(4,8).toUpperCase();
                    const isTemp = short === 'FFF2' || short === 'FFF6';
                    return (
                      <div key={cp.uuid} className="flex items-center gap-2 text-xs">
                        <code className={`w-10 shrink-0 font-mono font-bold ${isTemp ? 'text-cyan-600' : 'text-slate-500'}`}>
                          {short}{isTemp ? ' 🌡' : ''}
                        </code>
                        <div className="flex gap-1 flex-wrap">
                          {cp.props.map(p => (
                            <Badge key={p} variant="outline" className={`text-xs px-1 py-0 ${
                              p === 'notify' || p === 'indicate'
                                ? 'border-cyan-400 text-cyan-700 bg-cyan-50'
                                : 'border-slate-300 text-slate-500'
                            }`}>{p}</Badge>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Log */}
            {log.length > 0 && (
              <div className="rounded-lg border border-slate-200 bg-slate-900 p-3 font-mono text-xs max-h-52 overflow-y-auto space-y-0.5">
                {log.map((l, i) => (
                  <div key={i} className={`leading-5 ${
                    l.includes('✗') || l.includes('⚠️') ? 'text-red-400' :
                    l.includes('🌡') ? 'text-yellow-300 font-bold' :
                    l.includes('✓') ? 'text-emerald-400' :
                    l.includes('NOTIFY') ? 'text-cyan-300' :
                    l.includes('POLL')   ? 'text-violet-300' :
                    l.includes('READ')   ? 'text-yellow-200' :
                    'text-green-400'
                  }`}>{l}</div>
                ))}
              </div>
            )}
          </div>

          {/* ── Right: raw packets ── */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold text-slate-500">
                Raw Packets {packets.length > 0 ? `(${packets.length})` : ''}
              </p>
              {packets.length > 0 && (
                <button onClick={() => { setPackets([]); packetsRef.current = []; }}
                  className="text-xs text-slate-400 hover:text-slate-600 flex items-center gap-1">
                  <Trash2 className="w-3 h-3" /> Clear
                </button>
              )}
            </div>

            {packets.length === 0 && !isActive && (
              <div className="text-slate-400 text-sm text-center py-8">
                No data yet — connect the sensor above.
              </div>
            )}
            {packets.length === 0 && isActive && (
              <div className="text-slate-400 text-sm text-center py-8 animate-pulse">
                Waiting for first reading…
              </div>
            )}

            <div className="max-h-[520px] overflow-y-auto space-y-1.5">
              {packets.map(pkt => (
                <div key={pkt.id} className={`rounded-lg border p-2.5 text-xs space-y-1 ${
                  pkt.temp != null ? 'border-cyan-200 bg-cyan-50/50' : 'border-slate-200 bg-slate-50'
                }`}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-slate-500">{pkt.ts}</span>
                      {pkt.temp != null && (
                        <span className={`text-base font-bold ${
                          pkt.temp < 2 || pkt.temp > 8 ? 'text-red-600' : 'text-cyan-700'
                        }`}>{pkt.temp}°C</span>
                      )}
                    </div>
                    <div className="flex gap-1">
                      <Badge variant="outline" className={`text-xs px-1 py-0 ${
                        pkt.type === 'notify' ? 'border-cyan-400 text-cyan-700 bg-cyan-50' :
                        pkt.type === 'poll'   ? 'border-violet-400 text-violet-700 bg-violet-50' :
                        'border-slate-300 text-slate-500 bg-slate-50'
                      }`}>{pkt.type?.toUpperCase()}</Badge>
                      <Badge variant="outline" className={`text-xs px-1 py-0 ${
                        pkt.uuid?.slice(4,8).toUpperCase() === 'FFF2'
                          ? 'border-cyan-400 text-cyan-700'
                          : 'border-slate-300 text-slate-500'
                      }`}>{pkt.uuid?.slice(4,8).toUpperCase()}</Badge>
                    </div>
                  </div>
                  <code className="text-slate-600 break-all block text-[11px]">{pkt.hex}</code>
                  {pkt.temp == null && pkt.allTemps?.slice(0, 4).map((t, i) => (
                    <Badge key={i} variant="outline" className={`text-xs px-1 py-0 mr-1 ${
                      t.val > 0 && t.val < 40
                        ? 'border-emerald-300 text-emerald-700 bg-emerald-50'
                        : 'border-slate-200 text-slate-500'
                    }`}>{t.val}°C [{t.label}@{t.offset}]</Badge>
                  ))}
                </div>
              ))}
            </div>
          </div>

        </div>
      </CardContent>
    </Card>
  );
}
