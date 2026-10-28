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

export const calcSegmentMinutes = (seg, nowMs = Date.now()) => {
  if (!seg?.start_time) return 0;
  const startMs = msOf(seg.start_time, null);
  if (startMs === null) return 0;
  const endMs = seg.end_time ? msOf(seg.end_time, nowMs) : nowMs;
  return Math.max(0, Math.trunc((endMs - startMs) / 60000));
};

export const totalOnDutyMinutes = (record, nowMs = Date.now()) => {
  if (!record?.activity_segments?.length) return 0;
  return record.activity_segments.reduce(
    (sum, seg) => sum + calcSegmentMinutes(seg, nowMs),
    0
  );
};
