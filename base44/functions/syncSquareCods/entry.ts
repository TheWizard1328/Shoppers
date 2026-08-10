// Fully self-contained Square COD batch sync — NO cross-function calls
// Inlines createCodItem + deleteCodItem logic to avoid base44.functions.invoke 403
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const SB = 'https://connect.squareup.com';
const SV = '2025-01-23';
const MR = 3; const RD = 400;
class HE extends Error { constructor(s, m) { super(m); this.status = s; } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nt = (v) => String(v || '').trim();
const irs = (s) => [408, 409, 429, 500, 502, 503, 504].includes(Number(s));
const et = () => { const t = Deno.env.get('SQUARE_ACCESS_TOKEN'); if (!t) throw new HE(500, 'Square not configured'); return t; };
const iei = (v) => /^[a-f0-9]{24}$/i.test(String(v || ''));
const ru = async (b) => { const u = await b.auth.me().catch(() => null); if (!u) throw new HE(401, 'Unauthorized'); return u; };

function hasOfflinePayment(d) { return (Array.isArray(d?.cod_payments) ? d.cod_payments : []).some((p) => ['cash', 'check', 'other'].includes(String(p?.type || '').toLowerCase()) && Number(p?.amount || 0) > 0); }
function hasCardPayment(d) { return (Array.isArray(d?.cod_payments) ? d.cod_payments : []).some((p) => ['Debit', 'Credit'].includes(p?.type) && Number(p?.amount || 0) > 0); }

function formatItemName(deliveryDate, storeAbbreviation, patientName) {
  const [,month,day] = String(deliveryDate||'').split('-');
  return `${(month||'00').padStart(2,'0')}/${(day||'00').padStart(2,'0')}(${nt(storeAbbreviation)||'NA'})-${nt(patientName)||'Unknown Patient'}`;
}

async function sf(path, method, token, body) {
  let le = null;
  for (let a = 1; a <= MR; a++) {
    try {
      const r = await fetch(`${SB}${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Square-Version': SV }, body: body ? JSON.stringify(body) : undefined });
      const t = await r.text(); const j = t ? JSON.parse(t) : {};
      if (!r.ok) { const m = j?.errors?.map((e) => e.detail).join(', ') || `Square API error ${r.status}`; le = new HE(r.status, m); if (a < MR && irs(r.status)) { await sleep(RD * a); continue; } throw le; }
      return j;
    } catch (e) { le = e; if (a < MR && irs(e?.status)) { await sleep(RD * a); continue; } throw le; }
  }
  throw le || new Error('Square API failed');
}

async function sdo(id, token) {
  if (!id) return { attempted: false, ok: false };
  let lf = null;
  for (let a = 1; a <= MR; a++) {
    try {
      const r = await fetch(`${SB}/v2/catalog/object/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}`, 'Square-Version': SV } });
      if (r.ok || r.status === 404) return { attempted: true, ok: true, status: r.status };
      lf = { attempted: true, ok: false, status: r.status };
      if (a < MR && irs(r.status)) { await sleep(RD * a); continue; }
      return lf;
    } catch (e) { lf = { attempted: true, ok: false, error: e?.message }; if (a < MR) { await sleep(RD * a); continue; } return lf; }
  }
  return lf || { attempted: true, ok: false };
}

async function lc(token) {
  const o = []; let c;
  do {
    const j = await sf('/v2/catalog/search', 'POST', token, { object_types: ['ITEM'], include_deleted_objects: false, archived_state: 'ARCHIVED_STATE_NOT_ARCHIVED', limit: 1000, cursor: c });
    o.push(...(j.objects || [])); c = j.cursor; if (c) await sleep(200);
  } while (c);
  return o;
}

async function createItem({ itemName, amountCents, locationId, deliveryId, patientName, token }) {
  const j = await sf('/v2/catalog/batch-upsert', 'POST', token, { idempotency_key: crypto.randomUUID(), batches: [{ objects: [{ type: 'ITEM', id: `#item-${deliveryId}`, present_at_all_locations: false, present_at_location_ids: locationId ? [locationId] : [], item_data: { name: itemName, description: `COD for ${patientName || 'patient'} | Delivery ${deliveryId}`, is_taxable: true, product_type: 'REGULAR', variations: [{ type: 'ITEM_VARIATION', id: `#variation-${deliveryId}`, present_at_all_locations: false, present_at_location_ids: locationId ? [locationId] : [], item_variation_data: { name: 'Default', pricing_type: 'FIXED_PRICING', price_money: { amount: amountCents, currency: 'CAD' }, sellable: true, stockable: true } }] } }] }] });
  return (j.objects || []).find((o) => o.type === 'ITEM') || null;
}

async function updateItem({ catalogObjectId, catalogVersion, itemName, amountCents, locationId, deliveryId, patientName, token }) {
  const ej = await sf(`/v2/catalog/object/${catalogObjectId}`, 'GET', token, null).catch(() => null);
  const ei = ej?.object;
  if (!ei) return createItem({ itemName, amountCents, locationId, deliveryId, patientName, token });
  const evs = ei?.item_data?.variations || [];
  const pl = locationId ? [locationId] : [];
  const uv = evs.length > 0 ? evs.map((v) => ({ type: 'ITEM_VARIATION', id: v.id, version: v.version, present_at_all_locations: false, present_at_location_ids: pl, item_variation_data: { ...v.item_variation_data, name: 'Default', pricing_type: 'FIXED_PRICING', price_money: { amount: amountCents, currency: 'CAD' } } })) : [{ type: 'ITEM_VARIATION', id: `#variation-${deliveryId}`, present_at_all_locations: false, present_at_location_ids: pl, item_variation_data: { name: 'Default', pricing_type: 'FIXED_PRICING', price_money: { amount: amountCents, currency: 'CAD' }, sellable: true, stockable: true } }];
  const j = await sf('/v2/catalog/batch-upsert', 'POST', token, { idempotency_key: crypto.randomUUID(), batches: [{ objects: [{ type: 'ITEM', id: catalogObjectId, version: catalogVersion || ei.version, present_at_all_locations: false, present_at_location_ids: pl, item_data: { name: itemName, description: `COD for ${patientName || 'patient'} | Delivery ${deliveryId}`, is_taxable: true, product_type: 'REGULAR', variations: uv } }] }] });
  return (j.objects || []).find((o) => o.type === 'ITEM') || null;
}

async function resolvePatient(b44, delivery, pById, pByPid) {
  const ref = nt(delivery?.patient_id); if (!ref) return null;
  const mapped = pById.get(ref) || pByPid.get(ref); if (mapped) return mapped;
  if (iei(ref)) { const p = await b44.asServiceRole.entities.Patient.get(ref).catch(() => null); if (p) { pById.set(p.id, p); const pid = nt(p.patient_id); if (pid) pByPid.set(pid, p); return p; } }
  const ms = await b44.asServiceRole.entities.Patient.filter({ patient_id: ref }, '-updated_date', 1).catch(() => []);
  const p = Array.isArray(ms) ? ms[0] : null;
  if (p) { pById.set(p.id, p); const pid = nt(p.patient_id); if (pid) pByPid.set(pid, p); return p; }
  return null;
}

async function resolvePatientName(b44, delivery, pById, pByPid) {
  const p = await resolvePatient(b44, delivery, pById, pByPid);
  return nt(p?.full_name || delivery?.patient_name) || 'Unknown Patient';
}

async function getStoreCtx(b44, storeId) {
  if (!storeId) throw new HE(400, 'Store ID required');
  const store = await b44.asServiceRole.entities.Store.get(storeId).catch(() => null);
  if (!store) throw new HE(400, `Store not found: ${storeId}`);
  if (!store.square_location_config_id) throw new HE(400, `Store "${store.name}" not configured for Square COD`);
  const cfg = await b44.asServiceRole.entities.SquareLocationConfig.get(store.square_location_config_id).catch(() => null);
  if (!cfg) throw new HE(400, `Square config not found for store "${store.name}"`);
  if (cfg.status !== 'active') throw new HE(400, `Square location "${cfg.name}" inactive for store "${store.name}"`);
  return { store, locationId: cfg.square_location_id };
}

async function buildPMaps(b44, deliveries) {
  const refs = Array.from(new Set((deliveries || []).map((d) => nt(d?.patient_id)).filter(Boolean)));
  const eids = refs.filter((id) => iei(id)); const pids = refs.filter((id) => !iei(id));
  const [byEid, byPid] = await Promise.all([eids.length ? b44.asServiceRole.entities.Patient.filter({ id: { $in: eids } }) : [], pids.length ? b44.asServiceRole.entities.Patient.filter({ patient_id: { $in: pids } }) : []]);
  const patients = [...(byEid || []), ...((byPid || []).filter((p) => !(byEid || []).some((e) => e.id === p.id)))];
  return { pById: new Map(patients.map((p) => [p.id, p])), pByPid: new Map(patients.map((p) => [nt(p?.patient_id), p]).filter(([id]) => id)) };
}

// ── INLINE COD ITEM CREATION ──
async function handleCreateCodItem(b44, payload) {
  const token = et();
  const { deliveryId, patientName, storeAbbreviation, codAmount, deliveryDate, storeId } = payload || {};
  if (!deliveryId || codAmount == null || Number(codAmount) <= 0) throw new HE(400, 'Missing: deliveryId, codAmount');
  const dr = await b44.asServiceRole.entities.Delivery.get(deliveryId).catch(() => null);
  const { pById, pByPid } = await buildPMaps(b44, dr ? [dr] : []);
  const pr = dr ? await resolvePatient(b44, dr, pById, pByPid) : null;
  const effStoreId = storeId || dr?.store_id;
  const { store, locationId } = await getStoreCtx(b44, effStoreId);
  const rdd = deliveryDate || dr?.delivery_date;
  const looked = dr ? await resolvePatientName(b44, dr, pById, pByPid) : '';
  const usable = looked === 'Unknown Patient' ? '' : looked;
  const rpn = nt(usable || patientName || dr?.patient_name);
  // Fallback patient name — don't skip!
  let epn = rpn;
  if (!epn || epn === 'COD' || epn === 'Unknown Patient') { epn = `Delivery ${deliveryId.slice(-6)}`; console.warn('[syncSquareCods] Fallback patient name for:', deliveryId); }
  const rpid = pr?.id || (iei(dr?.patient_id) ? dr.patient_id : null);
  const rsa = nt(store?.abbreviation || storeAbbreviation || 'XX');
  const ac = Math.round(Number(codAmount) * 100);
  const iname = formatItemName(rdd, rsa, epn);
  // NOTE: Do NOT skip even if a pending tx already references a catalog object —
  // that reference may be stale (the Square object could have been deleted by a
  // prior sync cleanup). Fall through to verify against the live catalog.
  const ep = await b44.asServiceRole.entities.SquareTransaction.filter({ delivery_id: deliveryId, status: 'pending' }).catch(() => []);
  let catId, catVer;
  if (ep?.length && ep[0]?.square_catalog_object_id && (ep[0]?.item_name !== iname || ep[0]?.amount_cents !== ac)) {
    // Existing pending tx with different name/amount — update the live item.
    // updateItem falls back to createItem if the catalog object is gone (404).
    const u = await updateItem({ catalogObjectId: ep[0].square_catalog_object_id, catalogVersion: ep[0].square_catalog_version, itemName: iname, amountCents: ac, locationId, deliveryId, patientName: epn, token });
    catId = u?.id || ep[0].square_catalog_object_id; catVer = u?.version || ep[0].square_catalog_version;
  } else {
    // Either no pending tx, or name+amount already match. Always verify the live catalog
    // item exists; if it was deleted by a prior sync cleanup, recreate it.
    const live = await lc(token);
    const ex = live.find((i) => nt(i?.item_data?.description || '').toLowerCase().includes(`delivery ${deliveryId}`) || nt(i?.item_data?.description || '').toLowerCase().includes(deliveryId));
    if (ex) { const u = await updateItem({ catalogObjectId: ex.id, catalogVersion: ex.version, itemName: iname, amountCents: ac, locationId, deliveryId, patientName: epn, token }); catId = u?.id || ex.id; catVer = u?.version || ex.version; }
    else { const ci = await createItem({ itemName: iname, amountCents: ac, locationId, deliveryId, patientName: epn, token }); catId = ci?.id || null; catVer = ci?.version || null; if (!catId) throw new Error(`Square did not return catalog item for ${deliveryId}`); }
  }
  const exTx = await b44.asServiceRole.entities.SquareTransaction.filter({ delivery_id: deliveryId, status: 'pending' }).catch(() => []);
  const tp = { square_catalog_object_id: catId, square_catalog_version: catVer, item_name: iname, amount: Number(codAmount), amount_cents: ac, patient_id: rpid, store_id: effStoreId, location_id: locationId };
  const tx = exTx.length > 0 ? await b44.asServiceRole.entities.SquareTransaction.update(exTx[0].id, tp) : await b44.asServiceRole.entities.SquareTransaction.create({ ...tp, type: 'collection', status: 'pending', delivery_id: deliveryId });
  const exCat = await b44.asServiceRole.entities.SquareCatalogItems.filter({ delivery_id: deliveryId }).catch(() => []);
  const cp = { square_catalog_object_id: catId, square_catalog_version: catVer, item_name: iname, description: '', amount: Number(codAmount || 0), amount_cents: ac, delivery_id: deliveryId, delivery_date: rdd || null, patient_id: rpid, store_id: effStoreId || null, location_id: locationId, status: 'active' };
  if (exCat.length > 0) await b44.asServiceRole.entities.SquareCatalogItems.update(exCat[0].id, cp);
  else await b44.asServiceRole.entities.SquareCatalogItems.create(cp);
  return { success: true, catalogObjectId: catId, catalogVersion: catVer, itemName: iname, transactionId: tx?.id || exTx[0]?.id };
}

// ── INLINE COD ITEM DELETION ──
async function handleDeleteCodItem(b44, payload) {
  const token = et();
  const { deliveryId, transactionId, catalogObjectId, reason } = payload || {};
  if (!deliveryId && !transactionId && !catalogObjectId) throw new HE(400, 'Missing: deliveryId, transactionId, or catalogObjectId');
  const related = []; let primary = null;
  if (transactionId) { const tx = await b44.asServiceRole.entities.SquareTransaction.get(transactionId).catch(() => null); if (tx) { primary = tx; related.push(tx); } }
  if (deliveryId) { const dts = await b44.asServiceRole.entities.SquareTransaction.filter({ delivery_id: deliveryId }, '-updated_date', 50).catch(() => []); for (const tx of dts || []) if (!related.some((x) => x?.id === tx?.id)) related.push(tx); if (!primary && related.length > 0) primary = related[0]; }
  let catId = catalogObjectId || primary?.square_catalog_object_id || related[0]?.square_catalog_object_id || null;
  // Fallback: search live catalog
  if (!catId && deliveryId) {
    try { const items = await lc(token); const m = items.find((i) => nt(i?.item_data?.description || '').toLowerCase().includes(deliveryId)); if (m) catId = m.id; } catch (e) { console.warn('[syncSquareCods] Catalog search failed:', e?.message); }
  }
  const del = await sdo(catId, token);
  const isTemp = [408, 429, 500, 502, 503, 504].includes(Number(del?.status));
  if (catId && !del?.ok && !isTemp) throw new Error(`Failed to delete Square item ${catId}`);
  const ns = reason === 'failed' ? 'failed' : 'cancelled';
  for (let i = 0; i < related.length; i += 10) {
    const chunk = related.slice(i, i + 10);
    await Promise.all(chunk.map((tx) => b44.asServiceRole.entities.SquareTransaction.update(tx.id, { status: ns, raw_square_data: { ...(tx.raw_square_data || {}), deleted_at: new Date().toISOString(), deleted_reason: reason || 'manual_delete' } }).catch(() => null)));
    if (i + 10 < related.length) await sleep(50);
  }
  const cm = [];
  if (deliveryId) { const bd = await b44.asServiceRole.entities.SquareCatalogItems.filter({ delivery_id: deliveryId }, '-updated_date', 50).catch(() => []); cm.push(...(bd || [])); }
  if (catId) { const bc = await b44.asServiceRole.entities.SquareCatalogItems.filter({ square_catalog_object_id: catId }, '-updated_date', 50).catch(() => []); cm.push(...(bc || [])); }
  const uniq = Array.from(new Map(cm.filter(Boolean).map((x) => [x.id, x])).values());
  if (del?.ok || !catId || isTemp) {
    for (let i = 0; i < uniq.length; i += 10) {
      const chunk = uniq.slice(i, i + 10);
      await Promise.all(chunk.map((x) => b44.asServiceRole.entities.SquareCatalogItems.delete(x.id).catch(() => null)));
      if (i + 10 < uniq.length) await sleep(50);
    }
  }
  return { success: true, deletedCatalogId: catId, transactionCount: related.length, deletedCatalogRecordCount: uniq.length, squareDeleteResult: del, squareDeleteDeferred: !!(catId && isTemp) };
}

Deno.serve(async (req) => {
  try {
    const b = createClientFromRequest(req);
    await ru(b);
    const payload = await req.json().catch(() => ({}));
    console.log('[syncSquareCods] invoked — mode:', payload?.event ? 'event' : 'batch', 'items:', payload?.items?.length || 0);

    // Event-driven sync (from entity trigger)
    const event = payload?.event;
    if (event?.entity_name === 'Delivery') {
      const delivery = payload?.data || await b.asServiceRole.entities.Delivery.get(event.entity_id).catch(() => null);
      if (!delivery || Number(delivery?.cod_total_amount_required || 0) <= 0) return Response.json({ success: true, processed: 0, results: [{ deliveryId: event?.entity_id, action: 'noop', status: 'skipped' }] });
      const oldStatus = nt(payload?.old_data?.status); const newStatus = nt(delivery.status);
      try {
        if (newStatus === 'failed' || newStatus === 'cancelled') {
          const r = await handleDeleteCodItem(b, { deliveryId: delivery.id, reason: newStatus });
          return Response.json({ success: true, processed: 1, results: [{ deliveryId: delivery.id, action: 'delete', status: 'ok', result: r }] });
        }
        if (newStatus === 'completed' && (hasOfflinePayment(delivery) || hasCardPayment(delivery))) {
          const r = await handleDeleteCodItem(b, { deliveryId: delivery.id, reason: hasOfflinePayment(delivery) ? 'offline_payment_collected' : 'card_payment_collected' });
          return Response.json({ success: true, processed: 1, results: [{ deliveryId: delivery.id, action: 'delete', status: 'ok', result: r }] });
        }
        const wasActive = oldStatus === 'in_transit' || oldStatus === 'en_route';
        if (newStatus === 'pending' && wasActive) {
          const r = await handleDeleteCodItem(b, { deliveryId: delivery.id, reason: 'reverted_to_pending' });
          return Response.json({ success: true, processed: 1, results: [{ deliveryId: delivery.id, action: 'delete', status: 'ok', result: r }] });
        }
        const isNowActive = newStatus === 'in_transit' || newStatus === 'en_route';
        if (isNowActive) {
          const r = await handleCreateCodItem(b, { deliveryId: delivery.id, codAmount: delivery.cod_total_amount_required, deliveryDate: delivery.delivery_date, storeId: delivery.store_id, patientName: delivery.patient_name });
          return Response.json({ success: true, processed: 1, results: [{ deliveryId: delivery.id, action: 'upsert', status: r?.skipped ? 'skipped' : 'ok', result: r }] });
        }
        return Response.json({ success: true, processed: 1, results: [{ deliveryId: delivery.id, action: 'noop', status: 'skipped', reason: `no_action_${oldStatus}_to_${newStatus}` }] });
      } catch (error) {
        return Response.json({ success: false, processed: 1, results: [{ deliveryId: delivery.id, action: 'sync', status: 'error', error: error?.message || 'Failed' }] });
      }
    }

    // Batch mode: process items + deletions arrays
    const items = Array.isArray(payload?.items) ? payload.items : [];
    const deletions = Array.isArray(payload?.deletions) ? payload.deletions : [];
    if (!items.length && !deletions.length) return Response.json({ success: true, processed: 0, results: [] });

    const results = [];
    for (const del of deletions) {
      try {
        const r = await handleDeleteCodItem(b, { deliveryId: del?.deliveryId, catalogObjectId: del?.catalogObjectId, transactionId: del?.transactionId, reason: del?.status === 'failed' ? 'failed' : del?.reason });
        results.push({ deliveryId: del?.deliveryId, action: 'delete', status: 'ok', result: r });
      } catch (error) {
        console.error('[syncSquareCods] Delete error for', del?.deliveryId, ':', error?.message);
        results.push({ deliveryId: del?.deliveryId, action: 'delete', status: 'error', error: error?.message || 'Delete failed' });
      }
    }
    for (const item of items) {
      try {
        const r = await handleCreateCodItem(b, { deliveryId: item?.deliveryId, patientName: item?.patientName, storeAbbreviation: item?.storeAbbreviation, codAmount: item?.codAmount, deliveryDate: item?.deliveryDate, storeId: item?.storeId });
        results.push({ deliveryId: item?.deliveryId, action: 'upsert', status: r?.skipped ? 'skipped' : 'ok', result: r });
      } catch (error) {
        console.error('[syncSquareCods] Create error for', item?.deliveryId, ':', error?.message);
        results.push({ deliveryId: item?.deliveryId, action: 'upsert', status: 'error', error: error?.message || 'Upsert failed' });
      }
    }
    console.log('[syncSquareCods] batch done —', results.length, 'processed,', results.filter((r) => r.status === 'error').length, 'errors');
    return Response.json({ success: !results.some((e) => e.status === 'error'), processed: results.length, results });
  } catch (error) {
    console.error('[syncSquareCods] FATAL:', error?.message || error);
    return Response.json({ error: error?.message || 'Error' }, { status: error?.status || 500 });
  }
});