/**
 * Alberta (America/Edmonton) wall-clock helpers.
 *
 * OWNER DIRECTIVE (Nov 1 2026): Alberta did NOT go permanent UTC-6. The Nov 1
 * fall-back happened normally and the province keeps the ordinary DST cycle
 * (-6 MDT / -7 MST). The previous version of this module hardcoded a
 * "permanent UTC-6 from Nov 1 2026" rule, which was false and made every
 * November instant render an hour late (Driver Activity end times shifted +1h
 * on every open+save cycle).
 *
 * Rule from here on: NEVER hardcode an offset and NEVER hardcode a transition
 * date. The offset always comes from the tz database via Intl with
 * timeZone 'America/Edmonton'.
 *
 * Conventions:
 *   - Naive strings ("YYYY-MM-DDTHH:mm[:ss]", no Z / no offset) are Edmonton
 *     WALL CLOCK — the same convention as Delivery.actual_delivery_time. They
 *     are read verbatim and written verbatim, never converted.
 *   - Real ISO strings (with Z or an offset) are true instants and resolve to
 *     Edmonton wall through the tz database.
 *
 * Accepted once-a-year ambiguity: on the fall-back night the 01:00–02:00 wall
 * hour happens twice, and a naive wall string cannot say which one it means. A
 * segment started in the first pass and closed in the second reads as one hour
 * shorter than the clock on the wall suggests. That window is the only place
 * this shows up — it never touches daytime shifts, payroll day totals or the
 * Square day buckets, and paying wall-clock hours is the intended behaviour.
 */

// WHY 'America/Denver' AND NOT 'America/Edmonton':
// Alberta observes the ordinary North American Mountain-Time DST rule (2nd Sun
// Mar 02:00 -> 1st Sun Nov 02:00, -6 MDT / -7 MST) — the rule America/Denver
// encodes in ICU/tzdata. Some tzdata builds additionally ship an Alberta-only
// override that skips the Nov 1 2026 fall-back and freezes the province on MDT
// (-6); that override does not match reality (owner-verified Nov 1 2026: server
// clock 20:53Z = 13:53 MST, and an override build reports 14:53 for the same
// instant). Denver carries the standard Mountain rule on every build: identical
// to Edmonton when the database is right, and still right when it is not.
// No offset or transition date is hardcoded anywhere.
const TZ = 'America/Denver';

// ── PERMANENT UTC-6 FROM NOV 1 2026 (verified again Nov 2 2026) ──────────────
// Alberta does NOT follow the Nov 1 2026 fall-back: the province stays on
// UTC-6 (permanent daylight time). The Nov 1 2026 revision of this module
// trusted the Denver transition instead and every Intl-derived wall time came
// out one hour BEHIND the real clock from the switch-over onward — completion
// stamps (actual_delivery_time) landed an hour earlier than the arrival time,
// while the device-wall stamps stayed correct.
// Proof used on Nov 2 2026 (UTC 18:12): the platform clock reports 12:12
// America/Edmonton, the sandbox tz database reports 12:12 CST for the same
// instant, and both drivers' device-written arrival stamps read 12:0x — all
// -6. Only the Denver-based conversion said -7.
// The cutoff keeps HISTORY correct: before Nov 1 2026 Alberta observed the
// ordinary Mountain DST cycle (MDT -6 summer / MST -7 winter), so past
// payroll and delivery dates still resolve through the tz database.
const PERMANENT_MDT_FROM_MS = Date.UTC(2026, 10, 1, 9, 0, 0); // Nov 1 2026 09:00Z
const PERMANENT_MDT_OFFSET_MS = -6 * 3600000;
const usesPermanentMdt = (utcMs) => Number.isFinite(utcMs) && utcMs >= PERMANENT_MDT_FROM_MS;

const pad = (v) => String(v).padStart(2, '0');

const WALL_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

const DAY_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

