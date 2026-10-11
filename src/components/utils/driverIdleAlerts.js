/**
 * driverIdleAlerts — background idle push notifications (owner request, Sep 28 2026)
 *
 * Two scenarios, both detected while the app process is alive in the
 * background (APK keeps running — JS timers throttle to ~1/min but keep
 * firing, which is exactly the "still consuming battery" state we detect):
 *
 * 1. OFF DUTY, app still running:
 *    The off-duty web-only heartbeat keeps updating location/timestamps even
 *    though the driver clocked out. After 30 min of continuous off-duty
 *    heartbeats, send a local push: "app is still running in the background,
 *    may be using extra battery — Force Close to close it completely."
 *    The notification carries a FORCE CLOSE action button (OFFDUTY_IDLE_ACTIONS)
 *    that calls locationTracker._forceCloseApp() (App.exitApp()).
 *
 * 2. ON BREAK for over an hour with stops remaining:
 *    A 60s watcher (started when the driver's status becomes on_break) checks
 *    elapsed break time + today's remaining stops (offlineDB — available in
 *    background). After 60 min of break with >= 1 non-terminal stop, send a
 *    local push with two action buttons (ONBREAK_IDLE_ACTIONS):
 *      - Acknowledge  → dismiss (no-op — Android auto-dismisses on action tap)
 *      - Continue Route → toggles the driver back on duty via the
 *        'triggerOnDutyFromNotification' event (DriverStatusToggle runs its
 *        full on-duty flow: breadcrumb reconcile, tracker upgrade, FAB phase).
 *
 * Both notifications have a 1-HOUR COOLDOWN (owner directive) so a driver
 * who ignores the alert isn't spammed — the next repeat comes an hour later,
 * and fixed notification IDs replace the previous card instead of stacking.
 *
 * Native APK only (owner framing): PWA/desktop users close tabs naturally
 * and the OS manages their background battery, so web is skipped.
 */

import { isCapacitorNativeApp } from './locationProviders/capacitorRuntime';
import { edmontonWallString } from './albertaTime';

const OFFDUTY_THRESHOLD_MS = 30 * 60 * 1000;   // notify after 30 min off duty + running
const BREAK_THRESHOLD_MS = 60 * 60 * 1000;     // notify after 60 min on break
const COOLDOWN_MS = 60 * 60 * 1000;            // max one repeat per hour per kind
const WATCH_TICK_MS = 60 * 1000;

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

const LS_KEY_OFFDUTY = 'rxdeliver_idle_alert_offduty_last';
const LS_KEY_ONBREAK = 'rxdeliver_idle_alert_onbreak_last';
const NOTIF_ID_OFFDUTY = 86011;
const NOTIF_ID_ONBREAK = 86022;

let _offDutyFirstBeatAt = null;
let _breakStartedAt = null;
let _breakWatchInterval = null;
let _driverUserId = null;

function cooldownAllows(lsKey) {
  try {
    const last = Number(localStorage.getItem(lsKey)) || 0;
    return (Date.now() - last) >= COOLDOWN_MS;
  } catch { return true; }
}

function markNotified(lsKey) {
  try { localStorage.setItem(lsKey, String(Date.now())); } catch { /* non-fatal */ }
}

/** Count today's remaining (non-terminal) stops for the driver from offlineDB. */
async function countRemainingStopsToday() {
  try {
    const { offlineDB } = await import('./offlineDatabase');
    const today = edmontonWallString(new Date()).slice(0, 10);
    const all = await offlineDB.getAll(offlineDB.STORES.DELIVERIES);
    return (all || []).filter(
      (d) => d &&
        d.driver_id === _driverUserId &&
        d.delivery_date === today &&
        !TERMINAL_STATUSES.has(String(d.status || '').toLowerCase())
    ).length;
  } catch { return 0; }
}

