import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { isAppOwner } from '@/components/utils/userRoles';
import {
  startEmergencyAlarm,
  stopEmergencyAlarm,
  playArmTick,
  isEmergencyAlarmRunning
} from './emergencyAlarm';

// ─────────────────────────────────────────────────────────────────────────────
// EMERGENCY SYSTEM — OWNER-DEVICE PILOT (Nov 14 2026)
//
// Owner direction: build crash detection + a manual SOS, but expose the WHOLE
// system to App Owner devices only for now, so the only people who can receive
// a false activation are the owner's own devices.
//
// Two ways in:
//   1. MANUAL — press and hold the Dashboard map for 5 seconds (the map has no
//      other long-press gesture, and tap/pinch/swipe are unaffected).
//   2. CRASH  — devicemotion spike prompts the SAME screen; it NEVER
//      auto-sends on its own.
//
// Both land on one full-screen blocker: countdown, notes box, 911 button,
// Cancel. After 10 seconds with no cancel the alert is sent. Sending writes an
// EmergencyAlert record, starts the siren + haptics, and shows a pulsing banner
// on every owner device. Tapping the banner silences it everywhere.
// ─────────────────────────────────────────────────────────────────────────────

const COUNTDOWN_SECONDS = 10;
const HOLD_MS = 5000;
const HOLD_MOVE_TOLERANCE_PX = 12;
// Crash sensing thresholds. accelerationIncludingGravity rests at ~9.81 m/s²,
// so "hit by hand / dropped on a table" samples land in the 25-45 range and a
// sudden change of 12+ in one sample is already a sharp jolt.
const GRAVITY = 9.81;
const CRASH_SPIKE = 24;        // total magnitude that counts as an impact
const CRASH_JERK = 12;         // sudden sample-to-sample change (any single hit)
const STILL_BAND = 5;          // |magnitude - 9.81| below this = phone at rest
const STILL_BAND_RAW = 2.5;    // same idea when the browser omits gravity
const CRASH_QUIET_MS = 15000;  // stillness required after the impact
const CRASH_GIVEUP_MS = 60000; // a stale spike with no stillness is a bumpy ride
const CRASH_COOLDOWN_MS = 120000;

const ALERT_LABELS = {
  accident: 'Accident',
  medical: 'Medical emergency',
  other: 'Emergency'
};

