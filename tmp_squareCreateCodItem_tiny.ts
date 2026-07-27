// Self-contained Square COD create — no squareCodCore dependency
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const SB = 'https://connect.squareup.com';
const SV = '2025-01-23';
class HE extends Error { constructor(s, m) { super(m); this.status = s; } }
const nt = (v) => String(v || '').trim();
const tc = (v) => Math.max(0, Math.round(Number(v || 0)));
const ie = (v) => /^[a-f0-9]{24}$/i.test(String(v || ''));
const et = () => { const t = Deno.env.get('SQUARE_ACCESS_TOKEN'); if (!t) throw new HE(500, 'Square not configured'); return t; };
const ru = async (b) => { const u = await b.auth.me().catch(() => null); if (!u) throw new HE(401, 'Unauthorized'); return u; };

function fi(d, a, p) {
  const [, m, y] = String(d || '').split('-');
  return `${(m || '00').padStart(2, '0')}/${(y || '00').padStart(2, '0')}(${nt(a) || 'NA'})-${nt(p) || 'Unknown Patient'}`;
}

async function sf(p, m, t, b) {
  const r = await fetch(`${SB}${p}`, { method: m, headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json', 'Square-Version': SV }, body: b ? JSON.stringify(b) : undefined });
  const x = await r.text(); const j = x ? JSON.parse(x) : {};
  if (!r.ok) throw new HE(r.status, j?.errors?.map((e) => e.detail).join(', ') || `Error ${r.status}`);
  return j;
}

async function lc(t) {
  const o = []; let c;
  do { const j = await sf('/v2/catalog/search', 'POST', t, { object_types: ['ITEM'], include_deleted_objects: false, archived_state: 'ARCHIVED_STATE_NOT_ARCHIVED', limit: 1000, cursor: c }); o.push(...(j.objects || [])); c = j.cursor; } while (c);
  return o;
}

async function ci({ n, a, l, d, p, t }) {
  const j = await sf('/v2/catalog/batch-upsert', 'POST', t, { idempotency_key: crypto.randomUUID(), batches: [{ objects: [{ type: 'ITEM', id: `#item-${d}`, present_at_all_locations: false, present_at_location_ids: l ? [l] : [], item_data: { name: n, description: `COD for ${p || 'patient'} | Delivery ${d}`, is_taxable: true, product_type: 'REGULAR', variations: [{ type: 'ITEM_VARIATION', id: `#var-${d}`, present_at_all_locations: false, present_at_location_ids: l ? [l] : [], item_variation_data: { name: 'Default', pricing_type: 'FIXED_PRICING', price_money: { amount: a, currency: 'CAD' }, sellable: true, stockable: true } }] } }] }] });
  return (j.objects || []).find((o) => o.type === 'ITEM') || null;
}

async function uc({ o, v, n, a, l, d, p, t }) {
  const ej = await sf(`/v2/catalog/object/${o}`, 'GET', t, null).catch(() => null);
  const ei = ej?.object;
  if (!ei) return ci({ n, a, l, d, p, t });
  const vs = ei?.item_data?.variations || [];
  const lids = l ? [l] : [];
  const uv = vs.length > 0 ? vs.map((x) => ({ type: 'ITEM_VARIATION', id: x.id, version: x.version, present_at_all_locations: false, present_at_location_ids: lids, item_variation_data: { ...x.item_variation_data, name: 'Default', pricing_type: 'FIXED_PRICING', price_money: { amount: a, currency: 'CAD' } } })) : [{ type: 'ITEM_VARIATION', id: `#var-${d}`, present_at_all_locations: false, present_at_location_ids: lids, item_variation_data: { name: 'Default', pricing_type: 'FIXED_PRICING', price_money: { amount: a, currency: 'CAD' }, sellable: true, stockable: true } }];
  const j = await sf('/v2/catalog/batch-upsert', 'POST', t, { idempotency_key: crypto.randomUUID(), batches: [{ objects: [{ type: 'ITEM', id: o, version: v || ei.version, present_at_all_locations: false, present_at_location_ids: lids, item_data: { name: n, description: `COD for ${p || 'patient'} | Delivery ${d}`, is_taxable: true, product_type: 'REGULAR', variations: uv } }] }] });
  return (j.objects || []).find((x) => x.type === 'ITEM') || null;
}

async function pn(b, dr) {
  const r = nt(dr?.patient_id);
  if (!r) return nt(dr?.patient_name) || '';
  if (ie(r)) { const p = await b.asServiceRole.entities.Patient.get(r).catch(() => null); if (p) return nt(p?.full_name) || ''; }
  const ms = await b.asServiceRole.entities.Patient.filter({ patient_id: r }, '-updated_date', 1).catch(() => []);
  return nt(ms?.[0]?.full_name || dr?.patient_name) || '';
}

async function gs(b, sid) {
  if (!sid) throw new HE(400, 'Store ID required');
  const s = await b.asServiceRole.entities.Store.get(sid).catch(() => null);
  if (!s) throw new HE(400, `Store not found: ${sid}`);
  if (!s.square_location_config_id) throw new HE(400, `Store "${s.name}" not configured for Square COD`);
  const c = await b.asServiceRole.entities.SquareLocationConfig.get(s.square_location_config_id).catch(() => null);
  if (!c) throw new HE(400, `Square config not found for "${s.name}"`);
  if (c.status !== 'active') throw new HE(400, `Square location "${c.name}" inactive`);
  return { store: s, lid: c.square_location_id };
}

Deno.serve(async (req) => {
  try {
    const b = createClientFromRequest(req);
    await ru(b);
    const { deliveryId, patientName, storeAbbreviation, codAmount, deliveryDate, storeId } = await req.json().catch(() => ({}));
    if (!deliveryId || codAmount == null || Number(codAmount) <= 0) throw new HE(400, 'Missing: deliveryId, codAmount');

    const t = et();
    const dr = await b.asServiceRole.entities.Delivery.get(deliveryId).catch(() => null);
    const esid = storeId || dr?.store_id;
    const { store, lid } = await gs(b, esid);
    const dd = deliveryDate || dr?.delivery_date;
    const ln = dr ? await pn(b, dr) : '';
    const rpn = nt(ln || patientName || dr?.patient_name);
    if (!rpn || rpn === 'COD' || rpn === 'Unknown Patient') return Response.json({ success: true, skipped: true, reason: 'missing_patient_name' });

    const sa = nt(store?.abbreviation || storeAbbreviation || 'XX');
    const ac = Math.round(Number(codAmount) * 100);
    const n = fi(dd, sa, rpn);

    const ep = await b.asServiceRole.entities.SquareTransaction.filter({ delivery_id: deliveryId, status: 'pending' }).catch(() => []);
    let oid, ov;
    if (ep?.length && ep[0]?.square_catalog_object_id && ep[0]?.item_name === n && ep[0]?.amount_cents === ac) return Response.json({ success: true, catalogObjectId: ep[0].square_catalog_object_id, catalogVersion: ep[0].square_catalog_version, itemName: n, transactionId: ep[0].id, note: 'Skipped: existing' });

    if (ep?.length && ep[0]?.square_catalog_object_id && (ep[0]?.item_name !== n || ep[0]?.amount_cents !== ac)) {
      const u = await uc({ o: ep[0].square_catalog_object_id, v: ep[0].square_catalog_version, n, a: ac, l: lid, d: deliveryId, p: rpn, t });
      oid = u?.id || ep[0].square_catalog_object_id; ov = u?.version || ep[0].square_catalog_version;
    } else {
      const li = await lc(t);
      const el = li.find((i) => nt(i?.item_data?.description || '').toLowerCase().includes(deliveryId));
      if (el) { const u = await uc({ o: el.id, v: el.version, n, a: ac, l: lid, d: deliveryId, p: rpn, t }); oid = u?.id || el.id; ov = u?.version || el.version; }
      else { const c = await ci({ n, a: ac, l: lid, d: deliveryId, p: rpn, t }); oid = c?.id || null; ov = c?.version || null; if (!oid) throw new Error(`Square failed for delivery ${deliveryId}`); }
    }

    const tp = { square_catalog_object_id: oid, square_catalog_version: ov, item_name: n, amount: Number(codAmount), amount_cents: ac, store_id: esid, location_id: lid };
    const et2 = await b.asServiceRole.entities.SquareTransaction.filter({ delivery_id: deliveryId, status: 'pending' }).catch(() => []);
    const tx = et2.length > 0 ? await b.asServiceRole.entities.SquareTransaction.update(et2[0].id, tp) : await b.asServiceRole.entities.SquareTransaction.create({ ...tp, type: 'collection', status: 'pending', delivery_id: deliveryId });
    const ec = await b.asServiceRole.entities.SquareCatalogItems.filter({ delivery_id: deliveryId }).catch(() => []);
    const cp = { square_catalog_object_id: oid, square_catalog_version: ov, item_name: n, description: '', amount: Number(codAmount || 0), amount_cents: ac, delivery_id: deliveryId, delivery_date: dd || null, store_id: esid || null, location_id: lid, status: 'active' };
    if (ec.length > 0) await b.asServiceRole.entities.SquareCatalogItems.update(ec[0].id, cp);
    else await b.asServiceRole.entities.SquareCatalogItems.create(cp);
    return Response.json({ success: true, catalogObjectId: oid, catalogVersion: ov, itemName: n, transactionId: tx?.id || et2[0]?.id });
  } catch (e) {
    return Response.json({ error: e?.message || 'Error' }, { status: e?.status || 500 });
  }
});
