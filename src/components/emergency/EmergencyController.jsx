import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { base44 } from '@/api/base44Client';
import {
  DEFAULT_EMERGENCY_SETTINGS,
  isEmergencyEnabledForUser,
  mergeEmergencySettings,
  readCachedEmergencySettings,
  writeCachedEmergencySettings
} from './emergencyAccess';
import {
  startEmergencyAlarm,
  stopEmergencyAlarm,
  playArmTick,
  playCancellationChime,
  isEmergencyAlarmRunning
} from './emergencyAlarm';
import {
  beginEmergencyIncident,
  markIncidentConfirmed,
  markIncidentCancelled,
  markIncidentResolved,
  markIncidentAutoSendPaused,
  getIncidentLocation,
  buildAlertLocationText,
  startEmergencyLogHousekeeping,
  clearCurrentIncident
} from './emergencyAlertLog';
import { formatCoords, buildMapUrl } from '../utils/reverseGeocode';

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
// FALSE-POSITIVE GUARDS (owner report Nov 23 2026): "many times I just tapped
// the screen to move the map or pinch to zoom and it partly activated the impact
// detection — the red bars started scrolling." A single sample over the
// threshold used to open the stillness window, so any tap, pinch or map drag
// started the bar (and then never completed). Two guards now apply:
//   1. a spike within TOUCH_QUIET_MS of a real touch is ignored — a finger on
//      the glass is not a crash;
//   2. a spike must be corroborated by a second sample inside
//      CRASH_CONFIRM_MS, unless it is far over the threshold (a real hit).
const TOUCH_QUIET_MS = 1200;
const CRASH_CONFIRM_MS = 320;
const CRASH_HARD_FACTOR = 1.35;

const ALERT_LABELS = {
  accident: 'Accident',
  medical: 'Medical emergency',
  other: 'Emergency'
};

const IMPACT_NOTIFICATION_ID = 9911;
// How long the green "stand down" banner stays on screen.
const STAND_DOWN_BANNER_MS = 12000;

const readDeviceIdentifier = () => {
  try { return localStorage.getItem('rxdeliver_device_identifier') || null; } catch { return null; }
};

