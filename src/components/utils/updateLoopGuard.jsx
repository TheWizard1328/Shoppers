/**
 * updateLoopGuard — stops the "update available forever" loop
 * (owner report Nov 4 2026: "the app constantly saying there is an update
 *  available yet every time I restart or refresh the app the available update
 *  Banner keeps reshowing and devices keep restarting after 5 minutes of idle").
 *
 * WHY IT LOOPED: an auto-reload only helps if the reload actually lands on the
 * new bundle. On the driver devices the reload kept being served the OLD
 * index.html from HTTP cache, so the same mismatch came back after every
 * restart, forever — and each cycle also fired the idle auto-reload, which is
 * why devices restarted on their own.
 *
 * Two jobs here:
 *   1. remember which build we already tried to move to, so a reload that did
 *      not change the bundle is NOT retried in an endless cycle;
 *   2. give the UI an honest answer ("suppressed") instead of nagging.
 */

const KEY = 'rxdeliver_update_attempt_v1';
const MAX_AUTO_RELOADS = 3;
const ATTEMPT_WINDOW_MS = 6 * 60 * 60 * 1000; // 6 hours

const readState = () => {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object') return { attempts: [] };
    const attempts = Array.isArray(parsed.attempts) ? parsed.attempts : [];
    return { attempts: attempts.filter((a) => a && Number.isFinite(a.at)) };
  } catch {
    return { attempts: [] };
  }
};

const writeState = (state) => {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* storage full/blocked */ }
};

const recentAttempts = (targetId) => {
  const cutoff = Date.now() - ATTEMPT_WINDOW_MS;
  return readState().attempts.filter((a) => a.at >= cutoff && (!targetId || a.target === targetId));
};

/** Record that we are about to reload onto `targetId`. */
export function recordUpdateAttempt(targetId, fromBuildId) {
  if (!targetId) return;
  const state = readState();
  const cutoff = Date.now() - ATTEMPT_WINDOW_MS;
  state.attempts = state.attempts.filter((a) => a.at >= cutoff);
  state.attempts.push({ target: String(targetId), from: String(fromBuildId || ''), at: Date.now() });
  writeState(state);
}

/**
 * Should we attempt an automatic reload onto `targetId`?
 * False once this build has been tried MAX_AUTO_RELOADS times in the window:
 * the reload is not changing the bundle, so another one only restarts the
 * device for nothing.
 */
export function canAttemptUpdate(targetId) {
  const tries = recentAttempts(targetId).length;
  if (tries >= MAX_AUTO_RELOADS) return false;
  // Also cap total churn so a stream of different builds cannot restart a
  // driver repeatedly in one shift.
  return recentAttempts(null).length < MAX_AUTO_RELOADS + 2;
}

/**
 * The banner may only nag while an automatic reload is still plausible.
 * After the cap it stays hidden: the device is stuck on a cached shell, and
 * showing "update available" again would just be noise the driver cannot fix.
 */
export function isUpdateSuppressed(targetId) {
  return !canAttemptUpdate(targetId);
}

export function clearUpdateAttempts() {
  try { localStorage.removeItem(KEY); } catch { /* noop */ }
}

/**
 * Hard-bust every cache layer before a reload so the new index.html really is
 * fetched: Cache Storage entries, service workers (which can serve an old
 * document) and finally a unique query string on the navigation.
 */
export async function hardRefreshToNewBuild(text = 'update') {
  try {
    if (typeof caches !== 'undefined' && caches?.keys) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k).catch(() => false)));
    }
  } catch { /* no cache storage in this webview */ }

  try {
    if (navigator?.serviceWorker?.getRegistrations) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister().catch(() => false)));
    }
  } catch { /* no SW support */ }

  // A unique path+query cannot be served from a cached document.
  const url = `/?${text}=${Date.now()}`;
  try {
    window.location.replace(url);
  } catch {
    window.location.href = url;
  }
}
