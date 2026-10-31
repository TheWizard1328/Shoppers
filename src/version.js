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
// ── MAJOR = which domain the device is running on (owner spec, Oct 30 2026) ──
// The version's first digit now identifies the DOMAIN RELEASE, not a feature
// milestone:
//   v1.x.x — any device still being served from the OLD domain. Unchanged,
//            keeps counting exactly as before.
//   v2.x.x — the NEW domain (any host on or under wizardworxx.com) from the
//            Nov 1 2026 changeover, INCLUDING the preview/sandbox path.
// Derivation is at runtime from window.location.hostname, so nothing has to be
// re-baked per domain and a device cannot claim a release it is not running:
//   • rxdeliver.wizardworxx.com           → 2 (live new domain)
//   • preview--…base44.app, *preview*/*sandbox* → 2 (owner: "the preview path
//     is included in this version 2")
//   • wizardworxx.com / www.wizardworxx.com → 1 (old domain, unchanged)
//   • anything else (legacy hosts, localhost) → 1
// The native APK loads https://rxdeliver.wizardworxx.com in its WebView
// (capacitor/capacitor.config.json server.url), so installed apps report
// hostname rxdeliver.wizardworxx.com and show v2 automatically.
export const NEW_DOMAIN_SUFFIX = 'wizardworxx.com';
export const APP_VERSION_MAJOR_NEW_DOMAIN = 2;
export const APP_VERSION_MAJOR_LEGACY = 1;

/** Resolve the MAJOR digit for a hostname (pure — exported for tests). */
export const resolveAppMajorVersion = (host) => {
  let h = String(host || '').trim().toLowerCase();
  if (!h && typeof window !== 'undefined') h = String(window.location?.hostname || '').toLowerCase();
  if (!h) return APP_VERSION_MAJOR_LEGACY;
  // Strip a trailing :port if one is present (localhost:5173 style hosts).
  h = h.replace(/:\d+$/, '');
  // Preview / sandbox deployments count as release 2 (owner directive).
  if (h.includes('preview') || h.includes('sandbox')) return APP_VERSION_MAJOR_NEW_DOMAIN;
  // OLD domain hosts: the bare apex and www still serve RxDeliver (see
  // DomainMigrationNotice OLD_HOSTS) — those stay on release 1.
  if (h === NEW_DOMAIN_SUFFIX || h === `www.${NEW_DOMAIN_SUFFIX}`) return APP_VERSION_MAJOR_LEGACY;
  // New domain: any APP SUBDOMAIN under it (rxdeliver.wizardworxx.com, …).
  if (h.endsWith(`.${NEW_DOMAIN_SUFFIX}`)) return APP_VERSION_MAJOR_NEW_DOMAIN;
  return APP_VERSION_MAJOR_LEGACY;
};

export const APP_VERSION_MAJOR = resolveAppMajorVersion();

export const APK_SUCCESS_BASELINE = 316;


export const WEB_VERSION = 38;


/** Successful build-apk.yml run count → APK release count under this scheme. */
export const apkUpdatesFromSuccessCount = (successCount) => {
  const n = Number(successCount);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, n - APK_SUCCESS_BASELINE);
};

/** Format the display version, e.g. formatAppVersion(0) → "v1.0.335" (old domain)
 *  or "v2.0.17" on the new domain / preview. */
export const formatAppVersion = (apkUpdates = 0) => {
  const apk = Math.max(0, Number(apkUpdates) || 0);
  return `v${APP_VERSION_MAJOR}.${apk}.${WEB_VERSION}`;
};