const readDeviceName = () => {
  try { return localStorage.getItem('rxdeliver_device_name') || null; } catch { return null; }
};
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
      // OWNER REPORT (Nov 26 2026): the in-app siren is the ONLY sound. This OS
      // notification was unsilent with renotify, so the device played its own
      // alert tone over the siren (and kept alerting after the alert resolved on
      // the tablet). Silent, no renotify, still sticky so it cannot be missed.
      const options = {
        body: 'Tap to open RxDeliver and confirm your emergency.',
        tag: 'rx-emergency-impact',
        renotify: false,
        silent: true,
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
  // Pilot scope (owner request Nov 14 2026): App Owner, "All users", or the
  // accounts picked in Admin Utilities > Data > Alerts > Emergency System.
  // emergencySettings is declared below and feeds the gate, so the scope can be
  // changed without a code push. Legacy hardcoded testers still count.

  const [pending, setPending] = useState(null); // { source, alertType }
  const [countdown, setCountdown] = useState(COUNTDOWN_SECONDS);
  // Owner spec Nov 14 2026: any deliberate interaction with the app while the
  // detection screen is up HALTS the auto-send countdown. The screen then waits
  // for an explicit Activate or Cancel instead of firing on a timer.
  const [autoSendPaused, setAutoSendPaused] = useState(false);
  // Live progress of the impact-detection window. Drives the red bar that shows
  // BEFORE the confirm screen, so the driver can see a hard hit registered.
  const [impactProgress, setImpactProgress] = useState(0);
  // Timestamp of the last real touch (tap / pinch / drag) and the last
  // uncorroborated spike, both used to reject false impacts.
  const touchAtRef = useRef(0);
  const pendingSpikeRef = useRef(null);
  const [impactPeak, setImpactPeak] = useState(0);
  // 0 → 1 progress of the 5-second map hold. Feeds the same progressive red
  // fill on the driver legend (owner request Nov 14 2026).
  const [holdProgress, setHoldProgress] = useState(0);
  const [notes, setNotes] = useState('');
  const [activeAlert, setActiveAlert] = useState(null);
  const [sending, setSending] = useState(false);
  const [crashArmed, setCrashArmed] = useState(false);
  const [error, setError] = useState('');
  // Green stand-down banner (owner request Nov 14 2026): shown to everyone who
  // received the red alert once it is cancelled.
  const [standDown, setStandDown] = useState(null);
  const standDownTimerRef = useRef(null);
  const lastStandDownRef = useRef({ id: null, at: 0 });

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
  // Global activation + sensitivity + pilot scope, all stored in one place
  // (Admin Utilities > Data > Alerts > Emergency System). Seeded from the local
  // cache so a selected test device is armed on the first render, not a beat later.
  const [emergencySettings, setEmergencySettings] = useState(
    () => readCachedEmergencySettings() || { ...DEFAULT_EMERGENCY_SETTINGS }
  );
  const pendingRef = useRef(null);
  const activeRef = useRef(null);
  // A confirmed impact that happened while the app was hidden or backgrounded.
  // The panel cannot be shown over another app, so it is queued and opened the
  // moment RxDeliver comes back to the foreground.
  const queuedImpactRef = useRef(false);

  const enabled = useMemo(
    () => isEmergencyEnabledForUser(currentUser, emergencySettings),
    [currentUser, emergencySettings]
  );

  useEffect(() => { pendingRef.current = pending; }, [pending]);
  useEffect(() => { activeRef.current = activeAlert; }, [activeAlert]);

  // Replay offline log rows and close out a row left pending by a crash.
  useEffect(() => {
    if (!enabled) return undefined;
    return startEmergencyLogHousekeeping();
  }, [enabled]);

  // ── Global settings (activation switches + hit sensitivity) ──────────────
  // NOTE: this loader must NOT be gated on `enabled` — it is what decides
  // `enabled` (pilot scope list). Every signed-in device reads one small
  // AppSettings row on boot; the result is cached locally for instant arming.
  useEffect(() => {
    let alive = true;
    const applySettings = (stored) => {
      if (!stored) return;
      setEmergencySettings((prev) => {
        const next = mergeEmergencySettings({ ...prev, ...stored });
        writeCachedEmergencySettings(next);
        return next;
      });
    };
    const load = async () => {
      try {
        const rows = await base44.entities.AppSettings.filter({ setting_key: 'refresh_intervals' });
        let raw = rows?.[0]?.setting_value;
        if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { raw = null; } }
        let stored = raw?.emergency_settings;
        if (typeof stored === 'string') { try { stored = JSON.parse(stored); } catch { stored = null; } }
        if (!alive || !stored) return;
        applySettings(stored);
      } catch { /* defaults stand */ }
    };
    load();
    const onUpdated = (event) => {
      const stored = event?.detail?.data?.setting_value?.emergency_settings;
      if (stored) applySettings(typeof stored === 'string' ? (() => { try { return JSON.parse(stored); } catch { return null; } })() : stored);
    };
    window.addEventListener('emergencySettingsUpdated', onUpdated);
    // OWNER REPORT (Nov 17 2026): adding a tester took effect only after an app
    // restart, while removing one felt instant. Deactivation looked instant only
    // because the removed account stops passing the gate; a NEWLY added account
    // never re-read the row until the 5-minute poll or a reload. Follow the
    // AppSettings row live over the entity websocket so a save on any device
    // re-scopes every device immediately, both ways.
    let unsubSettings = null;
    try {
      unsubSettings = base44.entities.AppSettings.subscribe((event) => {
        const rec = event?.data;
        if (!rec) return;
        if (rec.setting_key && rec.setting_key !== 'refresh_intervals') return;
        let raw = rec.setting_value;
        if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { return; } }
        let stored = raw?.emergency_settings;
        if (typeof stored === 'string') { try { stored = JSON.parse(stored); } catch { return; } }
        if (stored) applySettings(stored);
      });
    } catch { /* realtime unavailable — the poll below still covers us */ }
    // A device that stays open for hours must pick up a scope change without a
    // reload (owner request: pick testers at any time). One small cached read
    // every 5 minutes also DISARMS an account that was removed from the list.
    const poll = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 5 * 60 * 1000);
    return () => {
      alive = false;
      clearInterval(poll);
      window.removeEventListener('emergencySettingsUpdated', onUpdated);
      if (typeof unsubSettings === 'function') unsubSettings();
    };
  }, []);

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
          // Another device stood the alert down: green banner + soft chime here.
          if (record.status === 'cancelled') handleRemoteStandDown(record);
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

    // ── HISTORY ROW (owner request Nov 14 2026) ────────────────────────────
    // Opened the moment the screen appears, so a countdown that is cancelled
    // AND one that proceeds both land in EmergencyAlertLog with the trigger
    // time, the GPS fix and the nearest address. Written in the background —
    // nothing here is awaited.
    try {
      beginEmergencyIncident({
        source,
        alertType,
        peakForce: crashStateRef.current?.peak || impactPeak || null,
        sensitivity: emergencySettings.crash_threshold,
        countdownSeconds: COUNTDOWN_SECONDS,
        driverId: currentUser?.user_id || currentUser?.id || null,
        driverName: currentUser?.full_name || currentUser?.user_name || 'App Owner',
        deviceIdentifier: readDeviceIdentifier(),
        deviceName: readDeviceName(),
        cityId: currentUser?.city_id || null,
        storeIds: Array.isArray(currentUser?.store_ids) ? currentUser.store_ids : []
      });
    } catch (e) {
      console.warn('[Emergency] Could not open the alert history row:', e?.message || e);
    }
  }, [enabled, currentUser, emergencySettings.crash_threshold, impactPeak]);

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

    // Any deliberate finger contact (tap, pinch, map drag) stamps a time so the
    // sensor can ignore the jolt that contact itself produces.
    const stampTouch = () => { touchAtRef.current = Date.now(); };

    const attach = () => {
      try {
        window.addEventListener('devicemotion', handleMotion, { passive: true });
        window.addEventListener('pointerdown', stampTouch, { passive: true, capture: true });
        window.addEventListener('touchstart', stampTouch, { passive: true, capture: true });
        window.addEventListener('gesturestart', stampTouch, { passive: true, capture: true });
        window.addEventListener('wheel', stampTouch, { passive: true, capture: true });
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
        // GUARD 1 — a finger on the screen is not a crash. Taps, pinches and map
        // drags all produce a jolt; ignore any spike that lands within
        // TOUCH_QUIET_MS of real touch input.
        if (now - (touchAtRef.current || 0) < TOUCH_QUIET_MS) {
          pendingSpikeRef.current = null;
          return;
        }
        const hardHit = magnitude >= spikeThreshold * CRASH_HARD_FACTOR;
        const pending = pendingSpikeRef.current;
        const corroborated = hardHit || (pending && now - pending.at <= CRASH_CONFIRM_MS);
        if (!corroborated) {
          // GUARD 2 — one lonely sample is a bump, not an impact. Wait for a
          // second sample before the stillness window (and the red bar) opens.
          pendingSpikeRef.current = { at: now, mag: magnitude };
          return;
        }
        pendingSpikeRef.current = null;
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
      window.removeEventListener('pointerdown', stampTouch, { capture: true });
      window.removeEventListener('touchstart', stampTouch, { capture: true });
      window.removeEventListener('gesturestart', stampTouch, { capture: true });
      window.removeEventListener('wheel', stampTouch, { capture: true });
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

  // ── Stand-down notice (green banner + soft chime) ─────────────────────────
  // Owner request Nov 14 2026: "a similar set of notification for cancellation
  // with pushes and a green banner and a nicer sound." Shown on every device
  // that received the red alert, including the one that cancelled.
  const showStandDown = useCallback((detail = {}) => {
    try {
      setStandDown({ ...detail, at: Date.now() });
      playCancellationChime();
      if (standDownTimerRef.current) clearTimeout(standDownTimerRef.current);
      standDownTimerRef.current = setTimeout(() => setStandDown(null), STAND_DOWN_BANNER_MS);
    } catch { /* never let a banner break the alert flow */ }
  }, []);

  const handleRemoteStandDown = useCallback((record, extra = {}) => {
    if (!record?.id) return;
    const now = Date.now();
    // Realtime echo + push usually arrive for the same cancel: chime once.
    if (lastStandDownRef.current.id === record.id && (now - lastStandDownRef.current.at) < 20000) return;
    lastStandDownRef.current = { id: record.id, at: now };
    const coords = formatCoords(record.latitude, record.longitude, record.gps_accuracy);
    showStandDown({
      by: extra.by || record.resolved_by_name || record.muted_by || 'Dispatch',
      address: extra.address || record.nearest_address || '',
      coords: extra.coords || coords || '',
      mapUrl: record.map_url || ''
    });
  }, [showStandDown]);

  // Wearable/APK push listener hands us 'rx-emergency-cancelled' when another
  // device stands the alert down while this app is open.
  useEffect(() => {
    const onCancelled = (event) => {
      const detail = event?.detail || {};
      handleRemoteStandDown({
        id: detail.alert_id,
        latitude: detail.latitude,
        longitude: detail.longitude,
        nearest_address: detail.address,
        map_url: detail.map_url,
        resolved_by_name: detail.by || detail.title
      }, { by: detail.by, address: detail.address, map_url: detail.map_url });
    };
    window.addEventListener('rx-emergency-cancelled', onCancelled);
    return () => {
      window.removeEventListener('rx-emergency-cancelled', onCancelled);
      if (standDownTimerRef.current) clearTimeout(standDownTimerRef.current);
    };
  }, [handleRemoteStandDown]);

  // ── Send the alert ────────────────────────────────────────────────────────
  const sendAlert = useCallback(async (currentNotes = notes) => {
    if (!pendingRef.current || sending) return;
    setSending(true);
    setError('');
    const payloadNotes = String(currentNotes || '').trim() ||
      `${ALERT_LABELS[pendingRef.current.alertType] || 'Emergency'} declared from the RxDeliver dashboard${pendingRef.current.source === 'crash' ? ' after impact detection' : ''}.`;

    // Location was already captured when the screen opened (the 10s countdown
    // gave the GPS + HERE reverse geocode time to land). Fall back to a fresh
    // fix only when that came back empty — a dispatcher must get coords with the
    // push even if the address lookup failed (owner request Nov 14 2026).
    let fix = await getIncidentLocation();
    if (!fix || !Number.isFinite(Number(fix.latitude))) {
      const position = await new Promise((resolve) => {
        if (typeof navigator === 'undefined' || !navigator.geolocation) return resolve(null);
        navigator.geolocation.getCurrentPosition(
          (pos) => resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracy: pos.coords.accuracy }),
          () => resolve(null),
          { enableHighAccuracy: true, timeout: 4000, maximumAge: 30000 }
        );
      });
      fix = position || null;
    }
    const locationText = buildAlertLocationText(fix);
    const mapUrl = fix && Number.isFinite(Number(fix.latitude)) ? buildMapUrl(fix.latitude, fix.longitude) : '';

    try {
      const record = await base44.entities.EmergencyAlert.create({
        driver_id: currentUser?.user_id || currentUser?.id || null,
        driver_name: currentUser?.full_name || currentUser?.user_name || 'App Owner',
        alert_type: pendingRef.current.alertType || 'other',
        source: pendingRef.current.source || 'manual',
        notes: payloadNotes,
        status: 'active',
        activated_at: new Date().toISOString(),
        latitude: fix?.latitude ?? null,
        longitude: fix?.longitude ?? null,
        gps_accuracy: Number.isFinite(Number(fix?.accuracy)) ? Math.round(Number(fix.accuracy)) : null,
        nearest_address: fix?.address || null,
        map_url: mapUrl || null,
        store_ids: Array.isArray(currentUser?.store_ids) ? currentUser.store_ids : [],
        city_id: currentUser?.city_id || null,
        device_identifier: (() => { try { return localStorage.getItem('rxdeliver_device_identifier') || null; } catch { return null; } })()
      });
      setActiveAlert(record);
      startEmergencyAlarm();
      setPending(null);
      // Close out the history row: the confirmation screen proceeded.
      try {
        markIncidentConfirmed({
          alertId: record?.id || null,
          notes: payloadNotes,
          recipientUserIds: [currentUser?.user_id || currentUser?.id || null].filter(Boolean)
        });
      } catch (e) {
        console.warn('[Emergency] Could not confirm the alert history row:', e?.message || e);
      }
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
          const selfDevice = readDeviceIdentifier();
          const targetUserId = currentUser?.user_id || currentUser?.id;
          if (!targetUserId) return;
          // GPS coords + nearest address ride in BOTH the visible body and the
          // data payload, so a dispatcher knows where the driver is without
          // opening the app (owner request Nov 14 2026).
          const pushBody = `${record?.driver_name || 'App Owner'}: ${ALERT_LABELS[record?.alert_type] || 'Emergency alert'} (${record?.source === 'crash' ? 'impact detected' : 'manual'})${locationText ? ` — ${locationText}` : ' — location unavailable'}`;
          const pushRes = await base44.functions.invoke('sendPushNotification', {
            user_id: targetUserId,
            exclude_device: selfDevice,
            title: 'RxDeliver EMERGENCY',
            body: pushBody,
            url: '/dashboard',
            tag: 'rx-emergency',
            requireInteraction: true,
            force: true,
            channel: 'rx_emergency_v2',   // SILENT channel — the in-app siren is the only sound
            data: {
              type: 'emergency',
              // title/body/tag ride in the DATA payload too: the native
              // RxEmergencyPushService reads them when the WebView is dead.
              title: 'RxDeliver EMERGENCY',
              body: pushBody,
              tag: 'rx-emergency',
              alert_id: record?.id,
              alert_type: record?.alert_type,
              source: record?.source,
              latitude: fix?.latitude ?? null,
              longitude: fix?.longitude ?? null,
              accuracy: Number.isFinite(Number(fix?.accuracy)) ? Math.round(Number(fix.accuracy)) : null,
              address: fix?.address || null,
              map_url: mapUrl || null
            }
          });
          // Save what the fan-out actually reported (recipients reached) onto
          // the history row so the audit shows who got the coords.
          try {
            const summary = pushRes?.data || pushRes || {};
            markIncidentConfirmed({
              alertId: record?.id || null,
              notes: payloadNotes,
              recipientUserIds: [targetUserId],
              recipientCount: Number.isFinite(Number(summary?.sent)) ? Number(summary.sent) : null,
              pushResult: JSON.stringify({
                sent: summary?.sent ?? null,
                fcmSent: summary?.fcmSent ?? null,
                webSent: summary?.webSent ?? null,
                skipped: summary?.skipped ?? null,
                errors: Array.isArray(summary?.errors) ? summary.errors.slice(0, 3) : undefined
              })
            });
          } catch { /* logging must never break the alert */ }
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
    // Owner request Nov 14 2026: a cancelled confirmation is recorded too, with
    // the trigger time, location and how long the screen was up. Nobody was
    // notified for this one, so no stand-down push goes out.
    try {
      markIncidentCancelled({ stage: 'confirm_screen', notified: false });
      clearCurrentIncident();
    } catch (e) {
      console.warn('[Emergency] Could not log the cancelled confirmation:', e?.message || e);
    }
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
    const onInteract = () => { setAutoSendPaused(true); try { markIncidentAutoSendPaused(); } catch { /* ignore */ } };
    const onKey = () => { setAutoSendPaused(true); try { markIncidentAutoSendPaused(); } catch { /* ignore */ } };
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
    const byName = currentUser?.full_name || currentUser?.user_name || 'App Owner';

    // Show the stand-down here too, and claim the id so the realtime echo of our
    // own write does not chime a second time.
    lastStandDownRef.current = { id: alert.id, at: Date.now() };
    showStandDown({
      by: byName,
      address: alert.nearest_address || '',
      coords: formatCoords(alert.latitude, alert.longitude, alert.gps_accuracy),
      mapUrl: alert.map_url || ''
    });

    try {
      await base44.entities.EmergencyAlert.update(alert.id, {
        status: 'cancelled',
        resolved_at: new Date().toISOString(),
        resolved_by: currentUser?.user_id || currentUser?.id || null,
        resolved_by_name: byName,
        muted_by: byName
      });
    } catch (err) {
      console.warn('[Emergency] Could not cancel alert:', err?.message || err);
    }

    // ── STAND-DOWN PUSH (owner request Nov 14 2026) ────────────────────────
    // Every device that got the red alert gets the green one, with the same
    // coords + nearest address, and the in-app chime plays on arrival.
    let pushSummary = null;
    try {
      const targetUserId = currentUser?.user_id || currentUser?.id;
      if (targetUserId) {
        const locationText = buildAlertLocationText({
          latitude: alert.latitude,
          longitude: alert.longitude,
          accuracy: alert.gps_accuracy,
          address: alert.nearest_address
        });
        const res = await base44.functions.invoke('sendPushNotification', {
          user_id: targetUserId,
          exclude_device: readDeviceIdentifier(),
          title: 'RxDeliver EMERGENCY CANCELLED',
          body: `${byName} cancelled the emergency${locationText ? ` — ${locationText}` : ''}`,
          url: '/dashboard',
          tag: 'rx-emergency-cancelled',
          force: true,
          channel: 'rx_emergency_v2',
          data: {
            type: 'emergency_cancelled',
            title: 'RxDeliver EMERGENCY CANCELLED',
            body: `${byName} cancelled the emergency`,
            by: byName,
            tag: 'rx-emergency-cancelled',
            alert_id: alert.id,
            latitude: alert.latitude ?? null,
            longitude: alert.longitude ?? null,
            address: alert.nearest_address || null,
            map_url: alert.map_url || null
          }
        });
        pushSummary = res?.data || res || null;
      }
    } catch (err) {
      console.warn('[Emergency] Stand-down push failed:', err?.message || err);
    }

    // Log the stand-down on the driver's history row, then release it.
    try {
      markIncidentCancelled({
        stage: 'active_alert',
        reason: `stood down by ${byName}`,
        notified: !!(pushSummary && Number(pushSummary?.sent) > 0),
        pushResult: pushSummary ? JSON.stringify({
          sent: pushSummary?.sent ?? null,
          fcmSent: pushSummary?.fcmSent ?? null,
          webSent: pushSummary?.webSent ?? null
        }) : null
      });
      clearCurrentIncident();
    } catch (e) {
      console.warn('[Emergency] Could not log the stand-down:', e?.message || e);
    }
  }, [currentUser, showStandDown]);

  if (!enabled) return null;

  // PORTAL (owner report Nov 16 2026): the red live banner and the green stand-down
  // banner must sit ABOVE the mobile header. Rendered inline they were trapped inside
  // the dashboard's stacking context, so z-index alone could not lift them over the
  // header. Portalled to document.body with 70k-level z-index they always win.
  const _overlayContent = (
    <>
      {/* ── Pulsing banner while an emergency is live ─────────────────────── */}
      {activeAlert && (
        <button
          type="button"
          onClick={silenceEverywhere}
          title="Tap to silence this emergency on every device"
          className="rx-eq-banner"
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            width: '100%',
            zIndex: 70000,
            border: 'none',
            cursor: 'pointer',
            font: 'inherit',
            padding: '10px 14px 12px',
            // Top inset: on the APK the WebView is edge-to-edge (Android 15
            // enforces it), so the banner sat UNDER the status bar / notification
            // panel — owner report Nov 14 2026. MainActivity injects the real
            // status-bar height as --native-safe-top; var(--app-inset-top) is
            // the web/PWA fallback.
            paddingTop: 'max(10px, calc(var(--app-inset-top) + 6px))',
            boxSizing: 'border-box',
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
            /* Phones: keep every part of the banner on screen. The hint text is
               the first thing to give up width, then the notes clamp to two
               lines. Owner report Nov 14 2026: banner text ran off the right
               edge on mobile. */
            .rx-eq-banner { box-sizing: border-box; max-width: 100vw; overflow: hidden; text-align: left; }
            .rx-eq-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; width: 100%; margin: 0 auto; }
            .rx-eq-left { flex: 1 1 auto; min-width: 0; overflow: hidden; }
            .rx-eq-title { word-break: break-word; overflow-wrap: anywhere; }
            .rx-eq-notes {
              display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
              overflow: hidden; word-break: break-word; overflow-wrap: anywhere;
            }
            .rx-eq-hint { flex: 0 0 auto; font-size: 11px; font-weight: 800; text-align: right; line-height: 1.25; max-width: 96px; }
            @media (max-width: 430px) {
              .rx-eq-hint { font-size: 9px; max-width: 62px; letter-spacing: 0; }
              .rx-eq-notes { -webkit-line-clamp: 3; }
            }
          `}</style>
          <div className="rx-eq-row" style={{ maxWidth: 720 }}>
            <div className="rx-eq-left">
              <div style={{ fontSize: 11, letterSpacing: 1.2, fontWeight: 700, opacity: 0.9 }}>
                <span style={{ animation: 'rxEmergencyBlink 0.9s steps(2, start) infinite' }}>●</span> EMERGENCY ACTIVE
              </div>
              <div className="rx-eq-title" style={{ fontSize: 15, fontWeight: 800, marginTop: 2 }}>
                {activeAlert.driver_name || 'Driver'} — {ALERT_LABELS[activeAlert.alert_type] || 'Emergency'}
              </div>
              {activeAlert.notes ? (
                <div className="rx-eq-notes" style={{ fontSize: 12, opacity: 0.95, marginTop: 2 }}>
                  {activeAlert.notes}
                </div>
              ) : null}
              {/* Location line (owner request Nov 14 2026): the same nearest
                  address + coords the push carries, visible on screen too. */}
              {(activeAlert.nearest_address || activeAlert.latitude) ? (
                <div className="rx-eq-notes" style={{ fontSize: 12, opacity: 0.95, marginTop: 2, fontWeight: 700 }}>
                  {activeAlert.nearest_address
                    ? activeAlert.nearest_address
                    : formatCoords(activeAlert.latitude, activeAlert.longitude, activeAlert.gps_accuracy)}
                  {activeAlert.latitude ? ` · ${formatCoords(activeAlert.latitude, activeAlert.longitude, null)}` : ''}
                </div>
              ) : null}
            </div>
            <div className="rx-eq-hint">
              TAP TO SILENCE
              <br />
              ALL DEVICES
            </div>
          </div>
        </button>
      )}

      {/* ── Green stand-down banner (owner request Nov 14 2026) ───────────── */}
      {standDown && !activeAlert && (
        <button
          type="button"
          onClick={() => setStandDown(null)}
          title="Tap to dismiss"
          className="rx-eq-banner"
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            width: '100%',
            zIndex: 69990,
            border: 'none',
            cursor: 'pointer',
            font: 'inherit',
            padding: '10px 14px 12px',
            paddingTop: 'max(10px, calc(var(--app-inset-top) + 6px))',
            boxSizing: 'border-box',
            background: 'linear-gradient(180deg, #16a34a 0%, #15803d 100%)',
            color: '#fff',
            boxShadow: '0 6px 24px rgba(22, 163, 74, 0.45)'
          }}>
          <div className="rx-eq-row" style={{ maxWidth: 720 }}>
            <div className="rx-eq-left">
              <div style={{ fontSize: 11, letterSpacing: 1.2, fontWeight: 700, opacity: 0.9 }}>
                ● EMERGENCY CANCELLED
              </div>
              <div className="rx-eq-title" style={{ fontSize: 15, fontWeight: 800, marginTop: 2 }}>
                {standDown.by || 'Dispatch'} stood the alert down
              </div>
              {(standDown.address || standDown.coords) ? (
                <div className="rx-eq-notes" style={{ fontSize: 12, opacity: 0.95, marginTop: 2, fontWeight: 700 }}>
                  {standDown.address || standDown.coords}
                  {standDown.address && standDown.coords ? ` · ${standDown.coords}` : ''}
                </div>
              ) : null}
            </div>
            <div className="rx-eq-hint" style={{ opacity: 0.85 }}>
              NO ACTION
              <br />
              NEEDED
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
            zIndex: 70020,
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

  if (typeof document === 'undefined') return _overlayContent;
  return createPortal(_overlayContent, document.body);
};

export default EmergencyController;
export { HOLD_MS, HOLD_MOVE_TOLERANCE_PX };
