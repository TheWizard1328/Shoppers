import { base44 } from '@/api/base44Client';
import { getDeviceIdentifier } from '@/components/utils/userSettingsManager';
import { getUserAgentInfo } from '@/components/utils/deviceUtils';
import { getCurrentDevice } from '@/components/utils/deviceManager';
import { getRemoteLoggingSettings } from '@/components/utils/configCache';

const STORAGE_KEY = 'rxdeliver_remote_log_buffer';
const SESSION_KEY = 'rxdeliver_remote_log_session_id';
const SETTINGS_STORAGE_KEY = 'rxdeliver_remote_log_settings';
const MAX_BUFFER = 200;

let initialized = false;
let flushTimer = null;
let activeSettings = null;
let settingsPromise = null;
let mePromise = null;
let isFlushing = false;
let suppressConsoleCapture = false;

// ── 429 WRITE-COOLDOWN (owner spec Oct 15 2026) ───────────────────────────
// When the app hits the account-wide entity-write limit, every RemoteLogEntry
// bulkCreate also 429s. Without a cooldown the flush timer retries the same
// batch every 15s — competing for the very pool that's exhausted. Parse the
// server's "Retry after N seconds" and pause ALL remote log writes until it
// passes. Logs stay in the local buffer (localStorage) during cooldown and
// flush once it lifts. Cap consecutive failures so a permanently-stuck batch
// is eventually dropped rather than blocking the queue forever.
let writeCooldownUntil = 0;
let consecutiveWriteFailures = 0;
const MAX_CONSECUTIVE_FAILURES = 5;

const is429Error = (err) => {
  if (!err) return false;
  const msg = String(err?.message || err?.detail || err);
  return /\b429\b|traffic volume limit exceeded|rate limit exceeded/i.test(msg);
};

const parseRetryAfterSeconds = (err) => {
  const detail = String(err?.detail || '');
  const msg = String(err?.message || '');
  const m = (detail || msg).match(/retry after (\d+)\s*seconds?/i);
  if (m) return Math.max(2, Number(m[1]) + 2); // small buffer past the server's ask
  return 25; // safe default if the server didn't specify
};
let lastLogFingerprint = null;
let lastLogTimestamp = 0;

const getSessionId = () => {
  const existing = sessionStorage.getItem(SESSION_KEY);
  if (existing) return existing;
  const created = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  sessionStorage.setItem(SESSION_KEY, created);
  return created;
};

const readBuffer = () => {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  } catch {
    return [];
  }
};

const writeBuffer = (items) => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(items.slice(-MAX_BUFFER)));
};

const stringifyArg = (arg) => {
  if (typeof arg === 'string') return arg;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
};

// ── FINGERPRINT RATE LIMITER ──────────────────────────────────────────────
// The back-to-back dedup above only catches identical lines printed
// consecutively. Render-loop spam (e.g. AdminUtilities logging 4 lines per
// re-render of a 20k-deliveries table) alternates between different messages,
// so each slips through the dedup — that spam grew RemoteLogEntry to 500k+
// rows and made sorted queries time out. Cap each unique message at 5
// occurrences per 60s window per device.
const REMOTE_LOG_CAPTURE_BLACKLIST = [
  /\[BackgroundSync\] .+ already synced/,   // 365-day backfill: 1 line/date/device
  /\[HistoricalSync\] .+ already synced/,  // same walk, different manager
];

// ── RATE-LIMIT NOISE SUPPRESSION (owner spec Oct 14 2026) ──────────────────
// Every 429 used to ship to RemoteLogEntry as 2+ log writes per device per
// error (SDK error line + Error data line) — and log writes are API calls
// competing for the very account-wide pool that is exhausted. A storm on any
// device multiplied itself across every logging device. Rate-limit lines now
// stay in the LOCAL console (UI flag + Issue Balloon + RequestQueue all still
// see them) and ship remotely at most ONCE per 5 minutes per device, enough
// for the App Issue Monitor + Issue Balloon to see a real storm without
// feeding it. One-shot per device (not per message): a burst of mixed 429
// variants still counts as the same noise event.
const RATE_LIMIT_NOISE_RX = /rate limit exceeded|traffic volume limit exceeded|\b429\b|\[RequestQueue\] Rate-limited|\[UserSettings\] Rate limited|server compute unavailable|publish failed/i;
let lastRateLimitNoiseSentAt = 0;
const RATE_LIMIT_NOISE_MIN_INTERVAL_MS = 5 * 60 * 1000;

