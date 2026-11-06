p = 'src/Layout.jsx'
s = open(p).read()

old = """  const publishedPushCount = usePublishedPushCount(isOwnerDevice);
  const buildsAheadCount = !isOwnerDevice
    ? 0
    : (PUSH_COUNT > 0 && publishedPushCount > 0
        ? Math.max(0, PUSH_COUNT - publishedPushCount)
        : (publishedBuildNumber
            ? Math.max(0, BUILD_NUMBER - publishedBuildNumber)
            : (changeLogBaseline > 0 ? Math.max(0, buildsAhead(changeLogBaseline)) : 0)));"""
new = """  const publishedPushCount = usePublishedPushCount(isOwnerDevice);
  // OWNER DECISION (Nov 6 2026): a WRONG counter is worse than none. Until the
  // live deployment's version.json carries pushCount there is no honest number
  // to show (the old build-number fallback read (+1) through dozens of pushes),
  // so the badge stays hidden and starts working on the first publish of this
  // build.
  const buildsAheadCount = !isOwnerDevice
    ? 0
    : (PUSH_COUNT > 0 && publishedPushCount > 0
        ? Math.max(0, PUSH_COUNT - publishedPushCount)
        : 0);

  // LIVE VERSION LINE (owner spec Nov 6 2026): v2.[APK].[WEB] as the LIVE site
  // reports it — the APK digit baked into the bundle that is actually published
  // plus that bundle's own WEB digit. It therefore holds 2.[20].212 until the
  // next web publish even though a newer APK run already bumped the live count.
  const publishedVersionInfo = usePublishedVersionDigits(isOwnerDevice);
  const liveVersionLabel = isOwnerDevice && publishedVersionInfo
    ? `live v${APP_VERSION_MAJOR}.${publishedVersionInfo.apkDigit}.${publishedVersionInfo.webVersion}`
    : null;"""
assert old in s, 'badge anchor missing'
s = s.replace(old, new, 1)

s = s.replace(
    "import { usePublishedBuildNumber, usePublishedPushCount } from './components/utils/publishedBuildInfo';",
    "import { usePublishedBuildNumber, usePublishedPushCount, usePublishedVersionDigits } from './components/utils/publishedBuildInfo';",
    1)
open(p, 'w').write(s)

p = 'src/components/layout/AppSidebar.jsx'
s = open(p).read()
old = """              {buildsAheadCount > 0 && (
                <span className="ml-1 font-semibold text-amber-600">(+{buildsAheadCount})</span>
              )}
            </p>"""
new = """              {buildsAheadCount > 0 && (
                <span className="ml-1 font-semibold text-amber-600">(+{buildsAheadCount})</span>
              )}
            </p>
            {liveVersionLabel && (
              <p className="text-[11px] text-soft text-left leading-tight">{liveVersionLabel}</p>
            )}"""
assert old in s, 'sidebar anchor missing'
s = s.replace(old, new, 1)
s = s.replace('branding, appVersion, buildsAheadCount, onOpenUpdateLog,', 'branding, appVersion, buildsAheadCount, liveVersionLabel, onOpenUpdateLog,', 1)
open(p, 'w').write(s)
print('layout + sidebar patched')
