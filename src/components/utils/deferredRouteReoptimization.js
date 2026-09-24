// deferredRouteReoptimization — pause-aware 5-second deferred scheduler for
// post-edit route reoptimization (owner spec, Sep 24 2026).
//
// Window edits on non-pending stops schedule their route reoptimization to fire
// DEFER_MS later. While ANY blocking UI is open (Delivery Edit form, Add To
// Route, Quick Route Adjustments panel, stop delete confirmation), the countdown
// is PAUSED. When the last blocker closes, the countdown RESTARTS from the full
// 5 seconds. A fresher optimization (delete, quick reorder, Accept All, manual
// FAB) that completes for the same driver:date before the timer fires absorbs
// the pending entry — route state those edits wanted re-synced is already
// current, so the redundant HERE call is cancelled (see
// routeOptimizationCoordinator's success path).
//
// Pure module: zero imports (no cycles). Fire callbacks are injected by the
// scheduler so this file never imports the coordinator.
//
// API:
//   scheduleDeferredReoptimization(key, fireFn)          — schedule/reset (full 5s)
//   pauseDeferredReoptimization(reason) -> token          — refcounted pause
//   resumeDeferredReoptimization(token)                   — last resume restarts 5s
//   cancelDeferredReoptimization(key, scheduledBefore)    — absorb by fresher run
//   hasPendingDeferredReoptimization(key?)               — introspection

const DEFER_MS = 5000;

// key -> { key, fireFn, timer, scheduledAt }
const pending = new Map();
// token -> reason (refcounted blockers; timer only runs while this is empty)
const pauses = new Map();
let pauseSeq = 0;

const isPaused = () => pauses.size > 0;

function startTimer(entry) {
  clearTimeout(entry.timer);
  entry.timer = setTimeout(async () => {
    pending.delete(entry.key);
    try {
      await entry.fireFn();
    } catch (err) {
      console.warn(`[DeferredReopt] deferred reoptimization failed for ${entry.key}:`, err?.message || err);
    }
  }, DEFER_MS);
}

// Schedule (or re-schedule — a second edit resets the countdown) a deferred
// reoptimization for a route key (convention: `${driverId}:${deliveryDate}`).
// While paused, the entry is stored and its countdown starts on the last resume.
export function scheduleDeferredReoptimization(key, fireFn) {
  if (!key || typeof fireFn !== 'function') return;
  const existing = pending.get(key);
  if (existing) clearTimeout(existing.timer);
  const entry = { key, fireFn, timer: null, scheduledAt: Date.now() };
  pending.set(key, entry);
  if (!isPaused()) startTimer(entry);
  console.info(`[DeferredReopt] scheduled ${key} in ${DEFER_MS / 1000}s${isPaused() ? ' (PAUSED — countdown starts when blockers close)' : ''}`);
}

// Pause the countdown while a blocking form/panel/dialog is open. Returns a
// token that MUST be released with resumeDeferredReoptimization(token).
export function pauseDeferredReoptimization(reason = 'ui_blocker') {
  const token = ++pauseSeq;
  pauses.set(token, reason);
  if (pauses.size === 1) {
    for (const entry of pending.values()) clearTimeout(entry.timer);
    if (pending.size > 0) console.info(`[DeferredReopt] paused (${reason}) — ${pending.size} pending`);
  }
  return token;
}

// Release a pause token. When the LAST blocker closes, every pending entry
// restarts its countdown from the FULL 5 seconds (owner spec: "restart the 5
// sec when they close").
export function resumeDeferredReoptimization(token) {
  if (!pauses.has(token)) return;
  pauses.delete(token);
  if (pauses.size === 0 && pending.size > 0) {
    for (const entry of pending.values()) startTimer(entry);
    console.info(`[DeferredReopt] resumed — restarted ${DEFER_MS / 1000}s countdown for ${pending.size} pending`);
  }
}

// Absorb a pending entry: called when a fresher optimization already ran for
// the same route. Only cancels entries scheduled BEFORE that run started, so a
// brand-new edit made mid-flight keeps its own countdown.
export function cancelDeferredReoptimization(key, scheduledBefore = Infinity) {
  const entry = pending.get(key);
  if (!entry || entry.scheduledAt >= scheduledBefore) return false;
  clearTimeout(entry.timer);
  pending.delete(key);
  console.info(`[DeferredReopt] cancelled ${key} — absorbed by a fresher optimization`);
  return true;
}

export function hasPendingDeferredReoptimization(key) {
  return key ? pending.has(key) : pending.size > 0;
}
