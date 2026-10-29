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

/**
 * Is this local record INCOHERENT with the driver's live duty state?
 * OWNER REPORT (Oct 29 2026): three devices showed three numbers for the same
 * driver — phone 2h40 (a stale local copy holding ONLY the closed 09:40-12:20
 * leg, so the live shift never counted), tablet 5h19 (a stale copy holding one
 * open leg from 09:40 that was never closed at 12:20, so the 25-minute break
 * got counted), activity page 4h53 (correct: 160 min closed + the open leg from
 * 12:45). Both bad copies are detectable from the segments alone:
 *   • driver is on duty but the record has NO open leg  -> the live shift is
 *     missing locally (phone case)
 *   • the open leg starts BEFORE the last closed leg ends -> the break was
 *     never banked, so the open leg also covers it (tablet case)
 *   • more than one open leg -> corrupt
 * Duty time itself stays a LOCAL computation from these legs (closed spans plus
 * start_time->now); this only tells the caller to revalidate a broken copy.
 */
export const segmentsLookIncoherent = (record, { onDutyNow = false, routeFinished = false, nowMs = Date.now() } = {}) => {
  const segs = (Array.isArray(record?.activity_segments) ? record.activity_segments : []).filter((s) => s?.start_time);
  if (!segs.length) return false;
  const ms = (str) => {
    if (!str) return null;
    const d = parseAnyTimestamp(str);
    return d && !isNaN(d.getTime()) ? d.getTime() : null;
  };
  let lastClosedEnd = 0;
  for (const seg of segs) {
    const e = seg.end_time ? ms(seg.end_time) : null;
    if (e && e > lastClosedEnd) lastClosedEnd = e;
  }
  const open = segs.filter((seg) => !seg.end_time);
  if (onDutyNow && !routeFinished && open.length === 0) return true;
  if (open.length > 1) return true;
  if (open.length === 1) {
    const openStart = ms(open[0].start_time);
    if (openStart != null && lastClosedEnd > 0 && openStart < lastClosedEnd) return true;
    // TABLET CASE: one lone open leg and no closed legs at all, already running
    // longer than a short shift. A driver who took a break (or whose earlier leg
    // was banked) has at least one closed leg, so this copy is missing one; the
    // caller revalidates ONCE per session and gets the banked breaks back.
    const closedCount = segs.filter((seg) => seg.end_time).length;
    if (closedCount === 0 && openStart != null && (nowMs - openStart) > 15 * 60 * 1000) return true;
  }
  return false;
};
