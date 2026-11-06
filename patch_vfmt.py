p = 'src/version.js'
s = open(p).read()

old = """export const formatAppVersion = (apkUpdates = 0) => {
  const apk = Math.max(0, Number(apkUpdates) || 0);
  return `v${APP_VERSION_MAJOR}.${apk}.${WEB_VERSION}`;
};"""
new = """export const formatAppVersion = (apkUpdates = 0) => {
  const apk = Math.max(0, Number(apkUpdates) || 0);
  return `v${APP_VERSION_MAJOR}.${apk}.${formatWebDigit(WEB_VERSION)}`;
};

/**
 * WEB digit is ALWAYS three digits (owner spec Nov 6 2026: "keep the web version
 * always 3 digits") so 0 reads 000 and 212 reads 212 — the version stops
 * looking like a different number after every APK reset.
 */
export function formatWebDigit(web = 0) {
  const n = Math.max(0, Math.floor(Number(web) || 0));
  return String(n).padStart(3, '0');
}

/** v2.[APK].[WEB] with the 3-digit web tail, for any digit pair. */
export function formatVersionDigits(apkDigit = 0, webDigit = 0) {
  const apk = Math.max(0, Math.floor(Number(apkDigit) || 0));
  return `v${APP_VERSION_MAJOR}.${apk}.${formatWebDigit(webDigit)}`;
}"""
assert old in s
s = s.replace(old, new, 1)
open(p, 'w').write(s)

# Layout: build the live label with the shared 3-digit formatter, no "live" word
p = 'src/Layout.jsx'
s = open(p).read()
old = """  const liveVersionLabel = isOwnerDevice && publishedVersionInfo
    ? `live v${APP_VERSION_MAJOR}.${_liveApkDigit}.${publishedVersionInfo.webVersion}`
    : null;"""
new = """  // (v2.[APK].[WEB]) — live site's own digits, 3-digit web tail. Rendered on
  // its OWN row under the preview version for the owner (owner spec Nov 6 2026).
  const liveVersionLabel = isOwnerDevice && publishedVersionInfo
    ? formatVersionDigits(_liveApkDigit, publishedVersionInfo.webVersion)
    : null;"""
assert old in s
s = s.replace(old, new, 1)
s = s.replace(
    "import { formatAppVersion, apkUpdatesFromSuccessCount, APP_VERSION_MAJOR } from './version';",
    "import { formatAppVersion, formatVersionDigits, apkUpdatesFromSuccessCount, APP_VERSION_MAJOR } from './version';",
    1)
open(p, 'w').write(s)
print('formatters + live label updated')
