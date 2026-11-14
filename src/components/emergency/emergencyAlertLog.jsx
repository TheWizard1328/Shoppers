// EMERGENCY ALERT HISTORY (owner request Nov 14 2026)
//
// "Record in a new db all manual and impact activated emergency activations and
// cancellations — each time the confirmation screen was cancelled and proceeded
// successfully. Date and time and location. The recipients of the alerts get the
// GPS coords and nearest address sent to them and saved to the new db."
//
// One row per incident in the EmergencyAlertLog entity, written the moment the
// confirmation screen opens (status pending_confirmation) and then closed out
// with the decision. Writing at trigger time, not at decision time, means a
// phone that dies or force-closes mid-countdown still leaves evidence.
//
// Robustness rules:
//  • Every write is capped at 6s. The Base44 SDK can hang for 15s+ while the
//    device is offline; an emergency UI must never wait on a log write.
//  • A failed or timed-out write is queued in localStorage with its ORIGINAL
//    timestamps and replayed when the device is back online, so an activation
//    in a dead zone is not lost.
//  • Writes for one incident are SERIALISED. The GPS patch can land while the
//    create is still in flight; without a chain that raced into two rows.
//  • Only one incident is "current" per device, mirrored to localStorage so a
//    relaunch mid-countdown can still be closed out.
//  • The module never throws into the emergency UI.

import { base44 } from '@/api/base44Client';
import { reverseGeocode, getQuickPosition, hasUsableCoords, buildMapUrl, formatCoords } from '../utils/reverseGeocode';

const QUEUE_KEY = 'rx_emergency_log_queue_v1';
const CURRENT_KEY = 'rx_emergency_log_current_v1';
const WRITE_TIMEOUT_MS = 6000;
const STALE_PENDING_MS = 2 * 60 * 1000;

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms))
  ]);
}

