// squarePurgeBookkeepingTxs — one-off / maintenance utility.
// Deletes STALE bookkeeping SquareTransaction records:
//   status === 'pending' AND no square_transaction_id (never matched a real
//   Square order) AND the catalog item they were bookkeeping for is no longer
//   live in the Square catalog (by object id or name+amount signature).
// Kept records: anything with a real square_transaction_id (real POS usage),
// and bookkeeping whose referenced item is still live.
// Safe to re-run any time; idempotent.
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const SB = 'https://connect.squareup.com';
const SV = '2025-01-23';
class HE extends Error { constructor(s, m) { super(m); this.status = s; } }
const nt = (v) => String(v || '').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sig = (name, cents) => `${nt(name).replace(/\s+/g, ' ').toLowerCase()}::${Math.round(Number(cents) || 0)}`;

async function sf(path, method, token, body) {
  let le = null;
  for (let a = 1; a <= 3; a++) {
    try {
      const r = await fetch(`${SB}${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Square-Version': SV }, body: body ? JSON.stringify(body) : undefined });
      const t = await r.text(); const j = t ? JSON.parse(t) : {};
      if (!r.ok) { const m = j?.errors?.map((e) => e.detail).join(', ') || `Square API error ${r.status}`; le = new HE(r.status, m); if (a < 3 && [408, 429, 500, 502, 503, 504].includes(r.status)) { await sleep(400 * a); continue; } throw le; }
      return j;
    } catch (e) { le = e; if (a < 3 && [408, 429, 500, 502, 503, 504].includes(e?.status)) { await sleep(400 * a); continue; } throw le; }
  }
  throw le || new Error('Square API failed');
}

async function listLiveCatalog(token) {
  const objs = []; let cursor;
  do {
    const j = await sf('/v2/catalog/search', 'POST', token, { object_types: ['ITEM'], include_deleted_objects: false, archived_state: 'ARCHIVED_STATE_NOT_ARCHIVED', limit: 1000, cursor });
    objs.push(...(j.objects || [])); cursor = j.cursor; if (cursor) await sleep(200);
  } while (cursor);
  return objs;
}

Deno.serve(async (req) => {
  try {
    const b44 = createClientFromRequest(req);
    const u = await b44.auth.me().catch(() => null);
    if (!u) throw new HE(401, 'Unauthorized');
    const token = Deno.env.get('SQUARE_ACCESS_TOKEN');
    if (!token) throw new HE(500, 'Square not configured');

    // 1) Live catalog: object ids + name/amount signatures
    const live = await listLiveCatalog(token);
    const liveIds = new Set(live.map((i) => nt(i?.id)).filter(Boolean));
    const liveSigs = new Set();
    for (const item of live) {
      const vs = item?.item_data?.variations || [];
      const v = vs.find((e) => e?.item_variation_data?.price_money?.amount != null) || vs[0];
      const cents = Math.round(Number(v?.item_variation_data?.price_money?.amount || 0));
      const name = item?.item_data?.name || '';
      if (name) liveSigs.add(sig(name, cents));
    }

    // 2) All pending transactions without a real square_transaction_id
    const stale = []; let examined = 0; let keptLive = 0; let keptReal = 0;
    let all = [];
    let pageSkip = 0;
    while (true) {
      const page = await b44.asServiceRole.entities.SquareTransaction.filter({ status: 'pending' }, '-created_date', 500, pageSkip).catch(() => []);
      if (!page?.length) break;
      all = all.concat(page);
      if (page.length < 500) break;
      pageSkip += 500;
      if (pageSkip > 5000) break;
    }
    for (const t of all) {
      examined++;
      const realTxId = nt(t?.square_transaction_id);
      const objId = nt(t?.square_catalog_object_id);
      const txSig = sig(t?.item_name, t?.amount_cents ?? Math.round(Number(t?.amount || 0) * 100));
      if (realTxId) { keptReal++; continue; }
      if ((objId && liveIds.has(objId)) || (t?.item_name && liveSigs.has(txSig))) { keptLive++; continue; }
      stale.push(t.id);
    }

    // 3) Delete stale in batches of 10 (rate-friendly)
    let deleted = 0; let failed = 0;
    for (let i = 0; i < stale.length; i += 10) {
      const chunk = stale.slice(i, i + 10);
      const results = await Promise.all(chunk.map((id) => b44.asServiceRole.entities.SquareTransaction.delete(id).then(() => true).catch(() => false)));
      deleted += results.filter(Boolean).length;
      failed += results.filter((x) => !x).length;
      if (i + 10 < stale.length) await sleep(50);
    }

    return Response.json({
      success: true,
      liveCatalogItems: live.length,
      examinedPending: examined,
      keptRealPosTxs: keptReal,
      keptLiveItemBookkeeping: keptLive,
      staleDeleted: deleted,
      failedDeletes: failed,
    });
  } catch (error) {
    return Response.json({ error: error?.message || 'Error' }, { status: error?.status || 500 });
  }
});
