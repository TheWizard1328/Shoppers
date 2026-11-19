// ROW-LEVEL SNAPSHOT for the Square Balances page (owner request Nov 18 2026).
//
// WHY: the summary snapshot (IDB `square_balances_summary` + the shared
// SquareBalancesSnapshot entity) only ever carried MONEY MATH — card/loan/
// folder estimates, delivery credits, payouts, COD outstanding detail. The four
// row sections (Collected / Uncollected Today / Uncollected Past / Awaiting
// Pickup) were rebuilt from live reads on every single load:
//   • Collected-today   → live Delivery reads + Store/Config/Patient lists
//   • the other three   → a live SquareCatalogItems sweep (500/page, 12 pages)
//                         cached only in module memory with a 90s TTL, so every
//                         reload started from zero
// The page therefore painted cards instantly and then "slowly filled in" the
// rows. This module holds the last computed rows so the SAME payload that
// carries the cards also carries the rows — one snapshot, instant page.
//
// The holder is read by buildSummaryPayload() (squareBalancesSharedSnapshot),
// which is what both the IDB snapshot and the shared entity publish use, so a
// row update rides the normal publish path and reaches other devices' offline
// databases through the existing ping + pull.
//
// SIZE: the shared payload is stored as 8000-char parts (MAX_PARTS 24 ≈ 192 KB).
// Rows are capped so the snapshot can never crowd out the money math: newest
// dates win, and past-uncollected (always the bulk) is trimmed first.

const MAX_ROWS = 300;
const MAX_BYTES = 70000;

let current = { codCollectedToday: {}, catalogUncollected: {}, savedAt: null };

export const getRowsSnapshot = () => current;

const countRows = (byLoc) =>
  Object.values(byLoc || {}).reduce((n, rows) => n + (Array.isArray(rows) ? rows.length : 0), 0);

const rowDate = (r) => String(r?.date || r?.delivery_date || '').slice(0, 10);

/** Keep the newest `keep` rows across all locations, same shape per row. */
const capByLoc = (byLoc, keep) => {
  const all = [];
  for (const [loc, rows] of Object.entries(byLoc || {})) {
    if (!Array.isArray(rows)) continue;
    for (const r of rows) all.push({ loc, r });
  }
  if (all.length <= keep) return byLoc || {};
  // Newest first; undated rows sort last so real dates always survive.
  all.sort((a, b) => String(rowDate(b.r)).localeCompare(String(rowDate(a.r))));
  const out = {};
  for (const { loc, r } of all.slice(0, Math.max(0, keep))) {
    if (!out[loc]) out[loc] = [];
    out[loc].push(r);
  }
  return out;
};

const sizeOf = (collected, catalog) =>
  JSON.stringify({ c: collected || {}, k: catalog || {} }).length;

/**
 * Store the rows the page just computed (already keyed by location id, exactly
 * the shape the sections render). Returns the stored snapshot.
 */
export const setRowsSnapshot = ({ codCollectedToday, catalogUncollected } = {}) => {
  let collected = capByLoc(codCollectedToday || {}, MAX_ROWS);
  let catalog = capByLoc(catalogUncollected || {}, MAX_ROWS);
  let bytes = sizeOf(collected, catalog);
  let guard = 0;
  // Byte guard: trim the bigger list by 20% until the rows fit the budget.
  while (bytes > MAX_BYTES && guard++ < 40) {
    const cN = countRows(collected);
    const kN = countRows(catalog);
    const before = bytes;
    if (kN >= cN) catalog = capByLoc(catalog, Math.floor(kN * 0.8));
    else collected = capByLoc(collected, Math.floor(cN * 0.8));
    bytes = sizeOf(collected, catalog);
    if (bytes >= before) break; // nothing left to trim
  }
  current = {
    codCollectedToday: collected,
    catalogUncollected: catalog,
    savedAt: new Date().toISOString(),
  };
  return current;
};

/** Cheap change signature so unchanged rows never re-persist or re-publish. */
export const rowsSignature = (snap = current) => {
  const part = (byLoc) =>
    Object.entries(byLoc || {})
      .sort(([a], [b]) => String(a).localeCompare(String(b)))
      .map(([loc, rows]) => {
        const list = Array.isArray(rows) ? rows : [];
        const last = list.reduce((m, r) => (String(rowDate(r)) > m ? String(rowDate(r)) : m), '');
        return `${loc}:${list.length}:${last}`;
      })
      .join('|');
  return `${part(snap?.codCollectedToday)}#${part(snap?.catalogUncollected)}`;
};