// GPS / diagnostic traffic noise (owner spec Oct 14 2026): per-tick [LOC] log
// lines embed FRESH COORDINATES and per-check deviation lines embed changing
// distances — unique text defeats the fingerprint dedup (5/60s per EXACT
// message), so every one shipped as its own RemoteLogEntry API write. Driver
// phones were burning several API writes/min on success chatter alone
// ([LOC] UPLOAD-SUCCESS rides every 15s GPS tick; [RouteDeviation] ok/gate
// lines ride every 10s deviation check; breadcrumb jump/gap warns ride every
// GPS outage). These stay LOCAL (console/sniffer unchanged) and ship remotely
// at most once per 5 min per device (storm heartbeat). REAL events are NOT
// matched and still ship immediately: [LOC] UPLOAD-FAILED,
// [RouteDeviation] regen / regen_failed / regen failed / regen lock / current-leg
// regen lines.
const GPS_NOISE_RX = /\[LOC\] UPLOAD-SUCCESS|\[LOC\] DISPATCHER-HEARTBEAT|\[LOC\] SKIP-NON-PRIMARY|\[RouteDeviation\] (ok |gate:)|\[Breadcrumbs\] Large GPS jump|\[Breadcrumb Gap\]/;
let lastGpsNoiseSentAt = 0;
const GPS_NOISE_MIN_INTERVAL_MS = 5 * 60 * 1000;

// Native plugin noise (owner rule, Oct 16 2026): raw JSON plugin errors with no
// console prefix surface from the Android shell on every boot/reload cycle —
// ALREADY_STARTED (foreground service still running during a deploy-triggered
// reload) and FOREGROUND_SERVICE_START_NOT_ALLOWED (app backgrounded, GPS
// intentionally suspended, the breadcrumb timer retries each tick). Both are
// benign-by-design; they were flooding the App Issue Monitor's error counter
// and firing owner alerts on every deploy day. Keep locally, ship at most one
// per 5 min per device.
const NATIVE_PLUGIN_NOISE_RX = /"code":"ALREADY_STARTED"|"code":"FOREGROUND_SERVICE_START_NOT_ALLOWED"|"Service already started"|Cannot start background location while the app is in the background/;
let lastNativeNoiseSentAt = 0;
const NATIVE_NOISE_MIN_INTERVAL_MS = 5 * 60 * 1000;

const fingerprintWindow = new Map(); // fingerprint -> { windowStart, count }
const FINGERPRINT_MAX_PER_WINDOW = 5;
const FINGERPRINT_WINDOW_MS = 60000;
const FINGERPRINT_MAP_MAX = 500;

const shouldSkipDuplicateLog = (level, message) => {
  const fingerprint = `${level}:${message}`;
  const now = Date.now();
  if (lastLogFingerprint === fingerprint && now - lastLogTimestamp < 5000) {
    return true;
  }
  lastLogFingerprint = fingerprint;
  lastLogTimestamp = now;

  const entry = fingerprintWindow.get(fingerprint);
  if (!entry || now - entry.windowStart >= FINGERPRINT_WINDOW_MS) {
    if (fingerprintWindow.size >= FINGERPRINT_MAP_MAX) fingerprintWindow.clear();
    fingerprintWindow.set(fingerprint, { windowStart: now, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > FINGERPRINT_MAX_PER_WINDOW;
};

// TTL for the in-memory settings cache. Without this, a device that booted
// while logging was disabled (or before an included-user change) keeps its
// stale snapshot forever — the admin toggle never reaches running sessions.
const SETTINGS_TTL_MS = 5 * 60 * 1000;
let settingsCheckedAt = 0;

const loadSettings = async (force = false) => {
  if (window.__remoteLogSettingsCache) {
    activeSettings = window.__remoteLogSettingsCache;
    window.__remoteLogSettingsCache = null;
    settingsCheckedAt = Date.now();
  }
  if (!force && activeSettings) return activeSettings;
  if (!settingsPromise) {
    settingsPromise = getRemoteLoggingSettings(force)
      .then((settings) => {
        activeSettings = settings;
        settingsCheckedAt = Date.now();
        try { if (settings) localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings)); } catch {}
        return activeSettings;
      })
      .catch((error) => {
        try {
          const cached = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) || 'null');
          if (cached) {
            activeSettings = cached;
            settingsCheckedAt = Date.now();
            return cached;
          }
        } catch {}
        throw error;
      })
      .finally(() => {
        settingsPromise = null;
      });
  }
  return settingsPromise;
};

