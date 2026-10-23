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
// WEB_UPDATES (last digits) — number of web deploys since the LAST APK
//   update (owner rule, Oct 21 2026). There is no server-side deploy counter
//   (Base44 deploys via git webhook), so this constant is the source of
//   truth: bump by 1 on every push that updates the web app. The
//   build-apk.yml workflow RESETS this to 0 after each successful APK build
//   (the new APK is the fresh baseline; it also bakes web digit 0 into its
//   label), so the counter rotates back to 0 on every APK update and counts
//   up from there.
export const APP_VERSION_MAJOR = 1;
export const APK_SUCCESS_BASELINE = 316;


export const WEB_VERSION = 55;


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