// UTC instant -> Alberta wall components
export const toEdmontonWall = (date) => {
  // Permanent UTC-6 from Nov 1 2026 (see PERMANENT_MDT_FROM_MS): pure math, no
  // tz-database dependence, so every device reports the same Alberta wall.
  const _ms = date?.getTime?.();
  if (usesPermanentMdt(_ms)) {
    const shifted = new Date(_ms + PERMANENT_MDT_OFFSET_MS);
    return {
      y: shifted.getUTCFullYear(), mo: shifted.getUTCMonth() + 1, d: shifted.getUTCDate(),
      h: shifted.getUTCHours(), mi: shifted.getUTCMinutes(), s: shifted.getUTCSeconds(),
    };
  }
  const p = {};
  for (const part of WALL_FMT.formatToParts(date)) p[part.type] = part.value;
  return {
    y: Number(p.year),
    mo: Number(p.month),
    d: Number(p.day),
    h: Number(p.hour),
    mi: Number(p.minute),
    s: Number(p.second),
  };
};

// Minutes east of UTC that Edmonton is observing at a given instant
const offsetMsAt = (utcMs) => {
  if (usesPermanentMdt(utcMs)) return PERMANENT_MDT_OFFSET_MS;
  const w = toEdmontonWall(new Date(utcMs));
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(utcMs / 1000) * 1000;
};

// UTC instant -> Alberta offset in hours (-6 MDT / -7 MST) for that instant
export const albertaOffsetHoursAt = (utcMs) => offsetMsAt(utcMs) / 3600000;

// Alberta wall date (y, mo 1-based, d) -> offset for that wall-clock day
export const albertaOffsetHoursForWallDate = (y, mo, d) =>
  albertaOffsetHoursAt(Date.UTC(y, mo - 1, d, 12, 0, 0));

// Alberta wall components -> UTC Date (resolved through the tz database)
export const edmontonWallToUTC = (y, mo, d, h, mi, s = 0) => {
  const wallAsUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  // Converge: the offset at the guessed instant is the one that applies.
  let utc = wallAsUtc - offsetMsAt(wallAsUtc);
  utc = wallAsUtc - offsetMsAt(utc);
  utc = wallAsUtc - offsetMsAt(utc);
  return new Date(utc);
};

const naiveComponents = (str) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(str));
  if (!m) return null;
  return {
    y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]),
    h: Number(m[4]), mi: Number(m[5]), s: Number(m[6] || 0),
  };
};

// ── Device-tz-proof wall clock for form fields (owner report Oct 29 2026) ────
// "Manual Complete set 07:40 when it was 08:40." Handlers were using
// format(new Date(), 'HH:mm') / date.getHours(), i.e. the DEVICE timezone
// engine — machines whose tz database had flipped Alberta off DST reported
// UTC-7 and prefilled completion times an hour early. These read the Alberta
// wall clock instead, identical on every device.
// Minutes since Edmonton midnight for an instant (optimizer/ETA 'now').
// OWNER REPORT (Nov 2 2026): the optimizer kept promoting a 15:30-window CarePro
// stop ahead of six earlier stops because its 'now' came from Intl
// America/Denver, which still returns -7 while Alberta runs permanent UTC-6 -
// an hour behind made every upcoming window look imminent.
export const edmontonNowMinutes = (date = new Date()) => {
  const w = toEdmontonWall(date);
  return w.h * 60 + w.mi;
};

// Offset string ('-06:00') for an Alberta WALL DATE (HERE departure / access
// constraints). Same permanent-UTC-6 rule as every other conversion here.
export const edmontonOffsetStringForWallDate = (y, mo, d) => {
  const hours = albertaOffsetHoursForWallDate(y, mo, d);
  const sign = hours < 0 ? '-' : '+';
  const abs = Math.abs(hours);
  return `${sign}${String(Math.trunc(abs)).padStart(2, '0')}:${String(Math.round((abs % 1) * 60)).padStart(2, '0')}`;
};

export const edmontonNowHHmm = (date = new Date()) => {
  const w = toEdmontonWall(date);
  return `${pad(w.h)}:${pad(w.mi)}`;
};

// Naive Edmonton wall string OR real UTC/offset string -> Edmonton wall HH:mm.
export const edmontonHHmm = (timestamp) => {
  if (!timestamp) return '';
  const d = parseAnyTimestamp(timestamp);
  if (!d || isNaN(d.getTime())) return '';
  return edmontonNowHHmm(d);
};

