/**
 * publishedBuildInfo — the builds-ahead counter's source of truth.
 *
 * OWNER REPORT (Oct 31 2026): the sidebar showed (+42) instead of (+1). The
 * counter was `BUILD_NUMBER - baselineBuild`, and baselineBuild is only
 * stamped when an owner device sits on the LIVE domain and notices it is
 * ahead — so with nobody on live the baseline stayed 0 and every build since
 * the beginning counted as "ahead".
 *
 * Now the baseline is the LIVE deployment's real build number, read from the
 * live site's version.json through a backend function (a browser fetch is
 * blocked by CORS). Cached for 5 minutes; any failure returns null so the
 * caller can fall back to its stamped baseline instead of guessing.
 */
import { useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';

const CACHE_KEY = 'rxdeliver_live_build_info';
const CACHE_TTL_MS = 5 * 60 * 1000;

// LONG-LIVED MIRROR (owner report Nov 6 2026): "The-Desktop(Editor),
// The-Desktop(PWA) and The-Phone are only showing v2.23.002 (+4)" while the
// laptop and tablet showed both rows. Same bundle everywhere, so the difference
// was the live-digits LOOKUP: it has a 5-minute TTL and a single attempt, so a
// device whose invoke failed (429 / offline blip) rendered NOTHING for the rest
// of the session. The digits are now mirrored without a TTL and painted on the
// first render, and a failed lookup is retried before giving up.
const MIRROR_KEY = 'rxdeliver_live_version_digits';
const readMirror = () => {
  try {
    const raw = localStorage.getItem(MIRROR_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    const apkDigit = Number(parsed?.apkDigit);
    const webVersion = Number(parsed?.webVersion);
    if (Number.isFinite(apkDigit) && apkDigit > 0) return { apkDigit, webVersion: Number.isFinite(webVersion) ? webVersion : 0 };
    if (Number.isFinite(webVersion) && webVersion > 0) return { apkDigit: 0, webVersion };
    return null;
  } catch { return null; }
};
const writeMirror = (digits) => {
  try { if (digits) localStorage.setItem(MIRROR_KEY, JSON.stringify(digits)); } catch { /* ignore */ }
};

const readCache = () => {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || !Number.isFinite(Number(parsed.buildNumber))) return null;
    return parsed;
  } catch { return null; }
};

const writeCache = (info) => {
  // MERGE (Nov 5 2026): the build number and the push count are written by
  // different callers — a plain overwrite would wipe whichever one the other
  // caller had just cached.
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ ...(readCache() || {}), ...info, cachedAt: Date.now() })); } catch { /* ignore */ }
};

/** Synchronous best-effort read for first paint. */
export const getPublishedBuildSync = () => {
  const cached = readCache();
  if (!cached) return null;
  return Number(cached.buildNumber);
};

export async function fetchPublishedBuild({ force = false } = {}) {
  const cached = readCache();
  if (!force && cached && Date.now() - Number(cached.cachedAt || 0) < CACHE_TTL_MS) {
    return Number(cached.buildNumber);
  }
  try {
    const res = await base44.functions.invoke('getPublishedBuildInfo', {});
    const data = res?.data || res;
    const buildNumber = Number(data?.buildNumber);
    if (!Number.isFinite(buildNumber) || buildNumber <= 0) return cached ? Number(cached.buildNumber) : null;
    writeCache({ buildNumber, webVersion: Number(data?.webVersion) || 0, apkDigit: Number(data?.apkDigit) || 0, buildId: data?.buildId || null, pushCount: Number(data?.pushCount) || undefined });
    return buildNumber;
  } catch (err) {
    console.warn('[publishedBuild] live build lookup failed:', err?.message || err);
    return cached ? Number(cached.buildNumber) : null;
  }
}

/** Synchronous best-effort read of the LIVE deployment's push count. */
export const getPublishedApkDigitSync = () => {
  const cached = readCache();
  const d = Number(cached?.apkDigit);
  const w = Number(cached?.webVersion);
  if (!Number.isFinite(d) || d <= 0) return null;
  return { apkDigit: d, webVersion: Number.isFinite(w) ? w : 0 };
};

export const getPublishedPushSync = () => {
  const cached = readCache();
  const p = Number(cached?.pushCount);
  return Number.isFinite(p) && p > 0 ? p : null;
};

/**
 * The LIVE deployment's git push count — the builds-ahead counter's real anchor
 * (owner report Nov 5 2026: the badge read (+1) with 34 changes actually pushed
 * since the last publish). Push count is the only counter that moves on every
 * push, web-only included; a publish lands it level with this bundle's own.
 */
export async function fetchPublishedPushCount({ force = false } = {}) {
  const cached = readCache();
  if (!force && cached && Date.now() - Number(cached.cachedAt || 0) < CACHE_TTL_MS) {
    const p = Number(cached.pushCount);
    if (Number.isFinite(p) && p > 0) return p;
  }
  try {
    const res = await base44.functions.invoke('getPublishedBuildInfo', {});
    const data = res?.data || res;
    const pushCount = Number(data?.pushCount);
    if (!Number.isFinite(pushCount) || pushCount <= 0) return getPublishedPushSync();
    writeCache({
      buildNumber: Number(data?.buildNumber) || Number(cached?.buildNumber) || 0,
      webVersion: Number(data?.webVersion) || 0, apkDigit: Number(data?.apkDigit) || 0,
      buildId: data?.buildId || null,
      pushCount,
    });
    return pushCount;
  } catch (err) {
    console.warn('[publishedBuild] live push count lookup failed:', err?.message || err);
    return getPublishedPushSync();
  }
}

