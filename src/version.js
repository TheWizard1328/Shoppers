// ── App version scheme (owner spec, Oct 13 2026) ─────────────────────────
// Format: vMAJOR.APK_UPDATES.WEB_UPDATES   e.g. v1.0.334
//
// MAJOR (first digit) — stays at 1. Bumped to 2 only when the owner
//   explicitly requests it (a deliberate "version 2.0" milestone).
//
// APK_UPDATES (middle digit) — number of APK releases since this scheme
//   started. Counted from SUCCESSFUL build-apk.yml workflow runs only:
//   APK_UPDATES = (successful run count) - APK_SUCCESS_BASELINE. The
//   baseline (316) is the successful-run count when the scheme took effect,
//   so the counter starts at 0 today and the next successful APK build
//   shows 1. Failed/cancelled runs never increment it (there were 7 failed
//   runs 335-341 before this, and a raw run_number baseline would have
//   wrongly jumped straight to 7).
//
// WEB_UPDATES (last digits) — number of web deploys since the scheme
//   started. There is no server-side deploy counter (Base44 deploys via git
//   webhook), so this constant is the source of truth. It starts at 334 and
//   must be bumped by 1 on every push that updates the web app. Never reset.
export const APP_VERSION_MAJOR = 1;
export const APK_SUCCESS_BASELINE = 316;
export const WEB_VERSION = 371;

/** Successful build-apk.yml run count → APK release count under this scheme. */
export const apkUpdatesFromSuccessCount = (successCount) => {
  const n = Number(successCount);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, n - APK_SUCCESS_BASELINE);
};

/** Format the display version, e.g. formatAppVersion(0) → "v1.0.335". */
export const formatAppVersion = (apkUpdates = 0) => {
  const apk = Math.max(0, Number(apkUpdates) || 0);
  return `v${APP_VERSION_MAJOR}.${apk}.${WEB_VERSION}`;
};