function newLocalId() {
  return `emg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function safeNowIso() {
  return new Date().toISOString();
}

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    if (value === null || value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch { /* quota / private mode — logging must never break the alert */ }
}

// ── Offline queue ────────────────────────────────────────────────────────────
let queue = readJson(QUEUE_KEY, []);
let flushing = false;

function persistQueue() {
  writeJson(QUEUE_KEY, queue.slice(-50));
}

function queueUpsert(row) {
  const index = queue.findIndex((item) => item.localId === row.localId);
  if (index >= 0) queue[index] = { ...row };
  else queue.push({ ...row });
  persistQueue();
}

function queueRemove(localId) {
  const before = queue.length;
  queue = queue.filter((item) => item.localId !== localId);
  if (queue.length !== before) persistQueue();
}

function stripLocalFields(row) {
  const { localId, cloudId, ...rest } = row;
  return rest;
}

async function writeRow(row) {
  const payload = stripLocalFields(row);
  if (row.cloudId) {
    await withTimeout(base44.entities.EmergencyAlertLog.update(row.cloudId, payload), WRITE_TIMEOUT_MS, 'emergency log update');
    return row.cloudId;
  }
  const created = await withTimeout(base44.entities.EmergencyAlertLog.create(payload), WRITE_TIMEOUT_MS, 'emergency log create');
  return created?.id || null;
}

// ── Current incident ─────────────────────────────────────────────────────────
let current = readJson(CURRENT_KEY, null);
let fixPromise = null;
let writeChain = Promise.resolve();

function readCurrent() {
  return current;
}

function writeCurrent(value) {
  current = value;
  writeJson(CURRENT_KEY, value);
}

/**
 * Replay queued incident rows (offline activations) and finish any pending
 * address lookups. Safe to call often — it no-ops when the queue is empty.
 */
export async function flushEmergencyAlertLog() {
  if (flushing || !queue.length) return;
  flushing = true;
  try {
    for (const queued of [...queue]) {
      let next = { ...queued };
      if (next.address_status !== 'resolved' && hasUsableCoords(next.latitude, next.longitude)) {
        const address = await reverseGeocode(next.latitude, next.longitude);
        if (address) {
          next.nearest_address = address;
          next.address_status = 'resolved';
        }
      }
      try {
        const cloudId = await writeRow(next);
        queueRemove(next.localId);
        if (current && current.localId === next.localId) {
          writeCurrent({ ...current, cloudId, row: { ...current.row, ...next, cloudId } });
        }
      } catch {
        queueUpsert(next);
        break; // still offline — stop hammering
      }
    }
  } finally {
    flushing = false;
  }
}

/** Serialised writer for the current incident. */
function saveCurrentRow() {
  writeChain = writeChain.then(async () => {
    if (!current?.row) return;
    const snapshot = { ...current.row };
    try {
      const cloudId = await writeRow(snapshot);
      if (cloudId) {
        if (current) {
          current = { ...current, cloudId, row: { ...current.row, cloudId } };
          writeCurrent(current);
        }
        snapshot.cloudId = cloudId;
      }
      queueRemove(snapshot.localId);
    } catch {
      queueUpsert(snapshot);
    }
  }).catch(() => {});
  return writeChain;
}

function updateCurrentRow(patch, { persist = true } = {}) {
  if (!current?.row) return null;
  current = { ...current, row: { ...current.row, ...patch } };
  writeCurrent(current);
  if (persist) saveCurrentRow();
  return current.row;
}

function secondsBetween(fromIso, toIso) {
  const from = new Date(fromIso).getTime();
  const to = new Date(toIso).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.max(0, Math.round(((to - from) / 1000) * 10) / 10);
}

/**
 * Open a log row for a confirmation screen. Returns the local id immediately;
 * every write happens in the background.
 */
export function beginEmergencyIncident({
  source = 'manual',
  alertType = 'accident',
  peakForce = null,
  sensitivity = null,
  countdownSeconds = null,
  driverId = null,
  driverName = null,
  deviceIdentifier = null,
  deviceName = null,
  cityId = null,
  storeIds = []
} = {}) {
  const localId = newLocalId();
  const row = {
    localId,
    cloudId: null,
    driver_id: driverId,
    driver_name: driverName,
    source,
    alert_type: alertType,
    status: 'pending_confirmation',
    outcome: 'pending',
    triggered_at: safeNowIso(),
    countdown_seconds: Number.isFinite(Number(countdownSeconds)) ? Number(countdownSeconds) : null,
    auto_send_paused: false,
    peak_force: Number.isFinite(Number(peakForce)) ? Math.round(Number(peakForce) * 10) / 10 : null,
    sensitivity: Number.isFinite(Number(sensitivity)) ? Number(sensitivity) : null,
    device_identifier: deviceIdentifier,
    device_name: deviceName,
    city_id: cityId || null,
    store_ids: Array.isArray(storeIds) ? storeIds : [],
    latitude: null,
    longitude: null,
    gps_accuracy: null,
    nearest_address: null,
    address_status: 'pending',
    map_url: null,
    client_session_id: localId
  };

  writeCurrent({ localId, cloudId: null, row });
  writeChain = Promise.resolve();
  saveCurrentRow();

  // Location first (recent cached fix preferred), then the address in parallel
  // with the countdown so both are ready before the alert is actually sent.
  fixPromise = (async () => {
    const position = await getQuickPosition();
    const hasFix = position && hasUsableCoords(position.latitude, position.longitude);
    const address = hasFix ? await reverseGeocode(position.latitude, position.longitude) : null;
    const patch = {
      latitude: position?.latitude ?? null,
      longitude: position?.longitude ?? null,
      gps_accuracy: Number.isFinite(Number(position?.accuracy)) ? Math.round(Number(position.accuracy)) : null,
      nearest_address: address || null,
      address_status: address ? 'resolved' : 'unavailable',
      map_url: hasFix ? buildMapUrl(position.latitude, position.longitude) : null
    };
    updateCurrentRow(patch);
    return {
      latitude: position?.latitude ?? null,
      longitude: position?.longitude ?? null,
      accuracy: Number.isFinite(Number(position?.accuracy)) ? Number(position.accuracy) : null,
      address: address || null
    };
  })().catch(() => null);

  return localId;
}

/** The GPS fix + nearest address captured for the current incident. */
export async function getIncidentLocation() {
  try {
    if (!fixPromise) return null;
    return await fixPromise;
  } catch {
    return null;
  }
}

/** "123 Main St, Edmonton (53.54111, -113.51122 ±12 m)" for pushes and banners. */
export function buildAlertLocationText(location) {
  if (!location) return '';
  const coords = formatCoords(location.latitude, location.longitude, location.accuracy);
  if (location.address && coords) return `${location.address} (${coords})`;
  return location.address || coords || '';
}

/** The automatic-send countdown was paused by a touch. */
export function markIncidentAutoSendPaused() {
  if (!current?.row || current.row.status !== 'pending_confirmation') return;
  updateCurrentRow({ auto_send_paused: true }, { persist: false });
}

/**
 * The confirmation screen was cancelled. `stage` separates a countdown cancel
 * (nobody was ever notified) from standing down an alert that had already gone
 * out to the other devices.
 */
export function markIncidentCancelled({
  stage = 'confirm_screen',
  reason = null,
  notified = false,
  pushResult = null
} = {}) {
  if (!current?.row) return null;
  const cancelledAt = safeNowIso();
  const patch = {
    status: 'cancelled',
    outcome: 'cancelled',
    cancelled_at: cancelledAt,
    cancellation_stage: stage,
    cancellation_reason: reason || (stage === 'confirm_screen'
      ? 'cancelled on confirmation screen'
      : 'stood down after sending'),
    seconds_to_decision: secondsBetween(current.row.triggered_at, cancelledAt),
    cancellation_notified: !!notified,
    ...(pushResult ? { push_result: pushResult } : {})
  };
  return updateCurrentRow(patch);
}

/** The confirmation screen proceeded: the alert was sent. */
export function markIncidentConfirmed({
  alertId = null,
  notes = null,
  recipientUserIds = [],
  recipientCount = null,
  pushResult = null
} = {}) {
  if (!current?.row) return null;
  const confirmedAt = safeNowIso();
  const patch = {
    alert_id: alertId,
    status: 'sent',
    outcome: 'confirmed',
    confirmed_at: confirmedAt,
    seconds_to_decision: secondsBetween(current.row.triggered_at, confirmedAt),
    ...(notes ? { notes } : {}),
    recipient_user_ids: Array.isArray(recipientUserIds) ? recipientUserIds : [],
    ...(Number.isFinite(Number(recipientCount)) ? { recipient_count: Number(recipientCount) } : {}),
    ...(pushResult ? { push_result: pushResult } : {})
  };
  return updateCurrentRow(patch);
}

/** A sent alert was silenced / handled (no cancellation push goes out). */
export function markIncidentResolved({ resolvedByName = null } = {}) {
  if (!current?.row) return null;
  return updateCurrentRow({
    status: 'resolved',
    outcome: 'resolved',
    resolved_at: safeNowIso(),
    ...(resolvedByName ? { cancellation_reason: `resolved by ${resolvedByName}` } : {})
  });
}

/** Release the current incident so the next trigger starts a fresh row. */
export function clearCurrentIncident() {
  writeCurrent(null);
  fixPromise = null;
}

/**
 * A row left pending from a previous session (app killed during the countdown)
 * is closed out as cancelled instead of sitting forever as "pending".
 */
export function recoverStaleIncident() {
  if (!current?.row) return;
  if (current.row.status !== 'pending_confirmation') return;
  const triggered = new Date(current.row.triggered_at).getTime();
  const stale = !Number.isFinite(triggered) || (Date.now() - triggered) > STALE_PENDING_MS;
  if (!stale) return;
  writeChain = Promise.resolve();
  updateCurrentRow({
    status: 'cancelled',
    outcome: 'cancelled',
    cancellation_stage: 'confirm_screen',
    cancellation_reason: 'app closed before a decision was made'
  });
  clearCurrentIncident();
}

export function getCurrentIncident() {
  return current?.row || null;
}

/** Boot housekeeping: close out a stale row, replay anything queued. */
export function startEmergencyLogHousekeeping() {
  recoverStaleIncident();
  flushEmergencyAlertLog().catch(() => {});
  if (typeof window === 'undefined') return () => {};
  const onOnline = () => { flushEmergencyAlertLog().catch(() => {}); };
  window.addEventListener('online', onOnline);
  const timer = setInterval(() => { flushEmergencyAlertLog().catch(() => {}); }, 60000);
  return () => {
    clearInterval(timer);
    window.removeEventListener('online', onOnline);
  };
}

export default {
  beginEmergencyIncident,
  markIncidentConfirmed,
  markIncidentCancelled,
  markIncidentResolved,
  markIncidentAutoSendPaused,
  getIncidentLocation,
  buildAlertLocationText,
  flushEmergencyAlertLog,
  startEmergencyLogHousekeeping
};
