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
// Cache key for persisting the last successful GitHub API fetch.
// CRITICAL: Multiple drivers on the same pharmacy WiFi share an IP address.
// GitHub's unauthenticated API limit is 60 req/hr PER IP. With 2 calls per poll
// and 5-min intervals, 3+ devices easily exceed the limit. When rate-limited,
// buildNumber stays null and the "New" update badge never appears. Caching
// the last successful fetch in localStorage ensures the badge still works
// even when the API is rate-limited or the network is flaky.
const BUILD_CACHE_KEY = 'rxdeliver_latest_apk_build';
const POLL_INTERVAL = 5 * 60 * 1000; // 5 minutes

function loadCachedBuildInfo() {
  try {
    const raw = localStorage.getItem(BUILD_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Cache expires after 1 hour — stale build info is better than none, but
    // we don't want to show an outdated "New" badge forever.
    if (Date.now() - (parsed.cachedAt || 0) > 60 * 60 * 1000) return null;
    return {
      dateStr: parsed.dateStr || '',
      buildNumber: parsed.buildNumber || null,
      apkUrl: parsed.apkUrl || null,
      etagRelease: parsed.etagRelease || null,
      etagRuns: parsed.etagRuns || null,
    };
  } catch { return null; }
}

function saveCachedBuildInfo(info) {
  try {
    localStorage.setItem(BUILD_CACHE_KEY, JSON.stringify({ ...info, cachedAt: Date.now() }));
  } catch {}
}

// Conditional request helper using GitHub's ETag support. 304 responses do
// NOT count against GitHub's rate limit (verified against api.github.com),
// so unchanged polls become free — critical because all devices behind the
// pharmacy's shared WiFi IP were exhausting the 60/hr anonymous limit, so
// driver phones never learned a new build existed and the update arrow
// never appeared.
async function fetchGithubCached(url, etag, { minRemaining = 5 } = {}) {
  try {
    const headers = {};
    if (etag) headers['If-None-Match'] = etag;
    const r = await fetch(url, { headers });
    if (r.status === 304) return { notModified: true };
    if (!r.ok) return null;
    const remaining = parseInt(r.headers.get('X-RateLimit-Remaining') || '999', 10);
    if (remaining <= minRemaining) {
      console.warn(`⚠️ [BuildInfo] GitHub API rate limit low (${remaining} remaining) — skipping this poll`);
      return null;
    }
    const json = await r.json();
    return { notModified: false, json, etag: r.headers.get('ETag') || null };
  } catch {
    return null;
  }
}

export function useLatestApkBuildInfo() {
  // Initialize from cache so the badge shows immediately on mount (before the
  // network fetch completes). This fixes the "badge never appears" issue when
  // GitHub API is rate-limited.
  const [buildInfo, setBuildInfo] = useState(() => loadCachedBuildInfo());

  useEffect(() => {
    let cancelled = false;
    let timer = null;

    const fetchData = async () => {
      const cached = loadCachedBuildInfo();
      const [releaseRes, runsRes] = await Promise.all([
        fetchGithubCached('https://api.github.com/repos/TheWizard1328/Shoppers/releases/tags/apk-latest', cached?.etagRelease),
        fetchGithubCached('https://api.github.com/repos/TheWizard1328/Shoppers/actions/workflows/build-apk.yml/runs?status=success&per_page=1', cached?.etagRuns),
      ]);
      if (cancelled) return;

      // 304 (not modified) → keep the cached value for that endpoint; 200 →
      // take the fresh value. null (rate-limited/error) → also keep cached.
      let dateStr = cached?.dateStr || '';
      let buildNumber = cached?.buildNumber || null;
      let apkUrl = cached?.apkUrl || null;
      let etagRelease = cached?.etagRelease || null;
      let etagRuns = cached?.etagRuns || null;

      const releaseData = releaseRes?.notModified ? null : releaseRes?.json || null;
      if (releaseData) {
        const rawDate = releaseData.published_at || releaseData.created_at || null;
        dateStr = rawDate
          ? new Date(rawDate).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })
          : '';
        apkUrl = (releaseData.assets || []).find((a) => a.name && a.name.endsWith('.apk'))?.browser_download_url || null;
        etagRelease = releaseRes.etag || etagRelease;
      }
      const runsData = runsRes?.notModified ? null : runsRes?.json || null;
      if (runsData) {
        buildNumber = runsData.workflow_runs?.[0]?.run_number || buildNumber;
        etagRuns = runsRes.etag || etagRuns;
      }

      // If we got valid data, update cache and state
      if (buildNumber != null || apkUrl != null) {
        const newInfo = { dateStr, buildNumber, apkUrl, etagRelease, etagRuns };
        saveCachedBuildInfo(newInfo);
        if (!cancelled) {
          setBuildInfo((prev) => {
            if (prev && prev.buildNumber === buildNumber && prev.dateStr === dateStr && prev.apkUrl === apkUrl) {
              return prev;
            }
            return newInfo;
          });
        }
      }
      // If both calls returned null (rate-limited or network error), keep the
      // cached state — don't clear it. The cached build number is still valid
      // for badge comparison.
    };

    fetchData();
    timer = setInterval(fetchData, POLL_INTERVAL);

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
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