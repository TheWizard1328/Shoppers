import { useState, useEffect } from 'react';
import { isCapacitorNativeApp, getCapacitorPlatform } from './locationProviders/capacitorRuntime';

/**
 * Shared hook that fetches the latest APK build info from GitHub.
 * Used by both the sidebar (Layout.jsx) and Settings page so they
 * always show the same build number.
 *
 * Returns:
 *   buildNumber  — GitHub Actions run_number of the latest successful build
 *   dateStr      — Human-readable release date
 *   apkUrl       — Direct download URL for the .apk asset
 *   buildText    — "Built: v1.0.N · Aug 16, 2026, 03:12 a.m."
 *   versionLabel — "v1.0.N"  (for the sidebar badge)
 *   loaded       — true once the fetch completes
 */
export function useLatestApkBuildInfo() {
  const [buildInfo, setBuildInfo] = useState(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch('https://api.github.com/repos/TheWizard1328/Shoppers/releases/tags/apk-latest')
        .then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch('https://api.github.com/repos/TheWizard1328/Shoppers/actions/workflows/build-apk.yml/runs?status=success&per_page=1')
        .then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]).then(([releaseData, runsData]) => {
      if (cancelled) return;
      const rawDate = releaseData?.published_at || releaseData?.created_at || null;
      const dateStr = rawDate
        ? new Date(rawDate).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })
        : '';
      const buildNumber = runsData?.workflow_runs?.[0]?.run_number || null;
      const apkAsset = (releaseData?.assets || []).find((a) => a.name && a.name.endsWith('.apk'));
      setBuildInfo({
        dateStr,
        buildNumber,
        apkUrl: apkAsset?.browser_download_url || null,
      });
    });
    return () => { cancelled = true; };
  }, []);

  const buildText = buildInfo
    ? buildInfo.buildNumber
      ? `Built: v1.0.${buildInfo.buildNumber} · ${buildInfo.dateStr}`
      : buildInfo.dateStr
        ? `Built: ${buildInfo.dateStr}`
        : ''
    : '';

  const versionLabel = buildInfo?.buildNumber ? `v1.0.${buildInfo.buildNumber}` : '';

  return { ...buildInfo, buildText, versionLabel, loaded: !!buildInfo };
}

/**
 * For native Android apps: reads the installed APK version from Capacitor's
 * App.getInfo(). Returns { buildNumber, versionLabel } or null.
 *
 * Web users return null (they don't have an "installed" version).
 */
export function useInstalledAppVersion() {
  const [installed, setInstalled] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      // Dynamically import to avoid bundling Capacitor for web-only users
      try {
        if (!isCapacitorNativeApp() || getCapacitorPlatform() !== 'android') return;
        const { App } = await import('@capacitor/app');
        const info = await App.getInfo();
        const versionStr = info?.version || '';
        const buildMatch = /1\.0\.(\d+)/.exec(versionStr);
        const buildNumber = buildMatch ? buildMatch[1] : null;
        if (!cancelled && buildNumber) {
          setInstalled({ buildNumber, versionLabel: `v1.0.${buildNumber}` });
        }
      } catch {
        // Not a native app or Capacitor not available
      }
    };
    run();
    return () => { cancelled = true; };
  }, []);

  return installed;
}
