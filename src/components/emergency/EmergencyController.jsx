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
const MIN_THRESHOLD = 25;      // most sensitive the slider can go (m/s²)
const MAX_THRESHOLD = 80;      // most forgiving
const CRASH_SPIKE = 42;        // fallback magnitude if the admin setting is missing
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

const IMPACT_NOTIFICATION_ID = 9911;
// A hidden impact has to survive a full activity relaunch: the native
// bringToFront bridge (or the full-screen-intent notification) can recreate
// MainActivity, which throws away all in-memory state. The queue is therefore
// mirrored into localStorage and consumed on the next boot.
const QUEUED_IMPACT_KEY = 'rx_emergency_queued_impact';
const QUEUED_IMPACT_MAX_AGE_MS = 5 * 60 * 1000;

const persistQueuedImpact = () => {
  try { localStorage.setItem(QUEUED_IMPACT_KEY, String(Date.now())); } catch { /* ignore */ }
};

const consumeQueuedImpact = () => {
  try {
    const raw = localStorage.getItem(QUEUED_IMPACT_KEY);
    if (!raw) return false;
    localStorage.removeItem(QUEUED_IMPACT_KEY);
    const at = Number(raw);
    return Number.isFinite(at) && Date.now() - at <= QUEUED_IMPACT_MAX_AGE_MS;
  } catch { return false; }
};

const isHiddenNow = () => {
  try {
    return typeof document !== 'undefined' && document.visibilityState === 'hidden';
  } catch {
    return false;
  }
};

// Bring RxDeliver forward on an impact using THE SAME NATIVE PATH the GPS
// arrival trigger uses (proximityForegroundTrigger → window.AndroidNative
// .bringToFront, implemented in MainActivity.java). Owner spec Nov 14 2026:
// "do it like the GPS does when we arrive at a delivery". That bridge:
//   1. no-ops if we are already in front,
//   2. relaunches MainActivity directly when "Display over other apps" is
//      granted (true auto-foreground),
//   3. otherwise posts a full-screen-intent notification that opens the app
//      over the lock screen.
// Because the CapGo GPS foreground service keeps the app process alive on duty
// or on break, this works while minimised — the same reason arrival detection
// works there.
const bringAppForward = (title, message) => {
  try {
    if (typeof window !== 'undefined' && typeof window.AndroidNative?.bringToFront === 'function') {
      const status = window.AndroidNative.bringToFront(title, message);
      console.log('[Emergency] bringToFront:', status);
      return String(status || '');
    }
  } catch (e) {
    console.warn('[Emergency] bringToFront failed:', e?.message);
  }
  return '';
};

