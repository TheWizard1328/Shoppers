p = 'src/components/utils/publishedBuildInfo.jsx'
s = open(p).read()

anchor = "/** React hook — resolves the live deployment's push count once per mount. */"
assert anchor in s, 'hook anchor missing'

add = """/**
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
    if (!Number.isFinite(apkDigit) || apkDigit <= 0) return null;
    return { apkDigit, webVersion: Number(c?.webVersion) || 0 };
  };
  if (!force && cached && Date.now() - Number(cached.cachedAt || 0) < CACHE_TTL_MS) {
    const digest = readDigits();
    if (digest) return digest;
  }
  try {
    const res = await base44.functions.invoke('getPublishedBuildInfo', {});
    const data = res?.data || res;
    const apkDigit = Number(data?.apkDigit);
    if (!Number.isFinite(apkDigit) || apkDigit <= 0) return readDigits();
    writeCache({
      buildNumber: Number(data?.buildNumber) || Number(cached?.buildNumber) || 0,
      webVersion: Number(data?.webVersion) || 0,
      apkDigit,
      buildId: data?.buildId || null,
      pushCount: Number(data?.pushCount) || Number(cached?.pushCount) || undefined,
    });
    return { apkDigit, webVersion: Number(data?.webVersion) || 0 };
  } catch (err) {
    console.warn('[publishedBuild] live version digits lookup failed:', err?.message || err);
    return readDigits();
  }
}

export function usePublishedVersionDigits(enabled = true) {
  const [digits, setDigits] = useState(() => {
    const c = readCache();
    const apkDigit = Number(c?.apkDigit);
    return Number.isFinite(apkDigit) && apkDigit > 0 ? { apkDigit, webVersion: Number(c?.webVersion) || 0 } : null;
  });
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetchPublishedVersionDigits().then((value) => {
      if (!cancelled && value) setDigits(value);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [enabled]);
  return digits;
}

"""
s = s.replace(anchor, add + anchor, 1)
open(p, 'w').write(s)

# Layout: APP_VERSION_MAJOR import + pass the label to the sidebar
p = 'src/Layout.jsx'
s = open(p).read()
if 'APP_VERSION_MAJOR' in s and 'from \'./version\'' not in s:
    s = s.replace("import { PUSH_COUNT, BUILD_NUMBER, buildsAhead, entriesSince } from './changeLog';",
                  "import { PUSH_COUNT, BUILD_NUMBER, buildsAhead, entriesSince } from './changeLog';\nimport { APP_VERSION_MAJOR } from './version';", 1)
s = s.replace("                  buildsAheadCount={buildsAheadCount}",
              "                  buildsAheadCount={buildsAheadCount}\n                  liveVersionLabel={liveVersionLabel}", 1)
open(p, 'w').write(s)
print('hook + wiring done')
