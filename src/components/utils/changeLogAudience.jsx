/**
 * changeLogAudience — owner-editable audience overrides for the update log.
 *
 * OWNER REQUEST (Oct 31 2026): "add a group of clickable badges for each item,
 * Owner / Drivers / Dispatchers / Admins so I can correct who sees these update
 * logs." The shipped audiences live in src/changeLog.jsx, so a correction made
 * on a phone would be lost on the next build. Overrides are stored on the
 * shared AppSettings record `change_log_audience` instead, keyed by
 * `<build>|<area>`, and applied over the code default wherever the log is shown.
 *
 * Shape: { "44|App": "owner", "30|Payroll": "admins" }
 */
import { base44 } from '@/api/base44Client';
import { getAppSettingRows, getFreshAppSettingRows } from '@/components/utils/appSettingsCache';

export const CHANGE_LOG_AUDIENCE_KEY = 'change_log_audience';
const LS_MIRROR = 'rxdeliver_change_log_audience';

export const entryAudienceKey = (entry) => `${entry?.build}|${entry?.area || ''}`;

const readMirror = () => {
  try {
    const raw = localStorage.getItem(LS_MIRROR);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
};

const writeMirror = (overrides) => {
  try { localStorage.setItem(LS_MIRROR, JSON.stringify(overrides || {})); } catch { /* ignore */ }
};

/** Synchronous best-effort read for first paint. */
export const getAudienceOverridesSync = () => readMirror();

/** Authoritative read (cache first, then the server). */
export async function loadAudienceOverrides() {
  try {
    const rows = await getAppSettingRows(CHANGE_LOG_AUDIENCE_KEY);
    const value = rows?.[0]?.setting_value;
    if (value && typeof value === 'object') {
      const overrides = value.overrides && typeof value.overrides === 'object' ? value.overrides : value;
      writeMirror(overrides);
      return overrides;
    }
  } catch { /* offline — mirror is what we have */ }
  return readMirror();
}

/** Persist the whole override map (owner only). Never throws. */
export async function saveAudienceOverrides(overrides) {
  writeMirror(overrides);
  try {
    const rows = await getFreshAppSettingRows(CHANGE_LOG_AUDIENCE_KEY);
    const setting_value = { overrides };
    if (rows?.[0]?.id) {
      await base44.entities.AppSettings.update(rows[0].id, { setting_value });
    } else {
      await base44.entities.AppSettings.create({
        setting_key: CHANGE_LOG_AUDIENCE_KEY,
        setting_value,
        description: 'Owner overrides for who each update-log entry is for',
      });
    }
  } catch (err) {
    console.warn('[changeLogAudience] save failed (local mirror kept):', err?.message || err);
  }
  return overrides;
}

/** Apply overrides over the shipped audiences. */
export const applyAudienceOverrides = (entries = [], overrides = {}) => entries.map((entry) => {
  const override = overrides[entryAudienceKey(entry)];
  return override ? { ...entry, audience: override, audience_overridden: true } : entry;
});

/** Set (or clear, with audience=null) one entry's audience. */
export async function setEntryAudience(overrides, entry, audience) {
  const next = { ...(overrides || {}) };
  const key = entryAudienceKey(entry);
  if (!audience || audience === entry?.audience) delete next[key];
  else next[key] = audience;
  return saveAudienceOverrides(next);
}
