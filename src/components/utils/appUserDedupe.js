/**
 * appUserDedupe
 *
 * ONE canonical AppUser row per user_id.
 *
 * WHY (owner report Nov 15 2026): a driver's display name must always come from
 * AppUser.user_name — never from the platform login profile (`User.full_name`,
 * e.g. "Robert Tauber"). The offline app_users store can hold TWO rows for the
 * same person (the real AppUser row, plus an older merged-user row keyed by a
 * different id), and every non-unique lookup used to return whichever row the
 * store enumerated first. Robert showed as "Robert Tauber" on one boot and
 * "Robert" the next, and the label flipped again as soon as another driver was
 * selected and the lists were rebuilt.
 *
 * A real AppUser row carries app_roles + user_name; a leftover merged row
 * carries the platform name only. Rank by that, then by the newest timestamp.
 */

const nameOf = (r) => String(r?.user_name ?? '').trim();

const tsOf = (r) => {
  const t = Date.parse(r?.updated_date || r?.created_date || 0);
  return Number.isFinite(t) ? t : 0;
};

const rankOf = (r) =>
  (Array.isArray(r?.app_roles) && r.app_roles.length ? 4 : 0) +
  (nameOf(r) ? 2 : 0) +
  (r?.company_id ? 1 : 0);

/** Pick the one row that should represent a user out of every row found for them. */
export const pickCanonicalAppUser = (rows) => {
  const list = (Array.isArray(rows) ? rows : []).filter(Boolean);
  if (list.length === 0) return null;
  if (list.length === 1) return list[0];
  return list.reduce((best, cur) => {
    const cmp = rankOf(cur) - rankOf(best);
    if (cmp !== 0) return cmp > 0 ? cur : best;
    return tsOf(cur) > tsOf(best) ? cur : best;
  }, list[0]);
};

/** Collapse an AppUser array to one canonical row per user_id. */
export const dedupeAppUsers = (rows) => {
  const groups = new Map();
  (Array.isArray(rows) ? rows : []).forEach((r) => {
    if (!r) return;
    const key = String(r.user_id || r.id || '');
    if (!key) return;
    if (!groups.has(key)) groups.set(key, [r]);
    else groups.get(key).push(r);
  });
  return Array.from(groups.values()).map((group) =>
    group.length === 1 ? group[0] : pickCanonicalAppUser(group)
  );
};