const EmergencyController = ({ currentUser }) => {
  const enabled = useMemo(() => isAppOwner(currentUser), [currentUser]);

  const [pending, setPending] = useState(null); // { source, alertType }
  const [countdown, setCountdown] = useState(COUNTDOWN_SECONDS);
  // Owner spec Nov 14 2026: any deliberate interaction with the app while the
  // detection screen is up HALTS the auto-send countdown. The screen then waits
  // for an explicit Activate or Cancel instead of firing on a timer.
  const [autoSendPaused, setAutoSendPaused] = useState(false);
  // Live progress of the impact-detection window. Drives the red bar that shows
  // BEFORE the confirm screen, so the driver can see a hard hit registered.
  const [impactProgress, setImpactProgress] = useState(0);
  const [impactPeak, setImpactPeak] = useState(0);
  const [notes, setNotes] = useState('');
  const [activeAlert, setActiveAlert] = useState(null);
  const [sending, setSending] = useState(false);
  const [crashArmed, setCrashArmed] = useState(false);
  const [error, setError] = useState('');

  const countdownRef = useRef(null);
  const crashStateRef = useRef({
    lastMagnitude: null,
    lastJerk: 0,
    peak: 0,
    spikeAt: null,
    quietSince: null,
    firedAt: 0,
    lastEventAt: 0,
    eventCount: 0
  });
  const [crashStatus, setCrashStatus] = useState('idle');
  const [showSensorChip, setShowSensorChip] = useState(true);
  const [sensorReadout, setSensorReadout] = useState({ magnitude: null, jerk: 0, peak: 0, events: 0, lastEventAt: 0 });
  const pendingRef = useRef(null);
  const activeRef = useRef(null);

  useEffect(() => { pendingRef.current = pending; }, [pending]);
  useEffect(() => { activeRef.current = activeAlert; }, [activeAlert]);

  // Expose the gate so the map's long-press only draws its ring for an owner.
  useEffect(() => {
    try { window.__rxEmergencyArmed = !!enabled; } catch { /* ignore */ }
    return () => { try { window.__rxEmergencyArmed = false; } catch { /* ignore */ } };
  }, [enabled]);

  // ── Load any live alert (and follow it across the owner's devices) ────────
  const loadActiveAlert = useCallback(async () => {
    if (!enabled) return;
    try {
      const rows = await base44.entities.EmergencyAlert.filter({ status: 'active' }, '-activated_at', 5, 0);
      const list = Array.isArray(rows) ? rows : (rows?.items || []);
      const live = (list || [])[0] || null;
      setActiveAlert(live);
      if (live) {
        startEmergencyAlarm();
      } else if (isEmergencyAlarmRunning()) {
        stopEmergencyAlarm();
      }
    } catch (err) {
      console.warn('[Emergency] Could not read active alerts:', err?.message || err);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    loadActiveAlert();
    let unsub = null;
    try {
      unsub = base44.entities.EmergencyAlert.subscribe((event) => {
        const record = event?.data;
        if (!record) return;
        if (record.status === 'active') {
          setActiveAlert((prev) => (prev?.id === record.id ? { ...prev, ...record } : record));
          startEmergencyAlarm();
        } else {
          setActiveAlert((prev) => (prev && prev.id === record.id ? null : prev));
          if (!activeRef.current || activeRef.current.id === record.id) stopEmergencyAlarm();
        }
      });
    } catch { /* realtime unavailable — the poll below still covers us */ }
    const poll = setInterval(loadActiveAlert, 60000);
    return () => {
      if (typeof unsub === 'function') unsub();
      clearInterval(poll);
    };
  }, [enabled, loadActiveAlert]);

  // ── Open the confirm screen ───────────────────────────────────────────────
  const openConfirm = useCallback((source, alertType = 'accident') => {
    if (!enabled) return;
    if (activeRef.current) return;      // already live — nothing to confirm
    if (pendingRef.current) return;     // confirm screen already up
    setNotes('');
    setError('');
    setCountdown(COUNTDOWN_SECONDS);
    setAutoSendPaused(false);
    setPending({ source, alertType });
    playArmTick();
  }, [enabled]);

  // Map long-press (5s) → same confirm screen.
  useEffect(() => {
    const onHold = (event) => {
      const source = event?.detail?.source || 'manual';
      openConfirm(source, event?.detail?.alertType || 'accident');
    };
    window.addEventListener('rx-emergency-trigger', onHold);
    return () => window.removeEventListener('rx-emergency-trigger', onHold);
  }, [openConfirm]);

  // ── Crash detection (prompt only) ─────────────────────────────────────────
  // REWRITTEN Nov 14 2026. The first version could NEVER fire: firing required
  // a 20 s stillness inside a branch that only ran while the spike was younger
  // than 20 s. The state machine is now a simple spike → stillness window with
  // no nested time paradox, and the thresholds are tuned for a phone hit by
  // hand or dropped onto a table (gravity-inclusive magnitude, resting ~9.81).
  useEffect(() => {
    if (!enabled) return;
    let permissionAsked = false;

    const attach = () => {
      try {
        window.addEventListener('devicemotion', handleMotion, { passive: true });
        setCrashArmed(true);
      } catch { /* non-fatal */ }
    };

    const handleMotion = (event) => {
      const state = crashStateRef.current;
      const now = Date.now();
      state.lastEventAt = now;
      state.eventCount = (state.eventCount || 0) + 1;

      // Some browsers ship only the gravity-free `acceleration`; treat it as a
      // different scale (resting ~0) instead of pretending it is ~9.81.
      const withGravity = event?.accelerationIncludingGravity;
      const raw = withGravity || event?.acceleration;
      if (!raw) return;
      const { x, y, z } = raw;
      if (x == null || y == null || z == null) return;

      const magnitude = Math.sqrt(x * x + y * y + z * z);
      const usesGravity = !!withGravity;
      const baseline = usesGravity ? GRAVITY : 0;
      const spikeThreshold = usesGravity ? CRASH_SPIKE : CRASH_SPIKE - GRAVITY;
      const stillBand = usesGravity ? STILL_BAND : STILL_BAND_RAW;

      const previous = state.lastMagnitude;
      state.lastMagnitude = magnitude;
      if (magnitude > (state.peak || 0)) state.peak = magnitude;
      state.lastJerk = previous == null ? 0 : Math.abs(magnitude - previous);

      // ── Spike detection: one big sample, or one very sudden change ────────
      const bigSample = magnitude >= spikeThreshold;
      const bigJerk = previous != null && Math.abs(magnitude - previous) >= CRASH_JERK;
      if ((bigSample || bigJerk) && now - (state.firedAt || 0) > CRASH_COOLDOWN_MS) {
        // (Re)start the stillness window on every fresh impact.
        state.spikeAt = now;
        state.quietSince = now;
        return;
      }

      if (!state.spikeAt) return;

      // ── Stillness confirmation ────────────────────────────────────────────
      if (Math.abs(magnitude - baseline) > stillBand) {
        state.quietSince = now;              // the phone is still moving
      } else if (now - state.quietSince >= CRASH_QUIET_MS) {
        state.firedAt = now;
        state.spikeAt = null;
        state.peak = 0;
        openConfirm('crash', 'accident');
        return;
      }

      // A spike older than a minute with no stillness is just a bumpy ride.
      if (now - state.spikeAt > CRASH_GIVEUP_MS) {
        state.spikeAt = null;
        state.peak = 0;
      }
    };

    // iOS 13+ needs an explicit permission grant, which must come from a user
    // gesture. We ask on the first tap of the session; if the driver declines,
    // crash sensing stays off and the manual map hold still works.
    const askPermission = async () => {
      if (permissionAsked) return;
      permissionAsked = true;
      try {
        const Ctor = window.DeviceMotionEvent;
        if (Ctor && typeof Ctor.requestPermission === 'function') {
          const result = await Ctor.requestPermission();
          if (result === 'granted') attach();
          else setCrashStatus('blocked');
          return;
        }
        attach();
      } catch { /* leave crash sensing off */ }
    };

    window.addEventListener('pointerdown', askPermission, { once: true });
    if (typeof window.DeviceMotionEvent === 'undefined') {
      setCrashStatus('unsupported');
    } else if (typeof window.DeviceMotionEvent.requestPermission !== 'function') {
      attach();
    } else {
      setCrashStatus('needs-gesture');
    }

    return () => {
      window.removeEventListener('pointerdown', askPermission);
      window.removeEventListener('devicemotion', handleMotion);
      setCrashArmed(false);
    };
  }, [enabled, openConfirm]);

  // ── Impact bar feed ──────────────────────────────────────────────────────
  // While a spike is live, publish how far through the stillness window we are
  // so the top bar can fill. Resets to 0 whenever the phone moves again, and the
  // bar disappears the instant the window completes (confirm screen takes over)
  // or the driver taps to cancel.
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => {
      const state = crashStateRef.current;
      if (!state.spikeAt || !state.quietSince) {
        setImpactProgress((prev) => (prev === 0 ? prev : 0));
        return;
      }
      const progress = Math.max(0, Math.min(1, (Date.now() - state.quietSince) / CRASH_QUIET_MS));
      setImpactProgress(progress);
      setImpactPeak(state.peak || 0);
    }, 120);
    return () => clearInterval(id);
  }, [enabled]);

  // A deliberate tap during the impact window cancels the detection (owner
  // spec: "an interaction in the app will stop it"). No prompt is shown.
  useEffect(() => {
    if (!enabled || impactProgress <= 0) return;
    const cancel = () => {
      const state = crashStateRef.current;
      state.spikeAt = null;
      state.quietSince = null;
      state.peak = 0;
      setImpactProgress(0);
    };
    window.addEventListener('click', cancel, true);
    window.addEventListener('keydown', cancel, true);
    return () => {
      window.removeEventListener('click', cancel, true);
      window.removeEventListener('keydown', cancel, true);
    };
  }, [enabled, impactProgress > 0]);

  // Live sensor readout for the pilot (owner needs to SEE that a hit registers).
  // Sampled twice a second so a 60 Hz sensor never causes a render storm.
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => {
      const state = crashStateRef.current;
      setSensorReadout({
        magnitude: state.lastMagnitude,
        jerk: state.lastJerk,
        peak: state.peak || 0,
        events: state.eventCount || 0,
        lastEventAt: state.lastEventAt || 0
      });
    }, 500);
    return () => clearInterval(id);
  }, [enabled]);

  // ── Send the alert ────────────────────────────────────────────────────────
  const sendAlert = useCallback(async (currentNotes = notes) => {
    if (!pendingRef.current || sending) return;
    setSending(true);
    setError('');
    const payloadNotes = String(currentNotes || '').trim() ||
      `${ALERT_LABELS[pendingRef.current.alertType] || 'Emergency'} declared from the RxDeliver dashboard${pendingRef.current.source === 'crash' ? ' after impact detection' : ''}.`;

    const position = await new Promise((resolve) => {
      if (typeof navigator === 'undefined' || !navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
        () => resolve(null),
        { enableHighAccuracy: true, timeout: 4000, maximumAge: 30000 }
      );
    });

    try {
      const record = await base44.entities.EmergencyAlert.create({
        driver_id: currentUser?.user_id || currentUser?.id || null,
        driver_name: currentUser?.full_name || currentUser?.user_name || 'App Owner',
        alert_type: pendingRef.current.alertType || 'other',
        source: pendingRef.current.source || 'manual',
        notes: payloadNotes,
        status: 'active',
        activated_at: new Date().toISOString(),
        latitude: position?.latitude ?? null,
        longitude: position?.longitude ?? null,
        store_ids: Array.isArray(currentUser?.store_ids) ? currentUser.store_ids : [],
        city_id: currentUser?.city_id || null,
        device_identifier: (() => { try { return localStorage.getItem('rxdeliver_device_identifier') || null; } catch { return null; } })()
      });
      setActiveAlert(record);
      startEmergencyAlarm();
      setPending(null);
    } catch (err) {
      setError(err?.message || 'Could not send the emergency alert.');
    } finally {
      setSending(false);
    }
  }, [currentUser, notes, sending]);

  const cancelPending = useCallback(() => {
    setPending(null);
    setError('');
  }, []);

  // Auto-send after the countdown (owner spec: 10 seconds, cancel stays live).
  useEffect(() => {
    if (!pending || autoSendPaused) {
      if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null; }
      return;
    }
    if (countdownRef.current) clearInterval(countdownRef.current);
    countdownRef.current = setInterval(() => {
      setCountdown((prev) => {
        const next = prev - 1;
        if (next <= 0) {
          if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null; }
          sendAlert();
          return 0;
        }
        return next;
      });
    }, 1000);
    return () => {
      if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, autoSendPaused]);

  // A CLICK (a real tap, not a stray drag) while the screen is up pauses the
  // automatic send. Stray touches from a phone sliding around do NOT count.
  useEffect(() => {
    if (!pending) return;
    const onInteract = () => setAutoSendPaused(true);
    const onKey = () => setAutoSendPaused(true);
    window.addEventListener('click', onInteract, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('click', onInteract, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [pending]);

  // ── Silence / resolve globally ────────────────────────────────────────────
  const silenceEverywhere = useCallback(async () => {
    const alert = activeRef.current;
    if (!alert?.id) return;
    stopEmergencyAlarm();
    setActiveAlert(null);
    try {
      await base44.entities.EmergencyAlert.update(alert.id, {
        status: 'resolved',
        resolved_at: new Date().toISOString(),
        resolved_by: currentUser?.user_id || currentUser?.id || null,
        resolved_by_name: currentUser?.full_name || currentUser?.user_name || 'App Owner',
        muted_by: currentUser?.full_name || currentUser?.user_name || 'App Owner'
      });
    } catch (err) {
      console.warn('[Emergency] Could not resolve alert:', err?.message || err);
    }
  }, [currentUser]);

  if (!enabled) return null;

  return (
    <>
      {/* ── IMPACT BAR: shows the instant a hard hit registers, BEFORE the
             confirm screen. Fills over the stillness window; tapping cancels. */}
      {!pending && impactProgress > 0 && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, height: 8, zIndex: 10090, pointerEvents: 'none' }}>
          <div
            style={{
              height: '100%',
              width: `${impactProgress * 100}%`,
              background: 'linear-gradient(90deg, #dc2626, #f97316)',
              boxShadow: '0 0 14px rgba(220,38,38,0.9)',
              transition: 'width 110ms linear'
            }}
          />
          <div
            style={{
              position: 'absolute',
              top: 10,
              right: 10,
              fontSize: 10.5,
              fontWeight: 800,
              letterSpacing: 0.6,
              color: '#fecaca',
              textShadow: '0 1px 4px rgba(0,0,0,0.85)'
            }}>
            IMPACT DETECTED · {Math.max(0, Math.ceil((1 - impactProgress) * (CRASH_QUIET_MS / 1000)))}s · TAP TO CANCEL
          </div>
        </div>
      )}

      {/* ── Red countdown bar: the system detected a hit and is counting down
             to sending. It runs the moment the screen appears, then freezes
             (amber) the instant the driver interacts with the app. ───────── */}
      {pending && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, height: 8, zIndex: 10090, pointerEvents: 'none' }}>
          <div
            style={{
              height: '100%',
              width: `${Math.max(0, Math.min(1, countdown / COUNTDOWN_SECONDS)) * 100}%`,
              background: autoSendPaused
                ? 'linear-gradient(90deg, #f59e0b, #fbbf24)'
                : 'linear-gradient(90deg, #dc2626, #f97316)',
              boxShadow: autoSendPaused
                ? '0 0 10px rgba(245,158,11,0.7)'
                : '0 0 14px rgba(220,38,38,0.9)',
              transition: autoSendPaused ? 'background 180ms linear' : 'width 950ms linear'
            }}
          />
          <div
            style={{
              position: 'absolute',
              top: 10,
              right: 10,
              fontSize: 10.5,
              fontWeight: 800,
              letterSpacing: 0.6,
              color: autoSendPaused ? '#fbbf24' : '#fecaca',
              textShadow: '0 1px 4px rgba(0,0,0,0.8)'
            }}>
            {autoSendPaused ? 'AUTO-SEND PAUSED' : `SENDING IN ${Math.max(0, countdown)}s`}
          </div>
        </div>
      )}

      {/* ── Pulsing banner while an emergency is live ─────────────────────── */}
      {activeAlert && (
        <button
          type="button"
          onClick={silenceEverywhere}
          title="Tap to silence this emergency on every device"
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            zIndex: 10070,
            border: 'none',
            cursor: 'pointer',
            padding: '10px 14px 12px',
            background: 'linear-gradient(180deg, #dc2626 0%, #b91c1c 100%)',
            color: '#fff',
            boxShadow: '0 6px 24px rgba(220, 38, 38, 0.55)',
            animation: 'rxEmergencyPulse 1.1s ease-in-out infinite'
          }}>
          <style>{`
            @keyframes rxEmergencyPulse {
              0%   { box-shadow: 0 6px 24px rgba(220,38,38,0.35); filter: brightness(1); }
              50%  { box-shadow: 0 10px 34px rgba(220,38,38,0.95); filter: brightness(1.28); }
              100% { box-shadow: 0 6px 24px rgba(220,38,38,0.35); filter: brightness(1); }
            }
            @keyframes rxEmergencyBlink { 50% { opacity: 0.35; } }
            @keyframes rxEmergencyRing  { 0% { transform: scale(0.85); opacity: 0.9; } 100% { transform: scale(1.6); opacity: 0; } }
          `}</style>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, maxWidth: 720, margin: '0 auto' }}>
            <div style={{ textAlign: 'left' }}>
              <div style={{ fontSize: 11, letterSpacing: 1.2, fontWeight: 700, opacity: 0.9 }}>
                <span style={{ animation: 'rxEmergencyBlink 0.9s steps(2, start) infinite' }}>●</span> EMERGENCY ACTIVE
              </div>
              <div style={{ fontSize: 15, fontWeight: 800, marginTop: 2 }}>
                {activeAlert.driver_name || 'Driver'} — {ALERT_LABELS[activeAlert.alert_type] || 'Emergency'}
              </div>
              {activeAlert.notes ? (
                <div style={{ fontSize: 12, opacity: 0.95, marginTop: 2, maxWidth: 460, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {activeAlert.notes}
                </div>
              ) : null}
            </div>
            <div style={{ fontSize: 11, fontWeight: 800, textAlign: 'right', lineHeight: 1.25 }}>
              TAP TO SILENCE
              <br />
              ALL DEVICES
            </div>
          </div>
        </button>
      )}

      {/* ── Pilot sensor chip (owner only) ─────────────────────────────────
          Proves a hit is being registered before we trust the thresholds.
          Shows live magnitude so a real smash visibly jumps the number. */}
      {showSensorChip && (
        <div
          style={{
            position: 'fixed',
            left: 8,
            bottom: 84,
            zIndex: 10060,
            padding: '7px 9px',
            borderRadius: 10,
            background: 'rgba(15, 23, 42, 0.88)',
            color: '#e2e8f0',
            fontSize: 10.5,
            lineHeight: 1.35,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            boxShadow: '0 4px 16px rgba(0,0,0,0.35)',
            maxWidth: 190
          }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
            <span style={{ fontWeight: 800, color: sensorReadout.events > 0 ? '#4ade80' : '#f87171' }}>
              {sensorReadout.events > 0 ? 'SENSOR OK' : 'NO MOTION DATA'}
            </span>
            <button
              type="button"
              onClick={() => setShowSensorChip(false)}
              style={{ background: 'transparent', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: 12, lineHeight: 1 }}
              title="Hide">
              ✕
            </button>
          </div>
          <div>now {sensorReadout.magnitude != null ? sensorReadout.magnitude.toFixed(1) : '—'} · jump {Number(sensorReadout.jerk || 0).toFixed(1)}</div>
          <div>peak {Number(sensorReadout.peak || 0).toFixed(1)} → hit at {CRASH_SPIKE} / {CRASH_JERK}</div>
          <div>events {sensorReadout.events} · {crashArmed ? 'armed' : crashStatus}</div>
        </div>
      )}

      {/* ── Full-screen confirm blocker ───────────────────────────────────── */}
      {pending && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 10080,
            background: 'rgba(12, 10, 10, 0.92)',
            backdropFilter: 'blur(4px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16
          }}>
          <div
            style={{
              width: '100%',
              maxWidth: 460,
              background: '#1b1111',
              border: '2px solid #dc2626',
              borderRadius: 20,
              padding: 20,
              color: '#fff',
              boxShadow: '0 20px 60px rgba(220,38,38,0.5)'
            }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span
                style={{
                  width: 16,
                  height: 16,
                  borderRadius: 999,
                  background: '#ef4444',
                  boxShadow: '0 0 0 6px rgba(239,68,68,0.25)',
                  animation: 'rxEmergencyBlink 0.9s steps(2, start) infinite'
                }}
              />
              <div style={{ fontSize: 20, fontWeight: 800 }}>
                {pending.source === 'crash' ? 'Possible accident detected' : 'Activate emergency?'}
              </div>
            </div>
            <p style={{ fontSize: 13, color: '#fca5a5', marginTop: 8, marginBottom: 14 }}>
              {pending.source === 'crash'
                ? 'Your phone stopped moving after a hard impact. If you are okay, cancel.'
                : 'This alerts your dispatchers and other drivers.'}
              {autoSendPaused
                ? ' Auto-send paused because you touched the app. Choose Activate or Cancel.'
                : ` Sending automatically in ${countdown}s — touching the app stops it.`}
            </p>

            <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#fecaca', marginBottom: 6 }}>
              Notes (optional)
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="What happened? Anything responders or the store need to know."
              rows={3}
              style={{
                width: '100%',
                borderRadius: 12,
                border: '1px solid #7f1d1d',
                background: '#241616',
                color: '#fff',
                padding: 10,
                fontSize: 14,
                resize: 'vertical',
                outline: 'none'
              }}
            />

            <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
              <button
                type="button"
                onClick={cancelPending}
                style={{
                  flex: 1,
                  padding: '14px 12px',
                  borderRadius: 14,
                  border: '1px solid #4b5563',
                  background: '#111827',
                  color: '#e5e7eb',
                  fontSize: 15,
                  fontWeight: 700,
                  cursor: 'pointer'
                }}>
                Cancel
              </button>
              <button
                type="button"
                onClick={() => sendAlert()}
                disabled={sending}
                style={{
                  flex: 1.4,
                  padding: '14px 12px',
                  borderRadius: 14,
                  border: 'none',
                  background: sending ? '#7f1d1d' : '#dc2626',
                  color: '#fff',
                  fontSize: 15,
                  fontWeight: 800,
                  cursor: sending ? 'default' : 'pointer',
                  animation: 'rxEmergencyBlink 1s steps(2, start) infinite'
                }}>
                {sending ? 'Sending…' : 'Activate now'}
              </button>
            </div>

            <a
              href="tel:911"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                marginTop: 12,
                padding: '16px 12px',
                borderRadius: 16,
                background: '#f59e0b',
                color: '#1f2937',
                fontSize: 20,
                fontWeight: 900,
                textDecoration: 'none',
                letterSpacing: 0.5
              }}>
              911 — CALL NOW
            </a>

            {error && (
              <p style={{ marginTop: 10, fontSize: 12, color: '#fca5a5' }}>{error}</p>
            )}
          </div>
        </div>
      )}

      {/* ── Hold-to-arm progress (map long-press) ─────────────────────────── */}
      <EmergencyHoldIndicator />
    </>
  );
};