async function scheduleIdleNotification(kind, body) {
  if (!isCapacitorNativeApp()) return false;
  const isOffDuty = kind === 'offduty';
  const lsKey = isOffDuty ? LS_KEY_OFFDUTY : LS_KEY_ONBREAK;
  if (!cooldownAllows(lsKey)) return false;
  markNotified(lsKey);
  try {
    const { LocalNotifications } = await import('@capacitor/local-notifications');
    await LocalNotifications.schedule({
      notifications: [{
        id: isOffDuty ? NOTIF_ID_OFFDUTY : NOTIF_ID_ONBREAK,
        title: isOffDuty ? 'RxDeliver is still running' : 'Long break reminder',
        body,
        extra: { __idle_alert: kind },
        smallIcon: 'ic_stat_notify',
        iconColor: '#22c55e',
        actionTypeId: isOffDuty ? 'OFFDUTY_IDLE_ACTIONS' : 'ONBREAK_IDLE_ACTIONS',
      }],
    });
    console.log(`[DriverIdleAlerts] ${kind} idle notification scheduled`);
    return true;
  } catch (err) {
    console.warn(`[DriverIdleAlerts] ${kind} notification failed:`, err?.message);
    return false;
  }
}

// ── Scenario 1: off duty but app keeps heartbeating ─────────────────────────

/**
 * Called from EVERY off-duty web-only heartbeat tick (locationTracker).
 * The first tick starts the clock; once 30 min of continuous off-duty
 * heartbeats have passed, fire the notification (1-hour cooldown).
 */
export function noteOffDutyHeartbeat() {
  if (_offDutyFirstBeatAt == null) {
    _offDutyFirstBeatAt = Date.now();
    return;
  }
  const elapsed = Date.now() - _offDutyFirstBeatAt;
  if (elapsed < OFFDUTY_THRESHOLD_MS) return;
  const minutes = Math.round(elapsed / 60000);
  scheduleIdleNotification(
    'offduty',
    `You're off duty, but the app has been running in the background for ${minutes} minutes and may be using extra battery. Tap Force Close to close it completely.`
  );
}

/** Reset the off-duty clock (duty/break resumed, tracking upgraded/stopped). */
export function resetOffDutyWatch() {
  _offDutyFirstBeatAt = null;
}

/**
 * Idle-kill variant: backgrounded + off duty + stationary. Called by the
 * locationTracker idle-kill timer at its 30-min threshold — the driver gets
 * the notification INSTEAD of the old silent force-close (which now waits
 * until 90 min as a safety net).
 */
export function notifyOffDutyIdleKill(elapsedMs) {
  const minutes = Math.round(elapsedMs / 60000);
  scheduleIdleNotification(
    'offduty',
    `You're off duty, but the app is still running in the background (idle ${minutes} min) and may be using extra battery. Tap Force Close to close it completely.`
  );
}

// ── Scenario 2: on break too long with stops remaining ──────────────────────

function startBreakWatch() {
  if (_breakWatchInterval) return; // already watching
  _breakStartedAt = Date.now();
  const check = async () => {
    if (_breakStartedAt == null) return;
    const elapsed = Date.now() - _breakStartedAt;
    if (elapsed < BREAK_THRESHOLD_MS) return;
    const remaining = await countRemainingStopsToday();
    if (remaining < 1) return; // no stops left — break is fine, stay quiet
    const hours = Math.round(elapsed / 3600000);
    scheduleIdleNotification(
      'onbreak',
      `You've been on break for about ${hours} hour${hours === 1 ? '' : 's'} and still have ${remaining} stop${remaining === 1 ? '' : 's'} remaining. Tap Continue Route to resume, or Acknowledge to dismiss.`
    );
  };
  check().catch(() => {}); // immediate check (covers app restart mid-break)
  _breakWatchInterval = setInterval(() => { check().catch(() => {}); }, WATCH_TICK_MS);
}

function stopBreakWatch() {
  if (_breakWatchInterval) {
    clearInterval(_breakWatchInterval);
    _breakWatchInterval = null;
  }
  _breakStartedAt = null;
}

/**
 * Called from locationTracker.setDriverStatus() (covers the DriverStatusToggle
 * transitions AND the app-load path). on_break starts the watcher; any other
 * status stops it and resets the off-duty clock appropriately.
 */
export function noteDutyStatus(status, driverUserId) {
  if (driverUserId) _driverUserId = driverUserId;
  if (String(status) === 'on_break') {
    startBreakWatch();
  } else {
    stopBreakWatch();
    if (String(status) !== 'off_duty') resetOffDutyWatch();
  }
}