/**
 * The LIVE deployment's published version digits (owner spec Nov 6 2026).
 * apkDigit is baked into the bundle that was published (src/version.js
 * BAKED_APK_DIGIT), so the live site keeps reading 2.[20].212 after a newer APK
 * run bumps the live build count, until the next web publish.
 */
export async function fetchPublishedVersionDigits({ force = false } = {}) {
  const cached = readCache();
  const readDigits = () => {
    const c = readCache();
    const apkDigit = Number(c?.apkDigit);
    // A live bundle published BEFORE apkDigit existed still has a web digit —
    // report the digits we do know (apkDigit 0 = unknown) instead of nothing.
    const web = Number(c?.webVersion);
    const hasApk = Number.isFinite(apkDigit) && apkDigit > 0;
    const hasWeb = Number.isFinite(web) && web > 0;
    // A freshly reset publish legitimately has web 000, so an APK digit alone
    // is a valid answer; only "nothing at all" is null.
    if (!hasApk && !hasWeb) return null;
    return { apkDigit: hasApk ? apkDigit : 0, webVersion: Number.isFinite(web) ? web : 0 };
  };
  if (!force && cached && Date.now() - Number(cached.cachedAt || 0) < CACHE_TTL_MS) {
    const digest = readDigits();
    if (digest) { writeMirror(digest); return digest; }
  }
  try {
    const res = await base44.functions.invoke('getPublishedBuildInfo', {});
    const data = res?.data || res;
    const apkDigit = Number(data?.apkDigit);
    const webVersion = Number(data?.webVersion);
    if (!Number.isFinite(apkDigit) || apkDigit <= 0) {
      // Older live publish (no baked APK digit yet): still surface its WEB digit
      // so the owner can see the live number before the next publish.
      if (Number.isFinite(webVersion) && webVersion > 0) {
        return { apkDigit: 0, webVersion };
      }
      return readDigits();
    }
    writeCache({
      buildNumber: Number(data?.buildNumber) || Number(cached?.buildNumber) || 0,
      webVersion: Number(data?.webVersion) || 0,
      apkDigit,
      buildId: data?.buildId || null,
      pushCount: Number(data?.pushCount) || Number(cached?.pushCount) || undefined,
    });
    const _fresh = { apkDigit, webVersion: Number.isFinite(webVersion) ? webVersion : 0 };
    writeMirror(_fresh);
    return _fresh;
  } catch (err) {
    console.warn('[publishedBuild] live version digits lookup failed:', err?.message || err);
    // Retry: a single failed invoke used to blank the owner's live row for the
    // whole session on that device.
    for (const waitMs of [2500, 7000]) {
      await new Promise((r) => setTimeout(r, waitMs));
      try {
        const retry = await base44.functions.invoke('getPublishedBuildInfo', {});
        const d = retry?.data || retry;
        const apk = Number(d?.apkDigit);
        const web = Number(d?.webVersion);
        if ((Number.isFinite(apk) && apk > 0) || (Number.isFinite(web) && web > 0)) {
          const digits = { apkDigit: Number.isFinite(apk) && apk > 0 ? apk : 0, webVersion: Number.isFinite(web) ? web : 0 };
          writeCache({ apkDigit: digits.apkDigit, webVersion: digits.webVersion });
          writeMirror(digits);
          return digits;
        }
      } catch { /* keep waiting */ }
    }
    return readDigits() || readMirror();
  }
}

export function usePublishedVersionDigits(enabled = true) {
  const [digits, setDigits] = useState(() => {
    const c = readCache();
    const apkDigit = Number(c?.apkDigit);
    const web = Number(c?.webVersion);
    const hasApk = Number.isFinite(apkDigit) && apkDigit > 0;
    if (hasApk || (Number.isFinite(web) && web > 0)) {
      return { apkDigit: hasApk ? apkDigit : 0, webVersion: Number.isFinite(web) ? web : 0 };
    }
    return readMirror();
  });
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const load = async () => {
      const value = await fetchPublishedVersionDigits().catch(() => null);
      if (!cancelled && value) setDigits(value);
    };
    load();
    const timer = setInterval(load, 10 * 60 * 1000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [enabled]);
  return digits;
}

/** React hook — resolves the live deployment's push count once per mount. */
export function usePublishedPushCount(enabled = true) {
  const [pushCount, setPushCount] = useState(() => getPublishedPushSync());
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetchPublishedPushCount().then((value) => {
      if (!cancelled && value) setPushCount(value);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [enabled]);
  return pushCount;
}

/** React hook — resolves the live build number once per mount (5 min cache). */
export function usePublishedBuildNumber(enabled = true) {
  const [buildNumber, setBuildNumber] = useState(() => getPublishedBuildSync());
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetchPublishedBuild().then((value) => {
      if (!cancelled && value) setBuildNumber(value);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [enabled]);
  return buildNumber;
}
