// ── App version scheme (owner spec, Oct 13 2026) ─────────────────────────
// Format: vMAJOR.APK_UPDATES.WEB_UPDATES   e.g. v1.0.334
//
// MAJOR (first digit) — stays at 1. Bumped to 2 only when the owner
//   explicitly requests it (a deliberate "version 2.0" milestone).
//
// APK_UPDATES (middle digit) — number of APK releases since this scheme
//   started. Derived automatically from the build-apk.yml GitHub Actions
//   run_number: APK_UPDATES = run_number - APK_VERSION_BASELINE. The
//   baseline (334) is the run number in effect when the scheme took over, so
//   the counter starts at 0 today and the next APK release shows 1.
//
// WEB_UPDATES (last digits) — number of web deploys since the scheme
//   started. There is no server-side deploy counter (Base44 deploys via git
//   webhook), so this constant is the source of truth. It starts at 334 and
//   must be bumped by 1 on every push that updates the web app. Never reset.
export const APP_VERSION_MAJOR = 1;
export const APK_VERSION_BASELINE = 334;
export const WEB_VERSION = 334;

/** GitHub Actions run number → APK release count under this scheme (min 0). */
export const apkUpdatesFromRunNumber = (runNumber) => {
  const n = Number(runNumber);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, n - APK_VERSION_BASELINE);
};

/** Format the display version, e.g. formatAppVersion(0) → "v1.0.334". */
export const formatAppVersion = (apkUpdates = 0) => {
  const apk = Math.max(0, Number(apkUpdates) || 0);
  return `v${APP_VERSION_MAJOR}.${apk}.${WEB_VERSION}`;
};
