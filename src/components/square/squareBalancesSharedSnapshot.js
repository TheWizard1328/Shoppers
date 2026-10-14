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
const PUBLISH_FETCH_ATTEMPTS = 3; // retries before giving up — NEVER blind-create on a failed fetch
const DUPE_DELETE_CAP = 5;        // opportunistic cleanup: max stale dupes deleted per publish

const fetchTopRows = async (limit = 10) => {
  const rows = await base44.entities.SquareBalancesSnapshot.list('-version', limit, 0);
  return (rows || []).filter(Boolean).sort((a, b) => Number(b?.version || 0) - Number(a?.version || 0));
};

export const publishSharedSnapshot = async (data, { version, userId, userName, deviceName } = {}) => {
  try {
    const payload = buildSummaryPayload(data);
    if (!payload) return null;
    const ver = Number(version || Date.now());
    const rec = { payload, version: ver, computed_at: new Date().toISOString(), computed_by: userId || null, computed_by_name: userName || null, computed_by_device: deviceName || null };

    // DUPLICATE-PROLIFERATION FIX (owner spec Oct 14 2026): ~600 snapshot records
    // accumulated because a FAILED fetch (429 storms) fell through to a blind
    // create. A skipped publish is harmless (snapshots are ephemeral; the next
    // fresh compute retries) — a duplicate record is not: every create
    // broadcasts to all running instances, each of which pulls the record.
    // So: retry the fetch; only create when the fetch SUCCEEDS and genuinely
    // returns zero records. Any fetch failure = abort, no write.
    let rows = null;
    let fetchOk = false;
    for (let attempt = 0; attempt < PUBLISH_FETCH_ATTEMPTS; attempt++) {
      try {
        rows = await fetchTopRows();
        fetchOk = true;
        break;
      } catch (e) {
        if (attempt < PUBLISH_FETCH_ATTEMPTS - 1) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
    }
    if (!fetchOk) {
      console.warn('[squareBalancesSharedSnapshot] publish aborted — could not read existing record (rate limited); will retry on next compute');
      return null;
    }
    const existing = rows[0] || null;

    if (existing?.id) {
      await base44.entities.SquareBalancesSnapshot.update(existing.id, rec);
    } else {
      await base44.entities.SquareBalancesSnapshot.create(rec);
    }

    // Opportunistic self-cleanup: delete a few stale duplicates each publish
    // (versions older than the record we just wrote). Capped so the delete
    // broadcasts fan out slowly; new-code subscribers ignore delete events.
    try {
      const stale = (rows || []).filter((r) => r?.id && r.id !== existing?.id && Number(r?.version || 0) < ver).slice(0, DUPE_DELETE_CAP);
      for (const dup of stale) {
        base44.entities.SquareBalancesSnapshot.delete(dup.id).catch(() => {});
      }
    } catch { /* cleanup is best-effort */ }

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
    return (await fetchTopRows())[0] || null;
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
    // Ignore DELETE events: the dupe-cleanup deletes (and any future purge)
    // must NOT trigger a pull on every device — that fan-out was part of the
    // Oct 14 rate-limit feedback loop. Only create/update publishes matter.
    return base44.entities.SquareBalancesSnapshot.subscribe((event) => {
      try {
        if (event?.type === 'delete') return;
        cb();
      } catch {}
    });
  } catch { return null; }
};