const getMe = async () => {
  if (!mePromise) {
    mePromise = base44.auth.me().catch(() => null);
  }
  return mePromise;
};

const shouldCapture = async () => {
  const settings = activeSettings || await loadSettings();
  if (!settings?.enabled) return false;
  const me = await getMe();
  const userId = me?.id || null;
  const included = Array.isArray(settings.included_user_ids) ? settings.included_user_ids : [];
  const excluded = Array.isArray(settings.excluded_user_ids) ? settings.excluded_user_ids : [];
  if (excluded.includes(userId)) return false;
  if (included.length > 0 && !included.includes(userId)) return false;
  return true;
};

// ── 24-HOUR RETENTION TRIM ────────────────────────────────────────────────
// Auto-purges RemoteLogEntry rows older than 24h via the clearRemoteLogs
// backend function (trim mode). Fired at most once per hour from the flush
// cycle of any actively-logging device, so retention is enforced without a
// scheduler. Fire-and-forget — failures never block log flushes.
const LOG_RETENTION_HOURS = 24;
const TRIM_INTERVAL_MS = 60 * 60 * 1000;
let lastTrimAt = 0;

const maybeTrimOldLogs = () => {
  const now = Date.now();
  if (now - lastTrimAt < TRIM_INTERVAL_MS) return;
  lastTrimAt = now;
  try {
    base44.functions.invoke('clearRemoteLogs', { retention_hours: LOG_RETENTION_HOURS }).catch(() => {});
  } catch (_) {}
};

const flushNow = async () => {
  if (isFlushing) return;
  // Skip remote writes entirely while in a 429 cooldown — logs stay in the
  // local buffer (localStorage) and flush once the cooldown lifts.
  if (Date.now() < writeCooldownUntil) return;
  isFlushing = true;
  try {
    const canCapture = await shouldCapture();
    if (!canCapture) return;
    const buffer = readBuffer();
    if (buffer.length === 0) return;

    const settings = activeSettings || await loadSettings();
    const batchSize = Math.max(1, Math.min(Number(settings?.batch_size) || 20, 100));
    const nextBatch = buffer.slice(0, batchSize);
    const remaining = buffer.slice(batchSize);

    try {
      await base44.entities.RemoteLogEntry.bulkCreate(nextBatch);
      consecutiveWriteFailures = 0;
      writeBuffer(remaining);
      maybeTrimOldLogs();
    } catch (err) {
      if (is429Error(err)) {
        // Account-wide write limit hit: pause all remote log writes for the
        // server's "Retry after" window (+ buffer). Keep the batch in the
        // buffer so it ships once the cooldown lifts.
        const waitMs = parseRetryAfterSeconds(err) * 1000;
        writeCooldownUntil = Date.now() + waitMs;
        consecutiveWriteFailures += 1;
        // If the same batch keeps failing across cooldowns, drop it so the
        // queue doesn't block forever behind a toxic payload.
        if (consecutiveWriteFailures >= MAX_CONSECUTIVE_FAILURES) {
          writeBuffer(remaining);
          consecutiveWriteFailures = 0;
        }
        // Suppress the console.error here so the logger's own 429 doesn't
        // re-enqueue itself into the buffer (noise filter already throttles
        // it, but this avoids the enqueue round-trip entirely).
        suppressConsoleCapture = true;
        console.warn('[remoteLogger] RemoteLogEntry write paused — account write-limit hit, retrying in', Math.round(waitMs / 1000) + 's');
        suppressConsoleCapture = false;
      } else {
        // Non-429 error: drop this batch (don't let a malformed record block
        // the flush timer forever) but keep logging new entries.
        writeBuffer(remaining);
      }
    }
  } finally {
    isFlushing = false;
  }
};

const scheduleFlush = (interval) => {
  if (flushTimer) clearInterval(flushTimer);
  flushTimer = setInterval(() => {
    // Periodically re-fetch settings so admin toggles/user-list changes
    // propagate to devices that have been running for a long time.
    if (Date.now() - settingsCheckedAt > SETTINGS_TTL_MS) {
      loadSettings(true).catch(() => {});
    }
    flushNow().catch(() => {});
  }, interval);
};

