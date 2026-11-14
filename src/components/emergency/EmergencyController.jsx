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
// Crash sensing thresholds. accelerationIncludingGravity is m/s²; resting is
// ~9.81. A real impact spikes well past 25, and the "no movement afterwards"
// window filters out a phone dropped on a seat or a hard pothole.
const CRASH_SPIKE = 28;
const CRASH_QUIET_MS = 20000;
const CRASH_QUIET_MAX_DELTA = 3.5;

const ALERT_LABELS = {
  accident: 'Accident',
  medical: 'Medical emergency',
  other: 'Emergency'
};

const EmergencyController = ({ currentUser }) => {
  const enabled = useMemo(() => isAppOwner(currentUser), [currentUser]);

  const [pending, setPending] = useState(null); // { source, alertType }
  const [countdown, setCountdown] = useState(COUNTDOWN_SECONDS);
  const [notes, setNotes] = useState('');
  const [activeAlert, setActiveAlert] = useState(null);
  const [sending, setSending] = useState(false);
  const [crashArmed, setCrashArmed] = useState(false);
  const [error, setError] = useState('');

  const countdownRef = useRef(null);
  const crashStateRef = useRef({ lastMagnitude: null, spikeAt: null, quietSince: null, firedAt: 0 });
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
  useEffect(() => {
    if (!enabled) return;
    let permissionAsked = false;

    const attach = () => {
      window.addEventListener('devicemotion', handleMotion, { passive: true });
      setCrashArmed(true);
    };

    const handleMotion = (event) => {
      const acc = event?.accelerationIncludingGravity;
      if (!acc) return;
      const { x, y, z } = acc;
      if (x == null || y == null || z == null) return;
      const magnitude = Math.sqrt(x * x + y * y + z * z);
      const state = crashStateRef.current;
      const now = Date.now();
      const previous = state.lastMagnitude;
      state.lastMagnitude = magnitude;

      // A spike counts only when it is BOTH large and sudden.
      if (previous != null && magnitude > CRASH_SPIKE && magnitude - previous > 12) {
        state.spikeAt = now;
        state.quietSince = now;
        return;
      }
      if (state.spikeAt && now - state.spikeAt < CRASH_QUIET_MS) {
        // After the spike the phone must stay nearly still for 20 seconds.
        if (previous != null && Math.abs(magnitude - previous) > CRASH_QUIET_MAX_DELTA) {
          state.quietSince = now; // movement resumed → keep waiting
        }
        const quietFor = now - (state.quietSince || now);
        if (quietFor >= CRASH_QUIET_MS && now - state.firedAt > 120000) {
          state.firedAt = now;
          state.spikeAt = null;
          openConfirm('crash', 'accident');
        }
      } else if (state.spikeAt && now - state.spikeAt >= CRASH_QUIET_MS) {
        state.spikeAt = null;
      }
    };

    // iOS 13+ needs an explicit permission grant, which must come from a user
    // gesture. We ask once, quietly, on the first tap of the session; if the
    // driver declines, crash sensing simply stays off and the manual hold works.
    const askPermission = async () => {
      if (permissionAsked) return;
      permissionAsked = true;
      try {
        const Ctor = window.DeviceMotionEvent;
        if (Ctor && typeof Ctor.requestPermission === 'function') {
          const result = await Ctor.requestPermission();
          if (result === 'granted') attach();
          return;
        }
        attach();
      } catch { /* leave crash sensing off */ }
    };

    window.addEventListener('pointerdown', askPermission, { once: true });
    if (typeof window.DeviceMotionEvent !== 'undefined' &&
        typeof window.DeviceMotionEvent.requestPermission !== 'function') {
      attach();
    }

    return () => {
      window.removeEventListener('pointerdown', askPermission);
      window.removeEventListener('devicemotion', handleMotion);
      setCrashArmed(false);
    };
  }, [enabled, openConfirm]);

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
    if (!pending) {
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
              {' '}Sending automatically in {countdown}s.
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
