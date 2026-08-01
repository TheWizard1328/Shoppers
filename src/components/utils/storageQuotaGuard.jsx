const protectedKeys = new Set(['base44_server_url', 'base44_data_env', 'rxdeliver_device_identifier']);

const isProtected = (key) => protectedKeys.has(key) || key.startsWith('base44_');

const getLocalStorageSize = () => {
  try {
    return Object.keys(localStorage).reduce((sum, key) => {
      const value = localStorage.getItem(key) || '';
      return sum + key.length + value.length;
    }, 0);
  } catch {
    return 0;
  }
};

const cleanupLocalStorageQuota = () => {
  try {
    const keys = Object.keys(localStorage);
    let totalSize = getLocalStorageSize();
    if (totalSize < 4000000) return;

    const removableKeys = keys
      .filter((key) => !isProtected(key))
      .map((key) => ({ key, size: (localStorage.getItem(key) || '').length + key.length }))
      .sort((a, b) => b.size - a.size);

    for (const entry of removableKeys) {
      localStorage.removeItem(entry.key);
      totalSize -= entry.size;
      if (totalSize < 3000000) break;
    }
  } catch (error) {
    console.warn('Storage cleanup skipped:', error?.message || error);
  }
};

cleanupLocalStorageQuota();

const originalSetItem = Storage.prototype.setItem;
Storage.prototype.setItem = function patchedSetItem(key, value) {
  try {
    return originalSetItem.call(this, key, value);
  } catch (error) {
    if (error?.name !== 'QuotaExceededError') throw error;

    cleanupLocalStorageQuota();
    return originalSetItem.call(this, key, value);
  }
};
// ─── Chunk load error recovery ───────────────────────────────────────────────
// Dynamic imports outside React render cycle (event handlers, async utils)
// don't get caught by React error boundaries. We intercept unhandledrejection
// here so a stale-chunk crash in a background handler also triggers a reload.
const RELOAD_FLAG = 'rxdeliver_chunk_reload_attempted';
const isChunkMsg = (msg) =>
  msg.includes('Failed to fetch dynamically imported module') ||
  msg.includes('Importing a module script failed') ||
  msg.includes('ChunkLoadError') ||
  msg.includes('Unable to preload CSS');

window.addEventListener('unhandledrejection', (event) => {
  const msg = String(event?.reason?.message || event?.reason || '');
  if (!isChunkMsg(msg)) return;
  event.preventDefault();
  if (!sessionStorage.getItem(RELOAD_FLAG)) {
    sessionStorage.setItem(RELOAD_FLAG, '1');
    setTimeout(() => window.location.reload(), 300);
  }
});
