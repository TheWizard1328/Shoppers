import { base44 } from '@/api/base44Client';
import { getDeviceIdentifier } from '@/components/utils/userSettingsManager';
import { getUserAgentInfo } from '@/components/utils/deviceUtils';

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

const loadSettings = async () => {
  if (activeSettings) return activeSettings;
  if (!settingsPromise) {
    settingsPromise = base44.entities.RemoteLoggingSettings.filter({ scope: 'global' }, '-updated_date', 1)
      .then((rows) => {
        activeSettings = rows?.[0] || null;
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
  } finally {
    isFlushing = false;
  }
};

const scheduleFlush = (interval) => {
  if (flushTimer) clearInterval(flushTimer);
  flushTimer = setInterval(() => {
    flushNow().catch(() => {});
  }, interval);
};

const enqueue = async (level, args) => {
  if (suppressConsoleCapture) return;
  const settings = activeSettings || await loadSettings();
  if (!settings?.enabled) return;
  const levels = Array.isArray(settings?.capture_levels) && settings.capture_levels.length > 0 ? settings.capture_levels : ['log', 'info', 'warn', 'error', 'debug'];
  if (!levels.includes(level)) return;

  const me = await getMe();
  const { deviceType, os } = getUserAgentInfo();
  const current = readBuffer();
  current.push({
    level,
    message: args.map(stringifyArg).join(' ').slice(0, 5000),
    timestamp: new Date().toISOString(),
    user_id: me?.id || null,
    user_name: me?.full_name || null,
    device_identifier: getDeviceIdentifier(),
    device_type: deviceType,
    os,
    page: window.location.pathname,
    session_id: getSessionId(),
    metadata: {}
  });
  writeBuffer(current);

  if (level === 'error' || level === 'warn' || current.length >= (Number(settings?.batch_size) || 20)) {
    flushNow().catch(() => {});
  }
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