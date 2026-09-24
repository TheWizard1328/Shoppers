/**
 * Alberta (America/Edmonton) wall-clock math — 100% pure UTC arithmetic.
 *
 * ZERO Intl usage, ZERO system-local Date getters (getFullYear/getHours/etc.).
 * Some devices in the fleet have broken or premature timezone databases (one PC
 * reports America/Edmonton as UTC-7 while true Edmonton is still on MDT/-6
 * until the legislated change), so nothing in this module may trust the
 * runtime's timezone engine. Every conversion here is computed from the UTC
 * instant plus the legislated Alberta DST rule, so results are byte-identical
 * on every device.
 *
 * Alberta rule (owner-confirmed Sep 23 2026):
 *   - Through October 2026: normal North American DST rule
 *     (2nd Sunday of March 2:00 local -> 1st Sunday of November 2:00 local; -6 MDT / -7 MST)
 *   - From Nov 1 2026 (08:00 UTC = 2:00 local): the fall-back is SKIPPED —
 *     Alberta stays on permanent UTC-6 (MDT) year-round.
 */

// Moment the Nov 2026 fall-back is skipped: 1st Sunday Nov 2026, 2:00 local MDT = 08:00 UTC
export const ALBERTA_PERMANENT_UTC6_MS = Date.UTC(2026, 10, 1, 8, 0, 0);

// UTC instant -> Alberta offset (-6 / -7) for that instant
export const albertaOffsetHoursAt = (utcMs) => {
  if (utcMs >= ALBERTA_PERMANENT_UTC6_MS) return -6; // permanent MDT from Nov 1 2026
  const y = new Date(utcMs).getUTCFullYear();
  const firstSundayDate = (monthIdx) => 1 + ((7 - new Date(Date.UTC(y, monthIdx, 1)).getUTCDay()) % 7);
  const dstStartMs = Date.UTC(y, 2, firstSundayDate(2) + 7, 9, 0, 0);  // 2nd Sun Mar 2:00 MST = 09:00 UTC
  const dstEndMs = Date.UTC(y, 10, firstSundayDate(10), 8, 0, 0);       // 1st Sun Nov 2:00 MDT = 08:00 UTC
  return utcMs >= dstStartMs && utcMs < dstEndMs ? -6 : -7;
};

// Alberta wall date (y, mo 1-based, d) -> offset for that wall-clock day
export const albertaOffsetHoursForWallDate = (y, mo, d) => {
  if (Date.UTC(y, mo - 1, d) >= ALBERTA_PERMANENT_UTC6_MS) return -6;
  const firstSundayDate = (monthIdx) => 1 + ((7 - new Date(Date.UTC(y, monthIdx, 1)).getUTCDay()) % 7);
  const afterMar = mo - 1 > 2 || (mo - 1 === 2 && d >= firstSundayDate(2) + 7);
  const beforeNov = mo - 1 < 10 || (mo - 1 === 10 && d < firstSundayDate(10));
  return afterMar && beforeNov ? -6 : -7;
};

// UTC instant -> Alberta wall components
export const toEdmontonWall = (date) => {
  const local = new Date(date.getTime() + albertaOffsetHoursAt(date.getTime()) * 3600000);
  return {
    y: local.getUTCFullYear(),
    mo: local.getUTCMonth() + 1,
    d: local.getUTCDate(),
    h: local.getUTCHours(),
    mi: local.getUTCMinutes(),
    s: local.getUTCSeconds()
  };
};

// Alberta wall components -> UTC Date
export const edmontonWallToUTC = (y, mo, d, h, mi, s = 0) =>
  new Date(Date.UTC(y, mo - 1, d, h, mi, s) - albertaOffsetHoursForWallDate(y, mo, d) * 3600000);

const pad = (v) => String(v).padStart(2, '0');

// UTC instant -> naive Edmonton wall string "YYYY-MM-DDTHH:mm:ss" (storage convention
// for client-generated wall timestamps like actual_delivery_time)
export const edmontonWallString = (date) => {
  const w = toEdmontonWall(date);
  return `${w.y}-${pad(w.mo)}-${pad(w.d)}T${pad(w.h)}:${pad(w.mi)}:${pad(w.s)}`;
};

// Is a timestamp string naive (no Z / no +/- offset)?
export const isNaiveTimestamp = (str) =>
  typeof str === 'string' && !/Z$/i.test(str) && !/[+-]\d{2}:\d{2}$/.test(str);

// Parse a timestamp that may be a naive Edmonton wall string OR a real UTC/offset
// ISO string, into a true UTC Date. Naive strings are Edmonton wall time by
// convention (see generateCompletionTimestamp / actual_delivery_time) — NOT
// device-local time. Device-local parsing was the bug: machines with premature
// tz data misread naive strings by an hour.
export const parseAnyTimestamp = (str) => {
  if (!str) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(str));
  if (!m) return new Date(str);
  const [, y, mo, d, h, mi, s] = m.map(Number);
  if (isNaiveTimestamp(str)) {
    return edmontonWallToUTC(y, mo, d, h, mi, s || 0);
  }
  return new Date(str);
};
