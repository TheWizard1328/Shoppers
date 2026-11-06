p = 'src/components/utils/useWebUpdateCheck.js'
s = open(p).read()

anchor = "const POLL_INTERVAL = 5 * 60 * 1000; // 5 minutes"
assert anchor in s
helper = anchor + """

/**
 * PREVIEW SELF-REFRESH (owner report Nov 6 2026, twice): "the 2 row version
 * numbers are only showing on the editor, not on the preview PWA or my phone
 * preview APK." Those devices were still running an older cached bundle — the
 * app never pulled the newer one, so code that only exists in the new build can
 * never render there. On a preview host only, once per served build, the app now
 * reloads itself onto the new bundle with a cache-busting query so a fresh
 * index.html pulls the fresh hashed chunks. Production hosts are untouched.
 */
const PREVIEW_RELOAD_KEY = 'rxdeliver_preview_autoreload';
const maybeAutoReloadPreview = (buildId) => {
  try {
    const host = String(window?.location?.hostname || '').toLowerCase();
    if (!/^preview--/.test(host)) return;
    const seen = sessionStorage.getItem(PREVIEW_RELOAD_KEY) || '';
    if (!buildId || seen === buildId) return;
    sessionStorage.setItem(PREVIEW_RELOAD_KEY, buildId);
    const url = new URL(window.location.href);
    url.searchParams.set('b', buildId);
    console.info('[Update] preview host is serving a newer build, reloading once:', buildId);
    setTimeout(() => { window.location.replace(url.toString()); }, 1500);
  } catch { /* never break the app for a convenience reload */ }
};"""
s = s.replace(anchor, helper, 1)

# fire it wherever a newer server build is detected
s = s.replace("""          setHasUpdate(true);
          return;""", """          setHasUpdate(true);
          maybeAutoReloadPreview(serverBuildId);
          return;""", 1)
s = s.replace("""          setHasUpdate(true);
        }
      } catch {
        // silent — no badge""", """          setHasUpdate(true);
          maybeAutoReloadPreview(data.buildId);
        }
      } catch {
        // silent — no badge""", 1)
open(p, 'w').write(s)
print('preview self-refresh added')