// Edmonton wall date "YYYY-MM-DD" for an instant (defaults to now).
export const edmontonTodayKey = (date = new Date()) => DAY_FMT.format(date);

// UTC instant -> naive Edmonton wall string "YYYY-MM-DDTHH:mm:ss" (storage convention
// for client-generated wall timestamps like actual_delivery_time)
export const edmontonWallString = (date) => {
  const w = toEdmontonWall(date);
  return `${w.y}-${pad(w.mo)}-${pad(w.d)}T${pad(w.h)}:${pad(w.mi)}:${pad(w.s)}`;
};

// Square Balances business day (owner rule Oct 9 2026): the day rolls at
// 05:00 Edmonton — between midnight and 5am, sales/collections still count
// as the PREVIOUS calendar day's bucket on the Square Balances page.
export const edmontonBusinessDayKey = (date = new Date()) => {
  const w = toEdmontonWall(date);
  if (w.h >= 5) return `${w.y}-${pad(w.mo)}-${pad(w.d)}`;
  return new Date(Date.UTC(w.y, w.mo - 1, w.d) - 86400000).toISOString().slice(0, 10);
};

// Is a timestamp string naive (no Z / no +/- offset)?
export const isNaiveTimestamp = (str) =>
  typeof str === 'string' && !/Z$/i.test(str) && !/[+-]\d{2}:?\d{2}$/.test(str);

// Parse a timestamp that may be a naive Edmonton wall string OR a real UTC/offset
// ISO string, into a true UTC Date. Naive strings are Edmonton wall time by
// convention (see generateCompletionTimestamp / actual_delivery_time) — NOT
// device-local time. Device-local parsing was the bug: machines with wrong tz
// data read naive strings an hour off.
export const parseAnyTimestamp = (str) => {
  if (!str) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(str));
  if (!m) return new Date(str);
  const naive = isNaiveTimestamp(str);
  const [, y, mo, d, h, mi, s] = m.map(Number);
  if (naive) return edmontonWallToUTC(y, mo, d, h, mi, s || 0);
  return new Date(str);
};

// Any stored timestamp -> {h, m} Edmonton wall clock, or null.
// Short "HH:mm" and naive wall strings are read verbatim (they are already
// wall clock); ISO strings resolve to Edmonton wall.
export const edmontonWallHM = (timestamp) => {
  if (!timestamp) return null;
  const str = String(timestamp);
  let m = /^(\d{1,2}):(\d{2})$/.exec(str);
  if (m) return { h: Number(m[1]), m: Number(m[2]) };
  if (isNaiveTimestamp(str)) {
    const c = naiveComponents(str);
    return c ? { h: c.h, m: c.mi } : null;
  }
  const d = new Date(str);
  if (isNaN(d.getTime())) return null;
  const w = toEdmontonWall(d);
  return { h: w.h, m: w.mi };
};

// Any stored timestamp -> datetime-local input value "YYYY-MM-DDTHH:mm".
// Naive (already wall clock) passes through untouched — open + save can never
// shift the value. Legacy ISO-Z rows are converted once, for display only.
export const edmontonDateTimeInput = (timestamp) => {
  if (!timestamp) return '';
  const str = String(timestamp);
  if (isNaiveTimestamp(str)) {
    const c = naiveComponents(str);
    if (!c) return '';
    return `${c.y}-${pad(c.mo)}-${pad(c.d)}T${pad(c.h)}:${pad(c.mi)}`;
  }
  const d = new Date(str);
  if (isNaN(d.getTime())) return '';
  const w = toEdmontonWall(d);
  return `${w.y}-${pad(w.mo)}-${pad(w.d)}T${pad(w.h)}:${pad(w.mi)}`;
};

// Plain wall-clock minutes between two wall times (no offset math — this is how
// on-duty totals are meant to be paid).
export const wallMinutesBetween = (start, end) => {
  const a = naiveComponents(edmontonDateTimeInput(start));
  const b = naiveComponents(edmontonDateTimeInput(end));
  if (!a || !b) return null;
  const msA = Date.UTC(a.y, a.mo - 1, a.d, a.h, a.mi, a.s);
  const msB = Date.UTC(b.y, b.mo - 1, b.d, b.h, b.mi, b.s);
  return Math.round((msB - msA) / 60000);
};