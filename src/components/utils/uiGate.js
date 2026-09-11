// ─── UI gate for backgrounded sessions ───────────────────────────────────────
// (Sep 10, 2026 — owner-requested battery optimization)
//
// On the driver APK, GPS tracking is fully native (@capgo/background-geolocation
// foreground service + WAKE_LOCK), so screen-off tracking never touches this
// web layer. But while the app is backgrounded/minimized/screen-off, every GPS
// tick, WebSocket message, and sync cycle STILL fires React re-renders, map
// marker/polyline updates, and stop-card reconciliation — pure CPU/battery burn
// while nobody is looking.
//
// This module defers UI-only work while `document.hidden`, and replays the
// LATEST deferred unit per key when the app becomes visible again. Data paths
// (entity writes, IDB writes, GPS uploads, heartbeats, breadcrumbs,
// DriverDailyActivity) are NEVER gated — only render-driving calls.
//
// Deferred payloads are full-state snapshots in practice (WS full-replacement
// deliveries, latest GPS tick), so "last per key wins" is correct on replay:
// the replayed unit always carries the freshest IDB-backed data.
//
// IMPORTANT: any future code that must run while backgrounded (data writes,
// sync bookkeeping) must NOT be routed through deferOrRunUI/emitGatedEvent.

let hidden = typeof document !== 'undefined' ? document.hidden : false;

// key -> { run, critical }  (Map preserves insertion order = replay order)
const deferred = new Map();
// Max NON-CRITICAL distinct keys we'll hold while backgrounded. Critical units
// (data-load/hydration events) are never evicted and don't count against this cap.
const MAX_DEFERRED = 24;
const resumeCallbacks = new Set();

const replay = () => {
  hidden = false;
  if (deferred.size > 0) {
    const toRun = Array.from(deferred.values());
    deferred.clear();
    for (const d of toRun) {
      try { d.run(); } catch (e) { console.warn('[uiGate] deferred replay failed:', e?.message); }
    }
  }
  for (const cb of Array.from(resumeCallbacks)) {
    try { cb(); } catch (e) { console.warn('[uiGate] resume callback failed:', e?.message); }
  }
};

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { hidden = true; return; }
    if (hidden) replay(); // only on an actual hidden → visible transition
  });

  // SELF-HEALING RESUME (Sep 10, 2026): Android WebView / Capacitor APKs can MISS the
  // visibilitychange event on resume (screen back on, app restored from recents) —
  // in that state the internal `hidden` flag stays true FOREVER and every data event
  // keeps deferring into the void: "nothing loads on any page until a hard refresh".
  // Redundant un-hide signals plus a cheap poll force a replay as soon as the document
  // is actually visible again, even if the primary event never fired.
  window.addEventListener('pageshow', () => { if (hidden && !document.hidden) replay(); });
  window.addEventListener('focus', () => { if (hidden && !document.hidden) replay(); });
  document.addEventListener('resume', () => { if (hidden && !document.hidden) replay(); });
  window.addEventListener('online', () => { if (hidden && !document.hidden) replay(); });
  setInterval(() => {
    if (hidden && typeof document !== 'undefined' && !document.hidden) {
      console.warn('[uiGate] self-heal: stuck hidden flag cleared (document is visible)');
      replay();
    }
  }, 3000);
}

/** True while the app is backgrounded/minimized/screen-off. */
export const isUIHidden = () => hidden;

/**
 * Run a unit of UI work now, or defer the LATEST unit per key until the app
 * becomes visible. While hidden, each call with the same key REPLACES the
 * previous one (last-wins) — used for full-snapshot payloads like WS
 * full-replacement deliveries and the latest GPS position.
 */
// critical=true → this unit is a DATA event (full state load, hydration, realtime
// full-replacement). Critical units are NEVER evicted on overflow — the Sep 10 bug
// was per-driver WS heartbeat events (one distinct key per user id: wsAppUser:<id>)
// multiplying past the cap and EVICTING the oldest deferred units, which were the
// boot/hydration data loads — so on resume, position ticks replayed but data never
// loaded (blank scheduler/payroll/admin pages app-wide). Droppable UI-only units
// (latest GPS tick, poller notify) still rotate as before.
export const deferOrRunUI = (key, run, { critical = false } = {}) => {
  if (!hidden) { run(); return; }
  if (deferred.size >= MAX_DEFERRED && !deferred.has(key) && !critical) {
    // Overflow guard: drop the OLDEST non-critical deferred unit. Critical units are
    // kept and allowed to exceed the cap (payloads are small closures; data > memory).
    for (const [k, v] of deferred) {
      if (!v.critical) { deferred.delete(k); break; }
    }
  }
  deferred.set(key, { run, critical });
};

/**
 * Dispatch a window CustomEvent now, or defer the LATEST event per key until
 * the app becomes visible. Consumers process it exactly as if it had arrived
 * then — nothing is lost, only the timing changes.
 */
export const emitGatedEvent = (event, key, opts) => {
  if (!hidden) { window.dispatchEvent(event); return; }
  deferOrRunUI(key, () => window.dispatchEvent(event), opts);
};

/**
 * Subscribe to UI resume (hidden → visible), AFTER deferred units have been
 * replayed. Returns an unsubscribe function.
 */
export const onUIResume = (cb) => {
  resumeCallbacks.add(cb);
  return () => resumeCallbacks.delete(cb);
};
