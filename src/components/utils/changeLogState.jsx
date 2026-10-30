// ── Change-log / builds-ahead state (owner request Oct 30 2026) ──────────────
//
// Two numbers live on the shared AppSettings 'change_log_state' record so the
// owner sees the same value on every device:
//
//   baselineBuild  — the BUILD_NUMBER that was LIVE at the last detected publish.
//                    buildsAhead = BUILD_NUMBER - baselineBuild.
//   lastSeenBuild  — the highest build the owner has already been shown in the
//                    version-update dialog, so the dialog appears once per
//                    publish rather than on every reload.
//
// PUBLISH DETECTION (owner spec): "only after a new publish has been done where
// the live version number and the preview version numbers match." A push lands
// on the PREVIEW deployment first; the live domain only starts serving that
// bundle once the owner publishes. So an owner device running on the LIVE
// domain (getEnvironmentLabel() !== '(Prev)') that sees BUILD_NUMBER ahead of
// baselineBuild has just had that build published → stamp the baseline, then
// show the summary for the very builds that publish carried.
//
// Written ONLY by the owner's live device; everyone else reads. Failures are
// non-fatal: the counter falls back to the localStorage mirror.

import { BUILD_NUMBER } from '@/changeLog';

export const CHANGE_LOG_STATE_KEY = 'change_log_state';
const LS_MIRROR = 'rxdeliver_change_log_state';

const readMirror = () => {
  try {
    const raw = localStorage.getItem(LS_MIRROR);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
};

const writeMirror = (state) => {
  try {
    localStorage.setItem(LS_MIRROR, JSON.stringify(state));
  } catch (_) { /* private mode / quota — ignore */ }
};

/** Synchronous best-effort read for first paint (localStorage mirror). */
export const getChangeLogStateSync = () => {
  const mirror = readMirror() || {};
  return {
    baselineBuild: Number(mirror.baselineBuild) || 0,
    lastSeenBuild: Number(mirror.lastSeenBuild) || 0,
  };
};

/** Authoritative read (memory/IDB cache first, then the server). */
export const loadChangeLogState = async () => {
  try {
    const { getAppSettingRows } = await import('@/components/utils/appSettingsCache');
    const rows = await getAppSettingRows(CHANGE_LOG_STATE_KEY);
    const value = rows?.[0]?.setting_value;
    if (value && typeof value === 'object') {
      const state = {
        baselineBuild: Number(value.baselineBuild) || 0,
        lastSeenBuild: Number(value.lastSeenBuild) || 0,
      };
      writeMirror(state);
      return state;
    }
  } catch (_) { /* offline — the mirror is what we have */ }
  return getChangeLogStateSync();
};

/** Persist both numbers (owner device only). Best effort, never throws. */
export const saveChangeLogState = async ({ baselineBuild, lastSeenBuild }) => {
  const state = {
    baselineBuild: Number(baselineBuild) || 0,
    lastSeenBuild: Number(lastSeenBuild) || 0,
  };
  writeMirror(state);
  try {
    const { base44 } = await import('@/api/base44Client');
    // Fresh read: a stale cached row would clobber the other number.
    const { getFreshAppSettingRows } = await import('@/components/utils/appSettingsCache');
    const rows = await getFreshAppSettingRows(CHANGE_LOG_STATE_KEY);
    if (rows?.[0]?.id) {
      await base44.entities.AppSettings.update(rows[0].id, { setting_value: state });
    } else {
      await base44.entities.AppSettings.create({
        setting_key: CHANGE_LOG_STATE_KEY,
        setting_value: state,
        description: 'Change log baseline + last seen build (owner builds-ahead counter)',
      });
    }
  } catch (err) {
    console.warn('[changeLog] state save failed (local mirror kept):', err?.message || err);
  }
  return state;
};

/**
 * Called by an owner device once it is running on the LIVE domain.
 * If this build is ahead of the published baseline, that means a publish just
 * happened: stamp the baseline and return the entries the owner has not seen.
 *
 * @returns {Promise<{stamped: boolean, entries: Array, baselineBuild: number}>}
 */
export const detectPublishAndCollect = async (entriesSince) => {
  const state = await loadChangeLogState();
  const ahead = BUILD_NUMBER > state.baselineBuild;
  if (!ahead) {
    return { stamped: false, entries: [], baselineBuild: state.baselineBuild };
  }
  const from = Math.max(state.lastSeenBuild, state.baselineBuild);
  const entries = entriesSince(from);
  await saveChangeLogState({ baselineBuild: BUILD_NUMBER, lastSeenBuild: BUILD_NUMBER });
  return { stamped: true, entries, baselineBuild: BUILD_NUMBER };
};
