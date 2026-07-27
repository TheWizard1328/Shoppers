// Self-contained Square COD delete — no squareCodCore dependency
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const SB = 'https://connect.squareup.com';
const SV = '2025-01-23';
const MR = 3; const RD = 400;
class HE extends Error { constructor(s, m) { super(m); this.status = s; } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nt = (v) => String(v || '').trim();
const irs = (s) => [408, 409, 429, 500, 502, 503, 504].includes(Number(s));
const et = () => { const t = Deno.env.get('SQUARE_ACCESS_TOKEN'); if (!t) throw new HE(500, 'Square not configured'); return t; };
// Soft auth — allows function-to-function calls from syncSquareCods
const ru = async (b) => {
  const ok = await b.auth.isAuthenticated().catch(() => false);
  if (!ok) return null;
  const u = await b.auth.me().catch(() => null);
  if (!u) throw new HE(401, 'Unauthorized');
  return u;
};

async function lc(t) {
  const o = []; let c;
  do {
    const r = await fetch(`${SB}/v2/catalog/search`, { method: 'POST', headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json', 'Square-Version': SV }, body: JSON.stringify({ object_types: ['ITEM'], include_deleted_objects: false, archived_state: 'ARCHIVED_STATE_NOT_ARCHIVED', limit: 1000, cursor: c }) });
    const x = await r.text(); const j = x ? JSON.parse(x) : {};
    o.push(...(j.objects || [])); c = j.cursor;
  } while (c);
  return o;
}

async function sdo(id, t) {
  if (!id) return { attempted: false, ok: false };
  let lf = null;
  for (let a = 1; a <= MR; a++) {
    try {
      const r = await fetch(`${SB}/v2/catalog/object/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${t}`, 'Square-Version': SV } });
      const x = await r.text(); let b = null; try { b = x ? JSON.parse(x) : null; } catch { b = x; }
      if (r.ok || r.status === 404) return { attempted: true, ok: true, status: r.status };
      lf = { attempted: true, ok: false, status: r.status };
      if (a < MR && irs(r.status)) { await sleep(RD * a); continue; }
      return lf;
    } catch (e) { lf = { attempted: true, ok: false, error: e?.message }; if (a < MR) { await sleep(RD * a); continue; } return lf; }
  }
  return lf || { attempted: true, ok: false };
}

Deno.serve(async (req) => {
  try {
    const b = createClientFromRequest(req);
    await ru(b);
    const { deliveryId, transactionId, catalogObjectId, reason } = await req.json().catch(() => ({}));
    if (!deliveryId && !transactionId && !catalogObjectId) throw new HE(400, 'Missing: deliveryId, transactionId, or catalogObjectId');

    const t = et();
    const related = [];
    let primary = null;

    if (transactionId) { const tx = await b.asServiceRole.entities.SquareTransaction.get(transactionId).catch(() => null); if (tx) { primary = tx; related.push(tx); } }
    if (deliveryId) { const dts = await b.asServiceRole.entities.SquareTransaction.filter({ delivery_id: deliveryId }, '-updated_date', 50).catch(() => []); for (const tx of dts || []) if (!related.some((x) => x?.id === tx?.id)) related.push(tx); if (!primary && related.length > 0) primary = related[0]; }

    let catId = catalogObjectId || primary?.square_catalog_object_id || related[0]?.square_catalog_object_id || null;

    // Fallback: search live catalog by delivery_id in description
    if (!catId && deliveryId) {
      try {
        const items = await lc(t);
        const match = items.find((i) => nt(i?.item_data?.description || '').toLowerCase().includes(deliveryId));
        if (match) catId = match.id;
      } catch (e) { console.warn('[SquareDelete] Live catalog search failed:', e?.message); }
    }

    const del = await sdo(catId, t);
    const isTempFail = [408, 429, 500, 502, 503, 504].includes(Number(del?.status));
    if (catId && !del?.ok && !isTempFail) throw new Error(`Failed to delete Square item ${catId}`);

    const newStatus = reason === 'failed' ? 'failed' : 'cancelled';
    for (let i = 0; i < related.length; i += 10) {
      const chunk = related.slice(i, i + 10);
      await Promise.all(chunk.map((tx) => b.asServiceRole.entities.SquareTransaction.update(tx.id, { status: newStatus, raw_square_data: { ...(tx.raw_square_data || {}), deleted_at: new Date().toISOString(), deleted_reason: reason || 'manual_delete' } }).catch(() => null)));
      if (i + 10 < related.length) await sleep(50);
    }

    const catMatches = [];
    if (deliveryId) { const bd = await b.asServiceRole.entities.SquareCatalogItems.filter({ delivery_id: deliveryId }, '-updated_date', 50).catch(() => []); catMatches.push(...(bd || [])); }
    if (catId) { const bc = await b.asServiceRole.entities.SquareCatalogItems.filter({ square_catalog_object_id: catId }, '-updated_date', 50).catch(() => []); catMatches.push(...(bc || [])); }
    const unique = Array.from(new Map(catMatches.filter(Boolean).map((x) => [x.id, x])).values());

    if (del?.ok || !catId || isTempFail) {
      for (let i = 0; i < unique.length; i += 10) {
        const chunk = unique.slice(i, i + 10);
        await Promise.all(chunk.map((x) => b.asServiceRole.entities.SquareCatalogItems.delete(x.id).catch(() => null)));
        if (i + 10 < unique.length) await sleep(50);
      }
    }

    return Response.json({ success: true, deletedCatalogId: catId, transactionCount: related.length, deletedCatalogRecordCount: unique.length, squareDeleteResult: del, squareDeleteDeferred: !!(catId && isTempFail), transactionStatus: related.length > 0 ? newStatus : 'deleted_from_square' });
  } catch (e) {
    if (e?.status === 404 || String(e?.message || '').toLowerCase().includes('not found')) return Response.json({ success: true, already_deleted: true });
    return Response.json({ error: e?.message || 'Error' }, { status: e?.status || 500 });
  }
});
