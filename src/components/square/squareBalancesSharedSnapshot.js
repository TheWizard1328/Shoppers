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

// TRANSPORT PING (Nov 3 2026): a tiny record whose only job is to broadcast.
// Its payload is null and it points at the silently-written payload record.
let pingRecordId = null;
const pingSharedSnapshot = async ({ version, snapshotId }) => {
  const rec = { payload: null, ping: true, version: Number(version) || Date.now(), snapshot_id: snapshotId || null, computed_at: new Date().toISOString() };
  if (pingRecordId) {
    try { await base44.entities.SquareBalancesSnapshot.update(pingRecordId, rec); return; } catch { pingRecordId = null; }
  }
  const rows = await base44.entities.SquareBalancesSnapshot.list('-version', 20, 0).catch(() => []);
  const existingPing = (rows || []).find((r) => r?.ping === true);
  if (existingPing?.id) {
    pingRecordId = existingPing.id;
    await base44.entities.SquareBalancesSnapshot.update(existingPing.id, rec);
  } else {
    const created = await base44.entities.SquareBalancesSnapshot.create(rec);
    pingRecordId = created?.id || null;
  }
};

/**
 * PAYLOAD SHARDS (owner spec Nov 3 2026): the shared record stores the summary
 * as 8000-char slices p1..pN so NO field trips the 10 KB realtime transport
 * limit. That limit was stubbing every publish on the wire ("Realtime broadcast
 * for SquareBalancesSnapshot#… was oversize and got slimmed for transport") on
 * all 8 store PCs. The wire now carries only a change marker; each device pulls
 * this record by id and hydrates its own offline mirror here. Legacy records
 * that still carry the inline `payload` are handled unchanged.
 */
export const hydrateSnapshotRecord = (rec) => {
  if (!rec || typeof rec !== 'object') return rec;
  if (rec.payload) return rec;
  const n = Number(rec.parts_count || 0);
  if (!n) return rec;
  let json = '';
  for (let i = 1; i <= n; i++) json += String(rec[`p${i}`] ?? '');
  try { return { ...rec, payload: JSON.parse(json) }; } catch { return rec; }
};

// ── PART RECORDS (owner report Nov 4 2026 — "still getting so many rate limits") ─
// The p1..pN shards lived inside ONE record. Each field was under 10 KB, but the
// WHOLE record was ~30 KB, so every write still broadcast it, the platform
// stubbed it ("Realtime broadcast for SquareBalancesSnapshot#… was oversize"),
// and EVERY device answered that warning with a 30 KB .get() — the read storm
// that saturated the account pool. Payload text now lives in SEPARATE small
// records (part_of → anchor id), so nothing that reaches the wire is over the
// transport limit.
const PART_SIZE = 8000;
const MAX_PARTS = 24;

const splitPayload = (payload) => {
  let json = 'null';
  try { json = JSON.stringify(payload ?? null) || 'null'; } catch { json = 'null'; }
  const chunks = [];
  for (let i = 0; i < json.length; i += PART_SIZE) chunks.push(json.slice(i, i + PART_SIZE));
  if (chunks.length === 0) chunks.push('null');
  return chunks.length > MAX_PARTS ? [json.slice(0, PART_SIZE)] : chunks; // pathological: one part, hydration fails safe
};

const loadParts = async (anchorId) => {
  if (!anchorId) return [];
  // LINK FIELD IS snapshot_id (already in the schema and filterable) — the
  // first cut filtered on a brand-new `part_of` field and the API rejected the
  // query outright ("unknown_filter_field"). snapshot_id carries the anchor id.
  const rows = await base44.entities.SquareBalancesSnapshot.filter({ snapshot_id: anchorId }, 'part_index', 32, 0).catch(() => []);
  return (rows || []).filter((r) => r && r.part_text != null).sort((a, b) => Number(a.part_index || 0) - Number(b.part_index || 0));
};