// Fire-and-forget alert that works with the app in the background:
//  • Android APK: the native bringToFront bridge above (same as GPS arrival),
//    with a high-priority local notification as the fallback when the bridge is
//    unavailable. Either way the queued confirm panel is waiting on return.
//  • Browser/PWA: a service-worker notification where available, falling back
//    to a plain Notification.
// The siren + vibration are also attempted here in case the OS still lets
// audio play while hidden.
const notifyImpactWhileHidden = () => {
  (async () => {
    try { startEmergencyAlarm(); } catch { /* audio may be blocked while hidden */ }
    // Native APK: hand off to the same bridge the GPS arrival trigger uses.
    const bridgeStatus = bringAppForward(
      'Possible impact detected',
      'Tap to open RxDeliver and confirm your emergency.'
    );
    if (bridgeStatus) return;
    try {
      const { Capacitor } = await import('@capacitor/core');
      if (Capacitor?.isNativePlatform?.()) {
        const { LocalNotifications } = await import('@capacitor/local-notifications');
        try {
          const perm = await LocalNotifications.checkPermissions();
          if (perm?.display !== 'granted') await LocalNotifications.requestPermissions();
        } catch { /* ignore */ }
        await LocalNotifications.schedule({
          notifications: [{
            id: IMPACT_NOTIFICATION_ID,
            title: 'Possible impact detected',
            body: 'Tap to open RxDeliver and confirm your emergency.',
            smallIcon: 'ic_stat_notify',
            iconColor: '#dc2626',
            sound: undefined,
            ongoing: true,
            autoCancel: false,
            extra: { __emergency_impact: true }
          }]
        });
        return;
      }
    } catch { /* not native */ }

    try {
      if (typeof Notification === 'undefined') return;
      if (Notification.permission === 'default') await Notification.requestPermission();
      if (Notification.permission !== 'granted') return;
      const options = {
        body: 'Tap to open RxDeliver and confirm your emergency.',
        tag: 'rx-emergency-impact',
        renotify: true,
        requireInteraction: true,
        vibrate: [700, 250, 700, 250],
        data: { __emergency_impact: true }
      };
      const reg = await navigator.serviceWorker?.getRegistration?.();
      if (reg?.showNotification) await reg.showNotification('Possible impact detected', options);
      else new Notification('Possible impact detected', options);
    } catch { /* ignore */ }
  })();
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
  // 0 → 1 progress of the 5-second map hold. Feeds the same progressive red
  // fill on the driver legend (owner request Nov 14 2026).
  const [holdProgress, setHoldProgress] = useState(0);
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
  // Global activation + sensitivity (Admin Utilities > App > Emergency System).
  const [emergencySettings, setEmergencySettings] = useState({
    manual_enabled: true,
    crash_enabled: true,
    crash_threshold: 42
  });
  const pendingRef = useRef(null);
  const activeRef = useRef(null);
  // A confirmed impact that happened while the app was hidden or backgrounded.
  // The panel cannot be shown over another app, so it is queued and opened the
  // moment RxDeliver comes back to the foreground.
  const queuedImpactRef = useRef(false);

  useEffect(() => { pendingRef.current = pending; }, [pending]);
  useEffect(() => { activeRef.current = activeAlert; }, [activeAlert]);

  // ── Global settings (activation switches + hit sensitivity) ──────────────
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const load = async () => {
      try {
        const rows = await base44.entities.AppSettings.filter({ setting_key: 'refresh_intervals' });
        let raw = rows?.[0]?.setting_value;
        if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { raw = null; } }
        let stored = raw?.emergency_settings;
        if (typeof stored === 'string') { try { stored = JSON.parse(stored); } catch { stored = null; } }
        if (!alive || !stored) return;
        setEmergencySettings((prev) => ({ ...prev, ...stored }));
      } catch { /* defaults stand */ }
    };
    load();
    const onUpdated = (event) => {
      const stored = event?.detail?.data?.setting_value?.emergency_settings;
      if (stored) setEmergencySettings((prev) => ({ ...prev, ...stored }));
    };
    window.addEventListener('emergencySettingsUpdated', onUpdated);
    return () => {
      alive = false;
      window.removeEventListener('emergencySettingsUpdated', onUpdated);
    };
  }, [enabled]);

  // Expose the gate so the map's long-press only draws its ring for an owner.
  useEffect(() => {
    try { window.__rxEmergencyArmed = !!(enabled && emergencySettings.manual_enabled); } catch { /* ignore */ }
    return () => { try { window.__rxEmergencyArmed = false; } catch { /* ignore */ } };
  }, [enabled, emergencySettings.manual_enabled]);

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
    // The confirmation panel takes over every visual cue: clear the legend fill
    // and its message the moment it opens (owner request Nov 14 2026).
    setHoldProgress(0);
    setImpactProgress(0);
    try {
      window.dispatchEvent(new CustomEvent('rx-emergency-impact', { detail: { active: false, progress: 0, label: 'Impact detected' } }));
    } catch { /* ignore */ }
    // Sound the emergency siren the moment the confirmation window opens, so
    // the driver knows the system fired (owner request Nov 14 2026). It keeps
    // running if the alert sends, and stops on Cancel.
    playArmTick();
    startEmergencyAlarm();
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
    if (!enabled || !emergencySettings.crash_enabled) return;
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
      // Sensitivity comes from Admin Utilities so the owner can tune it live
      // (Nov 14 2026: placing the phone on a charger was tripping the default).
      // Sensitivity comes from Admin Utilities. Clamped so a stale saved value
      // can never make the sensor hair-trigger.
      const configured = Math.max(MIN_THRESHOLD, Math.min(MAX_THRESHOLD, Number(emergencySettings.crash_threshold) || CRASH_SPIKE));
      // A hit is judged on PEAK MAGNITUDE ONLY. The old "or a sudden jump"
      // branch is gone: a finger tap, a charger cable or a phone set down all
      // produced big single-sample jumps, which made the slider do nothing
      // (owner report Nov 14 2026).
      const spikeThreshold = usesGravity ? configured : Math.max(12, configured - GRAVITY);
      const stillBand = usesGravity ? STILL_BAND : STILL_BAND_RAW;

      const previous = state.lastMagnitude;
      state.lastMagnitude = magnitude;
      if (magnitude > (state.peak || 0)) state.peak = magnitude;
      state.lastJerk = previous == null ? 0 : Math.abs(magnitude - previous);

      const bigSample = magnitude >= spikeThreshold;
      if (bigSample && now - (state.firedAt || 0) > CRASH_COOLDOWN_MS) {
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
        // OWNER SPEC Nov 14 2026: detection must survive the app being
        // minimised. If we are hidden, we cannot draw the panel over another
        // app, so queue it, fire a high-priority local notification (its tap
        // brings RxDeliver forward) and open the panel on resume.
        if (isHiddenNow()) {
          queuedImpactRef.current = true;
          persistQueuedImpact();
          notifyImpactWhileHidden();
        } else {
          openConfirm('crash', 'accident');
        }
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
  }, [enabled, openConfirm, emergencySettings.crash_enabled, emergencySettings.crash_threshold]);

  // ── Background / resume handling ─────────────────────────────────────────
  // Keeps the pilot honest when the app is minimised: whatever was detected
  // while hidden is turned into the confirm panel the instant RxDeliver is back
  // in front, whether the driver returned by tapping the notification or by
  // reopening the app.
  useEffect(() => {
    if (!enabled) return;

    const resume = () => {
      const state = crashStateRef.current;
      // Sensors freeze while the app is hidden, so a spike captured just before
      // backgrounding is judged on wall-clock time: hit, then nothing for the
      // whole stillness window == confirmed.
      if (!queuedImpactRef.current && state.spikeAt && state.quietSince &&
          Date.now() - state.quietSince >= CRASH_QUIET_MS) {
        queuedImpactRef.current = true;
        state.spikeAt = null;
        state.peak = 0;
      }
      if (!queuedImpactRef.current && !consumeQueuedImpact()) return;
      queuedImpactRef.current = false;
      try { localStorage.removeItem(QUEUED_IMPACT_KEY); } catch { /* ignore */ }
      openConfirm('crash', 'accident');
    };

    // Activity recreated by the bringToFront hand-off or the full-screen
    // notification: pick the queued impact up once the app has settled.
    const bootTimer = setTimeout(() => {
      if (consumeQueuedImpact()) openConfirm('crash', 'accident');
    }, 2000);

    const onVisibility = () => { if (!isHiddenNow()) resume(); };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onVisibility);

    let appStateHandle = null;
    let notifHandle = null;
    (async () => {
      try {
        const { Capacitor } = await import('@capacitor/core');
        if (!Capacitor?.isNativePlatform?.()) return;
        try {
          const { App } = await import('@capacitor/app');
          appStateHandle = await App.addListener('appStateChange', (state) => {
            if (state?.isActive) resume();
          });
        } catch { /* plugin missing */ }
        try {
          const { LocalNotifications } = await import('@capacitor/local-notifications');
          notifHandle = await LocalNotifications.addListener('localNotificationActionPerformed', (action) => {
            const isImpact = !!action?.notification?.extra?.__emergency_impact;
            if (!isImpact) return;
            queuedImpactRef.current = true;
            resume();
          });
        } catch { /* plugin missing */ }
      } catch { /* web */ }
    })();

    return () => {
      clearTimeout(bootTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onVisibility);
      try { appStateHandle?.remove?.(); } catch { /* ignore */ }
      try { notifHandle?.remove?.(); } catch { /* ignore */ }
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

  // Mirror the map hold into state so the legend can fill progressively.
  useEffect(() => {
    if (!enabled) return;
    const onStart = () => setHoldProgress(0.001);
    const onProgress = (event) => setHoldProgress(Math.max(0, Math.min(1, Number(event?.detail?.progress) || 0)));
    const onEnd = () => setHoldProgress(0);
    window.addEventListener('rx-emergency-hold-start', onStart);
    window.addEventListener('rx-emergency-hold-progress', onProgress);
    window.addEventListener('rx-emergency-hold-end', onEnd);
    return () => {
      window.removeEventListener('rx-emergency-hold-start', onStart);
      window.removeEventListener('rx-emergency-hold-progress', onProgress);
      window.removeEventListener('rx-emergency-hold-end', onEnd);
    };
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

  // ── Legend signal ────────────────────────────────────────────────────────
  // The top red bars are gone (owner request Nov 14 2026). Instead the DRIVER
  // LEGEND fills red and shows "Impact detected" underneath while the hit
  // window is running.
  const impactActive = !pending && impactProgress > 0;
  // Progress is forwarded on every tick so the driver legend can fill
  // proportionally as the detection window counts down (owner request
  // Nov 14 2026), not just flip to solid red.
  const holdActive = !pending && holdProgress > 0;
  useEffect(() => {
    const detail = holdActive
      ? { active: true, progress: holdProgress, label: 'Hold to activate emergency' }
      : { active: impactActive, progress: impactActive ? impactProgress : 0, label: 'Impact detected' };
    try {
      window.dispatchEvent(new CustomEvent('rx-emergency-impact', { detail }));
    } catch { /* ignore */ }
  }, [impactActive, impactProgress, holdActive, holdProgress]);
  useEffect(() => () => {
    try { window.dispatchEvent(new CustomEvent('rx-emergency-impact', { detail: { active: false } })); } catch { /* ignore */ }
  }, []);

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
      // ── DEVICE FAN-OUT (owner bug report Nov 14 2026) ─────────────────────
      // Realtime alone NEVER reached the tablet: an Android APK whose WebView is
      // minimised or swiped away has no live JS, so the EmergencyAlert subscribe
      // callback (and the 60s poll) cannot fire, and the siren cannot start.
      // Push is the only channel that survives that state, so every owner device
      // except the one that raised the alert gets an FCM/WebPush notification on
      // the dedicated rx_emergency channel (alarm-stream sound, high importance,
      // full-screen intent on the APK).
      (async () => {
        try {
          const selfDevice = (() => { try { return localStorage.getItem('rxdeliver_device_identifier') || null; } catch { return null; } })();
          const targetUserId = currentUser?.user_id || currentUser?.id;
          if (!targetUserId) return;
          await base44.functions.invoke('sendPushNotification', {
            user_id: targetUserId,
            exclude_device: selfDevice,
            title: 'RxDeliver EMERGENCY',
            body: `${record?.driver_name || 'App Owner'}: ${ALERT_LABELS[record?.alert_type] || 'Emergency alert'} (${record?.source === 'crash' ? 'impact detected' : 'manual'})`,
            url: '/dashboard',
            tag: 'rx-emergency',
            requireInteraction: true,
            force: true,
            channel: 'rx_emergency',
            data: { type: 'emergency', alert_id: record?.id, alert_type: record?.alert_type, source: record?.source }
          });
        } catch (e) {
          console.warn('[Emergency] Alert push fan-out failed:', e?.message || e);
        }
      })();
    } catch (err) {
      setError(err?.message || 'Could not send the emergency alert.');
    } finally {
      setSending(false);
    }
  }, [currentUser, notes, sending]);

  const cancelPending = useCallback(() => {
    setPending(null);
    setError('');
    // Cancelling kills the confirmation siren. (An already-active alert keeps
    // its own siren — that is handled by the active-alert effect.)
    if (!activeRef.current) stopEmergencyAlarm();
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
    </>
  );
};

export default EmergencyController;
export { HOLD_MS, HOLD_MOVE_TOLERANCE_PX };
