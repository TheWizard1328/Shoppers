/**
 * breadcrumbChainCommit — pure helpers for the conditional chain-commit engine.
 *
 * The default breadcrumb rule commits one fix per 5s tick. When the latest fix
 * at a 5s tick would land ≥ CHAIN_COMMIT_CAP_M from the last committed crumb,
 * the tracker walks the ~5 buffered 1s fixes and commits the FURTHEST one that
 * is strictly < CHAIN_COMMIT_CAP_M away, carrying the rest forward — so committed
 * crumb-to-crumb distances never trip snapMasterTimeline's 250m gap detector
 * (GAP_THRESHOLD_M = 250 in base44/functions/snapMasterTimeline/entry.ts) on
 * healthy sampled highway sections. Only a genuine GPS outage (no buffered fix
 * within the cap) force-commits the latest fix, marked as an outage point.
 *
 * A conservative accuracy gate drops fixes with poor pos.coords.accuracy before
 * they enter the buffer, keeping multipath out of the chain. The gate threshold
 * is tunable via Winter Mode (breadcrumb_accuracy_gate_m, default 100m).
 *
 * This module holds ONLY pure functions + config reads — no timers, no I/O. The
 * locationTracker owns the tick orchestration and the call into collectBreadcrumb.
 */
import { haversineMeters } from './geoUtils';
import { getCachedWinterModeSync } from './winterModeSettings';

// Anchored to snapMasterTimeline GAP_THRESHOLD_M. Strict < so committed pairs
// never satisfy the >250m flag condition — no separate safety margin needed
// because the strict inequality vs >250 leaves a clean boundary.
export const CHAIN_COMMIT_CAP_M = 250;

// Default accuracy gate (conservative). Tunable via Winter Mode.
export const DEFAULT_ACCURACY_GATE_M = 100;

/**
 * Sync read of the tunable accuracy gate (metres). Falls back to the default
 * when Winter Mode settings aren't loaded yet or the field is missing/invalid.
 * Safe to call on every ~1s GPS tick — it only reads a cached object.
 */
export function getAccuracyGateM() {
  try {
    const wm = getCachedWinterModeSync();
    const v = wm?.breadcrumb_accuracy_gate_m;
    if (Number.isFinite(v) && v > 0) return v;
  } catch (_) { /* settings not loaded yet — use default */ }
  return DEFAULT_ACCURACY_GATE_M;
}

/**
 * Returns true when a fix's reported accuracy is too poor to enter the buffer.
 * Fixes with no reported accuracy are kept (we can't judge them).
 */
export function shouldDropByAccuracy(accuracy, gateM = getAccuracyGateM()) {
  if (accuracy == null || !Number.isFinite(accuracy)) return false;
  return accuracy >= gateM;
}

/**
 * Walk the buffered fixes oldest→newest and pick the furthest fix strictly
 * < capM from the last committed crumb. Returns the commit fix plus the
 * remaining buffer (fixes newer than the committed one) to carry forward.
 *
 * If no fix is < cap (genuine outage), force-commits the latest fix and marks
 * it as an outage point so the snap analyzer can treat the resulting >250m gap
 * as a known GPS-outage gap rather than a sampling artifact.
 *
 * @param {Array<{lat:number,lng:number,ts:number}>} buffer chronological, oldest first
 * @param {{lat:number,lng:number}|null} lastCommitted  null = first crumb of the day
 * @param {number} [capM]  strict upper bound (default 250)
 * @returns {{ commit: {lat:number,lng:number,ts:number,outage:boolean}|null, carryForward: Array }}
 */
export function selectChainCommitPoint(buffer, lastCommitted, capM = CHAIN_COMMIT_CAP_M) {
  if (!buffer || buffer.length === 0) return { commit: null, carryForward: [] };

  // First crumb of the day (no last committed point) → commit the latest fix.
  if (!lastCommitted) {
    return { commit: { ...buffer[buffer.length - 1], outage: false }, carryForward: [] };
  }

  // Scan all buffered fixes; track the furthest one still strictly < cap.
  // (Distance from the last commit is not monotonic — the driver can move away
  // then back — so we scan the whole buffer rather than stopping at the first
  // breach.)
  let commitIdx = -1;
  let commitDist = -1;
  for (let i = 0; i < buffer.length; i++) {
    const d = haversineMeters(lastCommitted.lat, lastCommitted.lng, buffer[i].lat, buffer[i].lng);
    if (d < capM && d > commitDist) {
      commitDist = d;
      commitIdx = i;
    }
  }

  if (commitIdx >= 0) {
    // Commit the furthest valid fix; carry the newer fixes forward into the
    // next 5s window so they are not lost (e.g. committing crumb 3 of 5 leaves
    // crumbs 4–5 as the next window's starting buffer).
    const carryForward = buffer.slice(commitIdx + 1);
    return { commit: { ...buffer[commitIdx], outage: false }, carryForward };
  }

  // Genuine outage: no buffered fix is within the cap. Force-commit the latest
  // fix and mark it. snapMasterTimeline will still fill the >250m gap via HERE
  // routing; the marker is diagnostic so the Route viewer can annotate it as a
  // known GPS-outage gap rather than a sampling artifact.
  const latest = buffer[buffer.length - 1];
  return { commit: { ...latest, outage: true }, carryForward: [] };
}