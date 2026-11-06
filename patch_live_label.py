import re

# A) publishedBuildInfo: accept a live bundle whose version.json predates apkDigit
p = 'src/components/utils/publishedBuildInfo.jsx'
s = open(p).read()

s = s.replace("""    if (!Number.isFinite(apkDigit) || apkDigit <= 0) return null;
    return { apkDigit, webVersion: Number(c?.webVersion) || 0 };""",
"""    // A live bundle published BEFORE apkDigit existed still has a web digit —
    // report the digits we do know (apkDigit 0 = unknown) instead of nothing.
    const web = Number(c?.webVersion);
    if (!Number.isFinite(apkDigit) && !Number.isFinite(web)) return null;
    if ((!Number.isFinite(apkDigit) || apkDigit <= 0) && !(Number.isFinite(web) && web > 0)) return null;
    return { apkDigit: Number.isFinite(apkDigit) && apkDigit > 0 ? apkDigit : 0, webVersion: Number.isFinite(web) ? web : 0 };""", 1)

s = s.replace("""    const apkDigit = Number(data?.apkDigit);
    if (!Number.isFinite(apkDigit) || apkDigit <= 0) return readDigits();""",
"""    const apkDigit = Number(data?.apkDigit);
    const webVersion = Number(data?.webVersion);
    if (!Number.isFinite(apkDigit) || apkDigit <= 0) {
      // Older live publish (no baked APK digit yet): still surface its WEB digit
      // so the owner can see the live number before the next publish.
      if (Number.isFinite(webVersion) && webVersion > 0) {
        return { apkDigit: 0, webVersion };
      }
      return readDigits();
    }""", 1)

s = s.replace("""      webVersion: Number(data?.webVersion) || 0,
      apkDigit,""", """      webVersion: Number(data?.webVersion) || 0,
      apkDigit,""", 1)

s = s.replace("""    return { apkDigit, webVersion: Number(data?.webVersion) || 0 };""",
"""    return { apkDigit, webVersion: Number.isFinite(webVersion) ? webVersion : 0 };""", 1)

# initial state must accept the web-only shape too
s = s.replace("""    const apkDigit = Number(c?.apkDigit);
    return Number.isFinite(apkDigit) && apkDigit > 0 ? { apkDigit, webVersion: Number(c?.webVersion) || 0 } : null;""",
"""    const apkDigit = Number(c?.apkDigit);
    const web = Number(c?.webVersion);
    const hasApk = Number.isFinite(apkDigit) && apkDigit > 0;
    if (!hasApk && !(Number.isFinite(web) && web > 0)) return null;
    return { apkDigit: hasApk ? apkDigit : 0, webVersion: Number.isFinite(web) ? web : 0 };""", 1)

open(p, 'w').write(s)

# B) Layout: fall back to the newest release's APK digit while the live bundle has none
p = 'src/Layout.jsx'
s = open(p).read()
old = """  const liveVersionLabel = isOwnerDevice && publishedVersionInfo
    ? `live v${APP_VERSION_MAJOR}.${publishedVersionInfo.apkDigit}.${publishedVersionInfo.webVersion}`
    : null;"""
new = """  const _liveApkDigit = publishedVersionInfo
    ? (publishedVersionInfo.apkDigit > 0
        ? publishedVersionInfo.apkDigit
        : apkUpdatesFromSuccessCount(latestBuild?.successCount ?? 0))
    : 0;
  const liveVersionLabel = isOwnerDevice && publishedVersionInfo
    ? `live v${APP_VERSION_MAJOR}.${_liveApkDigit}.${publishedVersionInfo.webVersion}`
    : null;"""
assert old in s
s = s.replace(old, new, 1)
open(p, 'w').write(s)
print('live label fallback wired')