// A thin bar at the top of the screen while the 5-second map hold is running,
// so the driver can see the arm building and let go to abort.
const EmergencyHoldIndicator = () => {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const onStart = () => setProgress(0.001);
    const onProgress = (event) => setProgress(Math.max(0, Math.min(1, event?.detail?.progress || 0)));
    const onEnd = () => setProgress(0);
    window.addEventListener('rx-emergency-hold-start', onStart);
    window.addEventListener('rx-emergency-hold-progress', onProgress);
    window.addEventListener('rx-emergency-hold-end', onEnd);
    return () => {
      window.removeEventListener('rx-emergency-hold-start', onStart);
      window.removeEventListener('rx-emergency-hold-progress', onProgress);
      window.removeEventListener('rx-emergency-hold-end', onEnd);
    };
  }, []);

  if (progress <= 0) return null;

  return (
    <div style={{ position: 'fixed', top: 0, left: 0, right: 0, height: 6, zIndex: 10075, pointerEvents: 'none' }}>
      <div
        style={{
          height: '100%',
          width: `${progress * 100}%`,
          background: 'linear-gradient(90deg, #f97316, #dc2626)',
          boxShadow: '0 0 12px rgba(220,38,38,0.8)',
          transition: 'width 80ms linear'
        }}
      />
    </div>
  );
};

export default EmergencyController;
export { HOLD_MS, HOLD_MOVE_TOLERANCE_PX };
