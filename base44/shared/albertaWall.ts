// ── Edmonton (America/Edmonton) wall-clock helpers — BACKEND ─────────────────
// OWNER DIRECTIVE (Nov 1 2026): Alberta did NOT go permanent UTC-6. The Nov 1
// fall-back happened normally and the province keeps the ordinary DST cycle
// (-6 MDT / -7 MST). Every hardcoded "permanent UTC-6 from Nov 1 2026" rule in
// this app was FALSE and shifted everything an hour late from Nov 1 onward.
//
// Rule from here on: NEVER hardcode an offset and NEVER hardcode a transition
// date. Ask the tz database through Intl with timeZone 'America/Edmonton'.
//
// Storage convention: wall-clock values are stored NAIVE ("YYYY-MM-DDTHH:mm" —
// no Z, no offset) and are never converted on the way in or out. Legacy ISO-Z
// rows are still READ correctly (they resolve to an instant, then to Edmonton
// wall), so no history migration is needed.
//
// Once-a-year ambiguity: on the fall-back night the 01:00–02:00 wall hour occurs
// twice. Naive storage cannot tell the two apart; that is accepted on purpose —
// paying wall-clock hours is the intended behaviour and payroll math is
// unaffected for every other hour of the year.

// WHY 'America/Denver' AND NOT 'America/Edmonton':
// Alberta observes the ordinary North American Mountain-Time DST rule (2nd Sun
// Mar 02:00 -> 1st Sun Nov 02:00, -6 MDT / -7 MST) — the rule America/Denver
// encodes in ICU/tzdata. Some tzdata builds additionally ship an Alberta-only
// override that skips the Nov 1 2026 fall-back and freezes the province on MDT
// (-6); that override does not match reality (owner-verified Nov 1 2026: server
// clock 20:53Z = 13:53 MST, and a tzdata build with the override reports 14:53
// for the same instant). Denver carries the standard Mountain rule on every
// build: identical to Edmonton when the database is right, and still right when
// the database carries the override. No offset or transition date is hardcoded.
const TZ = 'America/Denver';

const pad = (v: number) => String(v).padStart(2, '0');

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

// UTC instant -> Edmonton wall components
export const edmontonWallParts = (date: Date = new Date()) => {
  const p: Record<string, string> = {};
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

// UTC instant -> naive Edmonton wall string "YYYY-MM-DDTHH:mm:ss"
export const edmontonWallString = (date: Date = new Date()) => {
  const w = edmontonWallParts(date);
  return `${w.y}-${pad(w.mo)}-${pad(w.d)}T${pad(w.h)}:${pad(w.mi)}:${pad(w.s)}`;
};

// Edmonton calendar date "YYYY-MM-DD" for an instant
export const edmontonTodayKey = (date: Date = new Date()) => DAY_FMT.format(date);

// Square Balances business day (owner rule Oct 9 2026): the day rolls at 05:00
// Edmonton — between midnight and 5am, sales/collections still belong to the
// previous calendar day's bucket.
export const edmontonBusinessDayKey = (date: Date = new Date()) => {
  const w = edmontonWallParts(date);
  if (w.h >= 5) return `${w.y}-${pad(w.mo)}-${pad(w.d)}`;
  const prev = new Date(Date.UTC(w.y, w.mo - 1, w.d) - 86400000);
  return prev.toISOString().slice(0, 10);
};

// Is a timestamp string naive (no trailing Z / no +/- offset)?
export const isNaiveTimestamp = (str: unknown) =>
  typeof str === 'string' && !/Z$/i.test(str) && !/[+-]\d{2}:?\d{2}$/.test(str);

const naiveComponents = (str: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(str));
  if (!m) return null;
  return {
    y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]),
    h: Number(m[4]), mi: Number(m[5]), s: Number(m[6] || 0),
  };
};

// Minutes east of UTC that Edmonton is observing at a given instant
const offsetMsAt = (utcMs: number) => {
  const w = edmontonWallParts(new Date(utcMs));
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(utcMs / 1000) * 1000;
};

// Naive Edmonton wall string -> true UTC epoch ms (resolved through Intl, so the
// offset is whatever the tz database says for that instant — no hardcoding).
export const naiveWallToUtcMs = (naive: string) => {
  const c = naiveComponents(naive);
  if (!c) {
    const t = new Date(naive).getTime();
    return Number.isNaN(t) ? null : t;
  }
  const wallAsUtc = Date.UTC(c.y, c.mo - 1, c.d, c.h, c.mi, c.s);
  // Two convergent passes settle both sides of a DST boundary.
  let utc = wallAsUtc - offsetMsAt(wallAsUtc);
  utc = wallAsUtc - offsetMsAt(utc);
  utc = wallAsUtc - offsetMsAt(utc);
  return utc;
};

// Any stored timestamp -> true UTC epoch ms. Naive strings are Edmonton wall;
// ISO strings with Z/offset are already true instants.
export const utcMsOf = (timestamp: string) => {
  if (!timestamp) return null;
  return isNaiveTimestamp(timestamp) ? naiveWallToUtcMs(timestamp) : new Date(timestamp).getTime();
};

// Any stored timestamp -> naive Edmonton wall string "YYYY-MM-DDTHH:mm:ss".
// Naive input is passed through untouched (never converted); legacy ISO-Z input
// is resolved to Edmonton wall so old rows keep reading correctly.
export const wallStringOf = (timestamp: string) => {
  if (!timestamp) return null;
  if (isNaiveTimestamp(timestamp)) {
    const c = naiveComponents(timestamp);
    if (!c) return null;
    return `${c.y}-${pad(c.mo)}-${pad(c.d)}T${pad(c.h)}:${pad(c.mi)}:${pad(c.s)}`;
  }
  const d = new Date(timestamp);
  return Number.isNaN(d.getTime()) ? null : edmontonWallString(d);
};

// Plain wall-clock minutes from start to end (both wall times, no offset math).
export const wallMinutesBetween = (start: string, end: string) => {
  const a = naiveComponents(wallStringOf(start) || '');
  const b = naiveComponents(wallStringOf(end) || '');
  if (!a || !b) return null;
  const msA = Date.UTC(a.y, a.mo - 1, a.d, a.h, a.mi, a.s);
  const msB = Date.UTC(b.y, b.mo - 1, b.d, b.h, b.mi, b.s);
  return Math.round((msB - msA) / 60000);
};

// Round a naive wall time to the nearest 5-minute mark on the WALL clock.
// on_duty -> floor (previous mark), on_break/off_duty -> ceil (next mark).
// Seconds are ignored (owner rule Oct 29 2026); a minute already on a 5-minute
// mark is left alone. Returns "YYYY-MM-DDTHH:mm".
export const roundWallTo5Min = (wall: string, direction: 'floor' | 'ceil' = 'floor') => {
  const c = naiveComponents(wall);
  if (!c) return wall;
  const FIVE = 5 * 60000;
  const asUtc = Date.UTC(c.y, c.mo - 1, c.d, c.h, c.mi); // seconds dropped
  const rounded = asUtc % FIVE === 0
    ? asUtc
    : (direction === 'floor' ? Math.floor(asUtc / FIVE) * FIVE : Math.ceil(asUtc / FIVE) * FIVE);
  const r = new Date(rounded);
  return `${r.getUTCFullYear()}-${pad(r.getUTCMonth() + 1)}-${pad(r.getUTCDate())}T${pad(r.getUTCHours())}:${pad(r.getUTCMinutes())}`;
};