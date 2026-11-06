p = 'src/components/utils/nativeAppUpdateCheck.jsx'
s = open(p).read()

# import the live published digits + the release label source
s = s.replace(
    "import { isCapacitorNativeApp, getCapacitorPlatform, isPlayStoreBuild } from '@/components/utils/locationProviders/capacitorRuntime';",
    "import { isCapacitorNativeApp, getCapacitorPlatform, isPlayStoreBuild } from '@/components/utils/locationProviders/capacitorRuntime';\nimport { getPublishedApkDigitSync } from '@/components/utils/publishedBuildInfo';\nimport { useLatestApkBuildInfo } from '@/components/utils/useBuildInfo';",
    1)

# call the build-info hook at the top of the update check hook
s = s.replace(
    "export function useAndroidAppUpdateCheck(latestBuildNumber) {",
    "export function useAndroidAppUpdateCheck(latestBuildNumber) {\n  // PUBLISH GATE source: the newest APK release's own digit (what this device\n  // could install) — held until the LIVE published bundle advertises it.\n  const latestBuildInfo = useLatestApkBuildInfo();",
    1)

old = """          if (installedNum != null && latestNum != null && latestNum > installedNum) {"""
new = """          if (publishGateOpen && installedNum != null && latestNum != null && latestNum > installedNum) {"""
assert old in s
s = s.replace(old, new, 1)

anchor = """        const latestNum = latestBuildNumber != null ? parseInt(latestBuildNumber, 10) : null;"""
gate = """        const latestNum = latestBuildNumber != null ? parseInt(latestBuildNumber, 10) : null;
        // PUBLISH GATE (owner spec Nov 6 2026): do not announce a fresh APK to
        // LIVE users until the matching WEB version is published. Installing an
        // APK resets the WEB digit to 0, so announcing first leaves the live path
        // reporting an APK digit it does not carry. The live deployment's own
        // version.json carries the APK digit baked into the published bundle; the
        // notice only opens once that digit has caught up with the release this
        // device would download. Unknown digits fail OPEN so a driver is never
        // stranded on an old APK.
        let publishGateOpen = true;
        try {
          const announced = Number(getPublishedApkDigitSync()?.apkDigit) || 0;
          const releaseMid = Number(String(latestBuildInfo?.releaseVersion || '').split('.')[1]) || 0;
          if (announced > 0 && releaseMid > 0) {
            publishGateOpen = announced >= releaseMid;
            if (!publishGateOpen) {
              console.log(`[nativeUpdate] holding APK notice: release digit ${releaseMid} not published yet (live advertises ${announced})`);
            }
          }
        } catch { /* fail open */ }"""
assert anchor in s
s = s.replace(anchor, gate, 1)

s = s.replace("  }, [latestBuildNumber]);", "  }, [latestBuildNumber, latestBuildInfo?.releaseVersion]);", 1)
open(p, 'w').write(s)
print('publish gate added')