/**
 * Hydrate any snapshot record shape into { ...rec, payload }:
 *   - legacy inline payload        (before Nov 3)
 *   - legacy in-record p1..pN       (Nov 3/4, still oversize on the wire)
 *   - part records (part_of anchor) (current)
 */
export const readSnapshotPayload = async (rec) => {
  if (!rec || typeof rec !== 'object') return null;
  if (rec.payload) return rec;
  // ANCHOR / PART shape first: an anchor record may still carry CLEARED legacy
  // p1..pN keys ('' placeholders) and must never be mistaken for old shards.
  if (rec.anchor || rec.part_text != null || Number(rec.parts_count || 0) > 0) {
    const anchorId = rec.part_text != null ? rec.snapshot_id : rec.id;
    const parts = await loadParts(anchorId);
    if (parts.length > 0) {
      const json = parts.map((r) => String(r.part_text || '')).join('');
      try { return { ...rec, id: anchorId, payload: JSON.parse(json) }; } catch { /* fall through */ }
    }
    return null;
  }
  // Legacy in-record shards (pre-Nov 4 records).
  if (rec.p1 != null) {
    const legacy = hydrateSnapshotRecord(rec);
    return legacy?.payload ? legacy : null;
  }
  return null;
};

/** Write the payload as small part records anchored to `anchorId`. */
const writeParts = async (anchorId, payload, version) => {
  const chunks = splitPayload(payload);
  const existing = await loadParts(anchorId);
  const byIndex = new Map(existing.map((r) => [Number(r.part_index || 0), r]));
  for (let i = 0; i < chunks.length; i++) {
    const row = { snapshot_id: anchorId, part_index: i, part_text: chunks[i], version, ping: false, anchor: false };
    const found = byIndex.get(i);
    try {
      if (found?.id) await base44.entities.SquareBalancesSnapshot.update(found.id, row);
      else await base44.entities.SquareBalancesSnapshot.create(row);
    } catch { /* a missing part just means this publish is incomplete; next publish rewrites it */ }
    byIndex.delete(i);
  }
  // Drop parts the new payload no longer has.
  for (const stale of byIndex.values()) {
    base44.entities.SquareBalancesSnapshot.delete(stale.id).catch(() => {});
  }
};

const fetchTopRows = async (limit = 10) => {
  const rows = await base44.entities.SquareBalancesSnapshot.list('-version', limit, 0);
  return (rows || []).filter(Boolean).sort((a, b) => Number(b?.version || 0) - Number(a?.version || 0));
};

export const publishSharedSnapshot = async (data, { version, userId, userName, deviceName } = {}) => {
  try {
    const payload = buildSummaryPayload(data);
    if (!payload) return null;
    const ver = Number(version || Date.now());

    // SILENT PUBLISH (owner report Nov 3 2026): the payload record is far over
    // the realtime transport limit (10 KB per field), so writing it from the
    // client broadcast a STUB to every device. squareBalancesCompute now stores
    // it with the service role (no broadcast at all) and we follow up with a
    // tiny ping record — that is the only thing that hits the wire.
    try {
      const res = await base44.functions.invoke('squareBalancesCompute', {
        publish_payload: payload,
        publish_version: ver,
        computed_by: userId || null,
        computed_by_name: userName || null,
        computed_by_device: deviceName || null,
      });
      const bodyOut = res?.data || res || {};
      const published = Number(bodyOut?.published || 0) || null;
      if (published) {
        await pingSharedSnapshot({ version: published, snapshotId: bodyOut?.snapshot_id || null });
        return published;
      }
    } catch (e) {
      console.warn('[squareBalancesSharedSnapshot] silent publish attempt failed:', e?.message || e);
    }

    // Fallback write also uses SHARDS (owner spec Nov 3 2026) — a client write
    // of the raw payload was the last way an oversize field could still reach
    // the wire and stub every device's copy.
    const rec = { anchor: true, parts_count: 0, payload: null, version: ver,
      // CLEAR the legacy in-record shards: leaving them here kept the whole
      // record ~30 KB, so every write still broadcast an oversize payload.
      ...Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`p${i + 1}`, ''])), computed_at: new Date().toISOString(), computed_by: userId || null, computed_by_name: userName || null, computed_by_device: deviceName || null, ping: false };

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

    let anchorId = existing?.id || null;
    if (anchorId) {
      await base44.entities.SquareBalancesSnapshot.update(anchorId, rec);
    } else {
      const created = await base44.entities.SquareBalancesSnapshot.create(rec);
      anchorId = created?.id || null;
    }
    if (anchorId) await writeParts(anchorId, payload, ver);

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
    // A 429 here means the account-wide write limit is exhausted — the
    // snapshot is ephemeral and the next fresh compute retries, so just bail
    // silently. console.error would re-enqueue into RemoteLogEntry, competing
    // for the very pool that's exhausted (noise filter throttles it, but
    // skipping the call entirely is cleaner).
    if (e && /\b429\b|traffic volume limit exceeded|rate limit exceeded/i.test(String(e?.message || e?.detail || e))) {
      return null;
    }
    console.error('[squareBalancesSharedSnapshot] publish failed:', e);
    return null;
  }
};

