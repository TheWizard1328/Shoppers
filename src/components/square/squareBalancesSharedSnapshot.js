// SHARED ONLINE SNAPSHOT for the Square Balances summary (owner spec Oct 9
// 2026): "create an online entity and an offline IDB ... everything on the
// page that gets calculated or pulled has the statistical numbers for a
// quick rapid load ... broadcast the entire database to promote the updates".
//
// MODEL: the owner device's badge pipeline is the single writer. Every fresh
// (non-cached) compute publishes the WHOLE finished summary as ONE record —
// card balances, loan/folder math, 7-day averages, outstanding items with
// patient/store/driver/amount/fees, delivery credits, payouts, config. Other
// devices (and the same device's other surfaces) get the entity WS ping, pull
// the single record whole, paint UI from it and refresh their IDB mirror.
// No per-item events, no partial states, no merge conflicts — one record, one
// monotonic version (Date.now()). Version is the echo guard: applying a
// remote snapshot never triggers a publish (publishes happen only on fresh
// local computes), and a device never re-applies a version it already has.
//
// ACCESS: patient ids without the patient database are just system strings and
// COD amounts are numbers — the owner confirmed this is not sensitive data, so
// the entity carries no extra restrictions (same posture as the other Square
// entities; rls {}).
import { base44 } from '@/api/base44Client';

/**
 * JSON-plain payload from a summary data object. Same shape the IDB snapshot
 * (persistSnapshotModule in useSquareBalancesSummary) stores, so
 * deserializeSummary() rebuilds either one identically. Maps → entry arrays.
 */
export const buildSummaryPayload = (data) => {
  if (!data) return null;
  return {
    byLocId: [...(data.byLocId || new Map())],
    payoutsByLoc: [...(data.payoutsByLoc || new Map())],
    storeToLoc: [...(data.storeToLoc || new Map())],
    weeklyByStore: [...(data.weeklyByStore || new Map())],
    storeNames: [...(data.storeNames || new Map())],
    dailyRemainingByStore: [...(data.dailyRemainingByStore || new Map())],
    codOutstandingDetailed: data.codOutstandingDetailed || {},
    config: data.config || null,
    configRecordId: data.configRecordId || null,
    deliveryCredits: [...(data.deliveryCredits || new Map())],
    sales: data.sales || [],
    payouts: data.payouts || [],
    savedAt: new Date().toISOString(),
  };
};

/**
 * Publish the whole summary as the single shared record. Upserts: fetches the
 * current record (highest version), updates it in place, creates on first
 * publish. Returns the published version, or null on failure (caller just
 * skips — the next fresh compute will try again).
 */
export const publishSharedSnapshot = async (data, { version, userId, userName } = {}) => {
  try {
    const payload = buildSummaryPayload(data);
    if (!payload) return null;
    const ver = Number(version || Date.now());
    const rec = { payload, version: ver, computed_at: new Date().toISOString(), computed_by: userId || null, computed_by_name: userName || null };
    let existing = null;
    try {
      const rows = await base44.entities.SquareBalancesSnapshot.list('-version', 10, 0);
      existing = (rows || []).filter(Boolean).sort((a, b) => Number(b?.version || 0) - Number(a?.version || 0))[0] || null;
    } catch { /* first publish / transient — create below */ }
    if (existing?.id) await base44.entities.SquareBalancesSnapshot.update(existing.id, rec);
    else await base44.entities.SquareBalancesSnapshot.create(rec);
    return ver;
  } catch (e) {
    console.error('[squareBalancesSharedSnapshot] publish failed:', e);
    return null;
  }
};

/**
 * Pull the newest shared snapshot record (whole database), or null.
 */
export const fetchLatestSharedSnapshot = async () => {
  try {
    const rows = await base44.entities.SquareBalancesSnapshot.list('-version', 10, 0);
    return (rows || []).filter(Boolean).sort((a, b) => Number(b?.version || 0) - Number(a?.version || 0))[0] || null;
  } catch (e) {
    return null;
  }
};

/**
 * Subscribe to snapshot entity broadcasts (other devices' publishes). The
 * event payload is not trusted for rendering — the callback should pull the
 * whole record (one cheap read) and apply it.
 */
export const subscribeSharedSnapshot = (cb) => {
  try {
    return base44.entities.SquareBalancesSnapshot.subscribe(() => { try { cb(); } catch {} });
  } catch { return null; }
};