const enqueue = async (level, args, extra = {}) => {
  if (suppressConsoleCapture) return;
  const settings = activeSettings || await loadSettings();
  if (!settings?.enabled) return;
  const levels = Array.isArray(settings?.capture_levels) && settings.capture_levels.length > 0 ? settings.capture_levels : ['log', 'info', 'warn', 'error', 'debug'];
  if (!levels.includes(level)) return;

  const message = args.map(stringifyArg).join(' ').slice(0, 5000);
  // Capture blacklist — repetitive walk/scan messages that vary per iteration
  // (dates, stores) defeat fingerprint dedup and previously grew RemoteLogEntry
  // to 200k+ rows/day. Source-side aggregation is the primary fix; this stops
  // any stragglers from legacy cached bundles still emitting them.
  for (const rx of REMOTE_LOG_CAPTURE_BLACKLIST) {
    if (rx.test(message)) return;
  }
  if (RATE_LIMIT_NOISE_RX.test(message)) {
    const _noiseNow = Date.now();
    if (_noiseNow - lastRateLimitNoiseSentAt < RATE_LIMIT_NOISE_MIN_INTERVAL_MS) return;
    lastRateLimitNoiseSentAt = _noiseNow; // this one ships as the device's storm heartbeat
  }
  if (GPS_NOISE_RX.test(message)) {
    const _gpsNoiseNow = Date.now();
    if (_gpsNoiseNow - lastGpsNoiseSentAt < GPS_NOISE_MIN_INTERVAL_MS) return;
    lastGpsNoiseSentAt = _gpsNoiseNow; // this one ships as the device's traffic heartbeat
  }
  if (NATIVE_PLUGIN_NOISE_RX.test(message)) {
    const _natNoiseNow = Date.now();
    if (_natNoiseNow - lastNativeNoiseSentAt < NATIVE_NOISE_MIN_INTERVAL_MS) return;
    lastNativeNoiseSentAt = _natNoiseNow; // deploy/reload noise heartbeat only
  }
  if (shouldSkipDuplicateLog(level, message)) return;

  const me = await getMe();
  const { deviceType, os } = getUserAgentInfo();
  const currentDevice = me?.id ? await getCurrentDevice(me.id).catch(() => null) : null;
  const current = readBuffer();
  current.push({
    level,
    message,
    ...(extra.eventType ? { event_type: extra.eventType } : {}),
    timestamp: new Date().toISOString(),
    user_id: me?.id || null,
    user_name: me?.full_name || null,
    device_identifier: getDeviceIdentifier(),
    device_type: currentDevice?.device_info?.device_type || deviceType,
    os: currentDevice?.device_info?.os || os,
    page: window.location.pathname,
    session_id: getSessionId(),
    metadata: {
      device_name: currentDevice?.device_name || null,
      device_os: currentDevice?.device_info?.os || os || null,
      device_type: currentDevice?.device_info?.device_type || deviceType || null,
      ...(extra.metadata || {})
    }
  });
  writeBuffer(current);

  if (current.length >= (Number(settings?.batch_size) || 20)) {
    flushNow().catch(() => {});
  }
};

export const remoteLogger = {
  log: (...args) => enqueue('log', args),
  info: (...args) => enqueue('info', args),
  warn: (...args) => enqueue('warn', args),
  error: (...args) => enqueue('error', args),
  debug: (...args) => enqueue('debug', args),
  event: (eventType, message, metadata = {}, level = 'warn') =>
    enqueue(level, [`[DEVICE_HEALTH] ${eventType} | ${message}`], { eventType, metadata })
};

export const initRemoteLogger = async () => {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;

  const settings = await loadSettings();
  scheduleFlush(Number(settings?.flush_interval_ms) || 15000);

  const original = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console)
  };

  ['log', 'info', 'warn', 'error', 'debug'].forEach((level) => {
    console[level] = (...args) => {
      if (!suppressConsoleCapture) {
        enqueue(level, args).catch(() => {});
      }
      original[level](...args);
    };
  });

  window.addEventListener('beforeunload', () => {
    flushNow().catch(() => {});
  });
};