/**
 * Pull the newest shared snapshot record (whole database), or null.
 */
export const fetchLatestSharedSnapshot = async (preferredId = null) => {
  // BY-ID FIRST (Nov 3 2026): a ping tells us exactly which record to read, so
  // the pull is ONE record read instead of a list that drags whole payloads.
  if (preferredId) {
    try {
      const rec = await readSnapshotPayload(await base44.entities.SquareBalancesSnapshot.get(preferredId));
      if (rec?.payload) return rec;
    } catch { /* fall through to the list */ }
  }
  try {
    // Ping / part rows carry no payload — never treat one as the snapshot.
    const rows = await fetchTopRows(8);
    for (const row of rows) {
      if (!row || row.ping === true || row.part_text != null) continue;
      const hydrated = await readSnapshotPayload(row);
      if (hydrated?.payload) return hydrated;
    }
    return null;
  } catch (e) {
    return null;
  }
};

/**
 * Subscribe to snapshot entity broadcasts (other devices' publishes). The
 * event payload is not trusted for rendering — the callback should pull the
 * whole record (one cheap read) and apply it.
 */
const PULL_THROTTLE_MS = 20000;
let pullTimer = null;
let pullPendingId = null;
let lastPullAt = 0;

const schedulePull = (cb, snapshotId) => {
  if (snapshotId) pullPendingId = snapshotId;
  if (pullTimer) return; // already queued — coalesces a burst into one pull
  const wait = Math.max(0, PULL_THROTTLE_MS - (Date.now() - lastPullAt));
  pullTimer = setTimeout(() => {
    pullTimer = null;
    lastPullAt = Date.now();
    const id = pullPendingId;
    pullPendingId = null;
    try { cb(id); } catch { /* subscriber error is its own problem */ }
  }, wait);
};

export const subscribeSharedSnapshot = (cb) => {
  try {
    // Ignore DELETE events: the dupe-cleanup deletes (and any future purge)
    // must NOT trigger a pull on every device — that fan-out was part of the
    // Oct 14 rate-limit feedback loop. Only create/update publishes matter.
    return base44.entities.SquareBalancesSnapshot.subscribe((event) => {
      try {
        if (event?.type === 'delete') return;
        const row = event?.data || {};
        // PART records are payload slices: ignore them entirely, or every part
        // write would look like a fresh snapshot.
        if (row.part_text != null || row.part_index != null) return;
        // A ping names the record to pull; an anchor carries it itself.
        if (row.ping !== true && !row.anchor) return;
        // Coalesce bursts (all 8 store PCs publishing together) into ONE pull
        // every 20s instead of one per event — the pull is a paid GET.
        schedulePull(cb, row.snapshot_id || row.id || null);
      } catch {}
    });
  } catch { return null; }
};