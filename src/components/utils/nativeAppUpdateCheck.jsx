import { useState, useEffect } from 'react';
import { RefreshCw } from 'lucide-react';
import { isCapacitorNativeApp, getCapacitorPlatform } from '@/components/utils/locationProviders/capacitorRuntime';

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
      try {
        const { App } = await import('@capacitor/app');
        const info = await App.getInfo();
        const versionStr = info?.version || '';
        const buildMatch = /1\.0\.(\d+)/.exec(versionStr);
        const installedNum = buildMatch ? parseInt(buildMatch[1], 10) : null;

        if (!cancelled) setInstalledVersion({ buildNumber: installedNum, versionStr });

        const latestNum = latestBuildNumber != null ? parseInt(latestBuildNumber, 10) : null;
        // New badge shows ONLY when the latest build number is strictly greater than the installed one.
        if (!cancelled) {
          if (installedNum != null && latestNum != null && latestNum > installedNum) {
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
  }, [latestBuildNumber]);

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