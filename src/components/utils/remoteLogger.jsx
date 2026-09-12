import { base44 } from '@/api/base44Client';
import { getDeviceIdentifier } from '@/components/utils/userSettingsManager';
import { getUserAgentInfo } from '@/components/utils/deviceUtils';
import { getCurrentDevice } from '@/components/utils/deviceManager';
import { getRemoteLoggingSettings } from '@/components/utils/configCache';

const STORAGE_KEY = 'rxdeliver_remote_log_buffer';
const SESSION_KEY = 'rxdeliver_remote_log_session_id';
const MAX_BUFFER = 200;

let initialized = false;
let flushTimer = null;
let activeSettings = null;
let settingsPromise = null;
let mePromise = null;
let isFlushing = false;
let suppressConsoleCapture = false;
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
        return activeSettings;
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

    await base44.entities.RemoteLogEntry.bulkCreate(nextBatch);
    writeBuffer(remaining);

    // Retention: keep only the last 24h of logs (hourly fire-and-forget trim)
    maybeTrimOldLogs();
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

const enqueue = async (level, args) => {
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
  if (shouldSkipDuplicateLog(level, message)) return;

  const me = await getMe();
  const { deviceType, os } = getUserAgentInfo();
  const currentDevice = me?.id ? await getCurrentDevice(me.id).catch(() => null) : null;
  const current = readBuffer();
  current.push({
    level,
    message,
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
      device_type: currentDevice?.device_info?.device_type || deviceType || null
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
  debug: (...args) => enqueue('debug', args)
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