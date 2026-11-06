import { useState, useEffect } from 'react';
import { RefreshCw } from 'lucide-react';
import { isCapacitorNativeApp, getCapacitorPlatform, isPlayStoreBuild } from '@/components/utils/locationProviders/capacitorRuntime';
import { getPublishedApkDigitSync } from '@/components/utils/publishedBuildInfo';
import { useLatestApkBuildInfo } from '@/components/utils/useBuildInfo';

/**
 * useAndroidAppUpdateCheck
 * Compares the installed native app's build number against the latest build
 * number from GitHub Actions (passed in via `latestBuildNumber`), and
 * re-evaluates whenever that polled number changes (every 5 min). Only
 * meaningful inside the native Android APK — web/iOS never show an "update"
 * state.
 *
 * Returns { updateAvailable, installedVersion, checked }.
 *
 * Shared by the Settings page Native App section AND the sidebar User Settings
 * link so both light up the same "New" badge at the same time.
 */
export function useAndroidAppUpdateCheck(latestBuildNumber) {
  // PUBLISH GATE source: the newest APK release's own digit (what this device
  // could install) — held until the LIVE published bundle advertises it.
  const latestBuildInfo = useLatestApkBuildInfo();
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [installedVersion, setInstalledVersion] = useState(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!isCapacitorNativeApp() || getCapacitorPlatform() !== 'android') {
        setChecked(true);
        return;
      }
      // Play Store builds: updates are managed by Google Play — never show
      // the self-updater badge.
      if (isPlayStoreBuild()) {
        if (!cancelled) { setUpdateAvailable(false); setChecked(true); }
        return;
      }
      try {
        const { App } = await import('@capacitor/app');
        const info = await App.getInfo();
        const versionStr = info?.version || '';
        // New APKs: "1.<apkUpdates>.<web> (build <runNumber> · date)" — the
        // run number lives in the "(build N)" tail. Old APKs: "1.0.<runNumber>
        // (date)". Parse the tail first; a bare "1.0.0 (build 342 ...)" from
        // the broken v342 APK must yield 342, NOT 0 (0 made every reload
        // claim a new update was available).
        const buildMatch = /build (\d+)/.exec(versionStr) || /1\.0\.(\d+)/.exec(versionStr);
        const installedNum = buildMatch ? parseInt(buildMatch[1], 10) : null;

        if (!cancelled) setInstalledVersion({ buildNumber: installedNum, versionStr });

        const latestNum = latestBuildNumber != null ? parseInt(latestBuildNumber, 10) : null;
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
        } catch { /* fail open */ }
        // New badge shows ONLY when the latest build number is strictly greater than the installed one.
        if (!cancelled) {
          if (publishGateOpen && installedNum != null && latestNum != null && latestNum > installedNum) {
            setUpdateAvailable(true);
          } else {
            setUpdateAvailable(false);
          }
        }
      } catch {
        // Silently skip — no update badge shown, not a critical feature
      } finally {
        if (!cancelled) setChecked(true);
      }
    };
    run();
    return () => { cancelled = true; };
  }, [latestBuildNumber, latestBuildInfo?.releaseVersion]);

  return { updateAvailable, installedVersion, checked };
}

/**
 * NativeUpdateBadge
 * The blue "New" pill shown beside a settings link/row when a native APK
 * update is ready to install. Matches the badge style used on the Settings
 * page Native App section so the sidebar and Settings page look identical.
 */
export function NativeUpdateBadge({ className = '' }) {
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold text-white ${className}`}
      style={{ background: '#2563EB' }}
    >
      <RefreshCw className="w-2.5 h-2.5" />
      New
    </span>
  );
}