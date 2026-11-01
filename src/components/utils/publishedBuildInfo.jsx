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

const readCache = () => {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || !Number.isFinite(Number(parsed.buildNumber))) return null;
    return parsed;
  } catch { return null; }
};

const writeCache = (info) => {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ ...info, cachedAt: Date.now() })); } catch { /* ignore */ }
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
    writeCache({ buildNumber, webVersion: Number(data?.webVersion) || 0, buildId: data?.buildId || null });
    return buildNumber;
  } catch (err) {
    console.warn('[publishedBuild] live build lookup failed:', err?.message || err);
    return cached ? Number(cached.buildNumber) : null;
  }
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
