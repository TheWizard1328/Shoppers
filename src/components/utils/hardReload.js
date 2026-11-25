/**
 * hardReload.js
 *
 * OWNER REPORT (Nov 24 2026, hourly digest): the desktop editor logged 20 chunk
 * errors in one hour across four bursts. Every recovery reload came back to the
 * SAME stale chunk, because `location.reload()` is served from the HTTP/PWA
 * cache that still holds the previous index.html referencing the old hashed
 * chunk. The purge unregisters the service worker and drops Cache Storage, but
 * the navigation request itself can still be answered from the back/forward or
 * disk cache.
 *
 * So the recovery navigation carries a one-shot `_b=<timestamp>` query param:
 * a URL the cache has never seen, which forces a real network fetch of
 * index.html and therefore of the current chunk hashes. Same origin, same path,
 * same hash route — nothing else about the app changes.
 */
export const hardReload = (delayMs = 0) => {
  const go = () => {
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('_b', String(Date.now()));
      window.location.replace(url.toString());
    } catch (_) {
      try { window.location.reload(); } catch (_) {}
    }
  };
  if (delayMs > 0) setTimeout(go, delayMs);
  else go();
};

export default hardReload;
