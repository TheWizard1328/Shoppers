p = 'src/components/utils/publishedBuildInfo.jsx'
s = open(p).read()

# 1) long-lived mirror so the live row survives a failed lookup
anchor = "const CACHE_TTL_MS = 5 * 60 * 1000;"
assert anchor in s
mirror = anchor + """

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
};"""
s = s.replace(anchor, mirror, 1)

# 2) retry the lookup instead of one shot
old = """  } catch (err) {
    console.warn('[publishedBuild] live version digits lookup failed:', err?.message || err);
    return readDigits();
  }
}"""
new = """  } catch (err) {
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
}"""
assert old in s
s = s.replace(old, new, 1)

# 3) mirror on every successful resolve (both the cache path and the fresh path)
s = s.replace("""    if (digest) return digest;""", """    if (digest) { writeMirror(digest); return digest; }""", 1)
s = s.replace("""    return { apkDigit, webVersion: Number.isFinite(webVersion) ? webVersion : 0 };""",
              """    const _fresh = { apkDigit, webVersion: Number.isFinite(webVersion) ? webVersion : 0 };
    writeMirror(_fresh);
    return _fresh;""", 1)

# 4) first paint uses the mirror, so the row shows even before / despite the lookup
s = s.replace("""  const [digits, setDigits] = useState(() => {
    const c = readCache();
    const apkDigit = Number(c?.apkDigit);
    const web = Number(c?.webVersion);
    const hasApk = Number.isFinite(apkDigit) && apkDigit > 0;
    if (!hasApk && !(Number.isFinite(web) && web > 0)) return null;
    return { apkDigit: hasApk ? apkDigit : 0, webVersion: Number.isFinite(web) ? web : 0 };
  });""",
"""  const [digits, setDigits] = useState(() => {
    const c = readCache();
    const apkDigit = Number(c?.apkDigit);
    const web = Number(c?.webVersion);
    const hasApk = Number.isFinite(apkDigit) && apkDigit > 0;
    if (hasApk || (Number.isFinite(web) && web > 0)) {
      return { apkDigit: hasApk ? apkDigit : 0, webVersion: Number.isFinite(web) ? web : 0 };
    }
    return readMirror();
  });""", 1)

# 5) refresh the digits periodically so a stale mirror cannot stick forever
s = s.replace("""    fetchPublishedVersionDigits().then((value) => {
      if (!cancelled && value) setDigits(value);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [enabled]);
  return digits;
}

/** React hook — resolves the live deployment's push count once per mount. */""",
"""    const load = async () => {
      const value = await fetchPublishedVersionDigits().catch(() => null);
      if (!cancelled && value) setDigits(value);
    };
    load();
    const timer = setInterval(load, 10 * 60 * 1000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [enabled]);
  return digits;
}

/** React hook — resolves the live deployment's push count once per mount. */""", 1)
open(p, 'w').write(s)
print('live digits mirror + retry wired')
