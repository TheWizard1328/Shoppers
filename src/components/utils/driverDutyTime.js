// ── Shared on-duty time math (owner directive Oct 27 2026) ────────────────────
// The dashboard stats card "Time On Duty" and the Admin Driver Activity page
// must show the SAME number for the same DriverDailyActivity record. Both now
// import this module — a single definition, no drift.
//
// Semantics (matches the original Driver Activity page implementation):
//   - each segment contributes its own start→end span (closed segments use
//     their end_time; an OPEN segment runs against "now")
//   - per-segment sum — gaps between segments are breaks and don't count
//
// Parsing uses parseAnyTimestamp: real ISO-UTC strings parse identically to
// new Date(), while naive Edmonton wall strings (the actual_delivery_time
// convention) resolve correctly instead of through the device's tz engine.

import { parseAnyTimestamp } from './albertaTime';

const msOf = (str, fallbackMs) => {
  const d = str ? parseAnyTimestamp(str) : null;
  return d && !isNaN(d.getTime()) ? d.getTime() : fallbackMs;
};

export const calcSegmentMinutes = (seg, nowMs = Date.now(), { liveOpenSegment = true } = {}) => {
  if (!seg?.start_time) return 0;
  const startMs = msOf(seg.start_time, null);
  if (startMs === null) return 0;
  // OWNER REPORT (Oct 28 2026): "time on duty is still counting up even though
  // my route is finished - no extra increments now that I'm off duty." An OPEN
  // segment (no end_time) is a live shift ONLY while the driver is actually on
  // duty. A record that was never closed locally (auto-off-duty closed it
  // server-side, a stale IDB mirror, a device that missed the WS update) kept
  // running against "now" forever. With liveOpenSegment false an open segment
  // contributes what it has already banked (start->start = 0 extra), so the
  // number stops moving the moment the driver is off duty.
  const endMs = seg.end_time ? msOf(seg.end_time, nowMs) : (liveOpenSegment ? nowMs : startMs);
  return Math.max(0, Math.trunc((endMs - startMs) / 60000));
};

export const totalOnDutyMinutes = (record, nowMs = Date.now(), opts = {}) => {
  if (!record?.activity_segments?.length) return 0;
  return record.activity_segments.reduce(
    (sum, seg) => sum + calcSegmentMinutes(seg, nowMs, opts),
    0
  );
};

/**
 * Does this record still hold an OPEN (unclosed) segment? When the driver is
 * already off duty that open segment is stale — the server's closed version is
 * the truth — so callers revalidate instead of displaying a running clock.
 */
export const hasOpenSegment = (record) => Array.isArray(record?.activity_segments)
  && record.activity_segments.some((seg) => seg?.start_time && !seg?.end_time);
