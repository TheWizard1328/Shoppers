import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

class HttpError extends Error { constructor(s, m) { super(m); this.status = s; } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const normalizeText = (v) => String(v || '').trim();
const toAmountCents = (v) => Math.max(0, Math.round(Number(v || 0)));
const ensureSquareToken = () => { const t = Deno.env.get('SQUARE_ACCESS_TOKEN'); if (!t) throw new HttpError(500, 'Square credentials not configured'); return t; };
const SQUARE_BASE_URL = 'https://connect.squareup.com';
const SQUARE_VERSION = '2025-01-23';
const isRetryableSquareStatus = (s) => [408, 409, 429, 500, 502, 503, 504].includes(Number(s));
const TRANSACTION_RETENTION_DAYS = 90;
const MAX_TRANSACTION_ORDERS = 2000;
const isValidEntityId = (v) => /^[a-f0-9]{24}$/i.test(String(v || ''));
const shouldIgnoreManualOrderLabel = (v) => ['top ups','top up','topup','tip','top'].includes(String(v||'').replace(/\s+/g,' ').trim().toLowerCase());
const formatLocalDate = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const unwrapEntityRecord = (r) => { if (!r || typeof r !== 'object') return null; if (r.data && typeof r.data === 'object') return { ...r.data, id: r.data.id || r.id }; return r; };
const buildItemSignature = (n, c) => `${normalizeText(n)}::${toAmountCents(c)}`;
const normalizeMatchName = (v) => normalizeText(v).replace(/\s+/g,' ').replace(/\s-\s\$\d+(?:\.\d{2})?$/,'').replace(/^(\d{2})-(\d{2})/,'$1/$2').toLowerCase();
const isStructuredCodName = (v) => /^\d{2}[\/-]\d{2}\([^)]+\)-.+/.test(String(v||'').trim());
const getCatalogItemLocationIds = (item) => Array.from(new Set([...(item?.present_at_location_ids||[]),...(item?.item_data?.variations||[]).flatMap((v)=>v?.present_at_location_ids||[])].filter(Boolean)));
const getCatalogItemAmountCents = (item) => { const vs=item?.item_data?.variations||[]; const v=vs.find((e)=>e?.item_variation_data?.price_money?.amount!=null)||vs[0]; return toAmountCents(v?.item_variation_data?.price_money?.amount); };
const getPreferredStoreAbbreviation = (store) => { const n=normalizeText(store?.abbreviation); if (n) return n.toUpperCase(); const ts=normalizeText(store?.name).split(/[^a-zA-Z0-9]+/).map((p)=>p.trim()).filter(Boolean); if (!ts.length) return 'NA'; if (ts.length===1) return ts[0].slice(0,2).toUpperCase(); return ts.map((t)=>t[0]).join('').slice(0,2).toUpperCase(); };
function extractItemNameAbbr(itemName) { const m = String(itemName||'').match(/\(([^)]+)\)/); return m ? normalizeText(m[1]).toUpperCase() : ''; }
function getStoreAbbreviationVariants(store) {
  const vs=new Set();const push=(v)=>{const n=normalizeText(v);if(!n)return;vs.add(n.toLowerCase());n.split(/[^a-zA-Z0-9]+/).map((p)=>p.trim().toLowerCase()).filter(Boolean).forEach((p)=>vs.add(p));};
  push(store?.abbreviation);push(store?.name);return Array.from(vs);
}
function buildStoresByLocationId(stores, activeConfigById) {
  const map = new Map();
  for (const s of stores||[]) { const c = activeConfigById.get(s?.square_location_config_id); if (!c?.square_location_id) continue; const lid = c.square_location_id; if (!map.has(lid)) map.set(lid, []); map.get(lid).push(s); }
  return map;
}
function resolveStoreForItem(itemName, locationId, storesByLocationId) {
  const candidates = storesByLocationId.get(locationId) || [];
  if (!candidates.length) return null;
  if (candidates.length === 1) return candidates[0];
  const abbr = extractItemNameAbbr(itemName).toLowerCase();
  if (abbr) { const exact = candidates.find((s) => normalizeText(s?.abbreviation).toLowerCase() === abbr); if (exact) return exact; const partial = candidates.find((s) => getStoreAbbreviationVariants(s).some((v) => v === abbr || abbr.includes(v) || v.includes(abbr))); if (partial) return partial; }
  return candidates[0];
}
function formatItemName(deliveryDate, storeAbbreviation, patientName) {
  const [,month,day] = String(deliveryDate||'').split('-');
  return `${(month||'00').padStart(2,'0')}/${(day||'00').padStart(2,'0')}(${normalizeText(storeAbbreviation)||'NA'})-${normalizeText(patientName)||'Unknown Patient'}`;
}
function extractCatalogMonthDay(v) {
  const n=normalizeText(v); const iso=n.match(/^\d{4}-(\d{2})-(\d{2})$/); if (iso) return `${iso[1]}-${iso[2]}`;
  const pre=n.slice(0,5); const m=pre.match(/^(\d{2})\/(\d{2})$/); return m?`${m[1]}-${m[2]}`:'';
}
function parseDateValue(value, ref=new Date()) {
  const n=normalizeText(value); const iso=n.match(/^(\d{4})-(\d{2})-(\d{2})$/); if (iso) return new Date(+iso[1],+iso[2]-1,+iso[3]);
  const mdk=extractCatalogMonthDay(n); if (!mdk) return null;
  const [mo,da]=mdk.split('-').map(Number); const rl=new Date(ref.getFullYear(),ref.getMonth(),ref.getDate());
  return [rl.getFullYear()-1,rl.getFullYear(),rl.getFullYear()+1].map((y)=>new Date(y,mo-1,da)).sort((a,b)=>Math.abs(a-rl)-Math.abs(b-rl))[0]||null;
}
const toIsoDate = (v) => { const p=parseDateValue(v); return (p&&!Number.isNaN(p.getTime()))?p.toISOString().slice(0,10):null; };
const getLookbackStartAt = (days) => new Date(Date.now() - days * 86400000).toISOString();
const requireAdminIfAuthenticated = async (b44) => { const ok = await b44.auth.isAuthenticated().catch(() => false); if (!ok) return null; const u = await b44.auth.me().catch(() => null); if (u?.role !== 'admin') throw new HttpError(403, 'Forbidden: Admin access required'); return u; };
const itemNameContainsStore=(itemName,store)=>{const n=normalizeMatchName(itemName);return !!n&&getStoreAbbreviationVariants(store).some((v)=>n.includes(v));};
async function squareFetch(path, method, accessToken, body, options={}) {
  let lastError=null;
  for (let attempt=1;attempt<=3;attempt++) {
    try {
      const response=await fetch(`${SQUARE_BASE_URL}${path}`,{method,headers:{Authorization:`Bearer ${accessToken}`,'Content-Type':'application/json','Square-Version':SQUARE_VERSION},body:body?JSON.stringify(body):undefined});
      const text=await response.text();const json=text?JSON.parse(text):{};
      if(!response.ok){const msg=json?.errors?.map((e)=>e.detail).join(', ')||`Square API error ${response.status}`;lastError=new HttpError(response.status,msg);if(attempt<3&&isRetryableSquareStatus(response.status)){await sleep(400*attempt);continue;}throw lastError;}
      return json;
    } catch(error){lastError=error;if(attempt<3){await sleep(400*attempt);continue;}throw lastError;}
  }
  throw lastError||new Error('Square API request failed');
}
async function listActiveCatalogItems(accessToken) {
  const objects=[];let cursor;
  do{const json=await squareFetch('/v2/catalog/search','POST',accessToken,{object_types:['ITEM'],include_deleted_objects:false,archived_state:'ARCHIVED_STATE_NOT_ARCHIVED',limit:1000,cursor});objects.push(...(json.objects||[]));cursor=json.cursor;if(cursor)await sleep(200);}while(cursor);
  return objects;
}
async function listOrders(locationIds, startAt, accessToken, maxOrders=2000, states=['COMPLETED','OPEN']) {
  if(!locationIds.length)return[];const orders=[];let cursor=null;
  do{const json=await squareFetch('/v2/orders/search','POST',accessToken,{location_ids:locationIds,cursor,limit:500,query:{filter:{state_filter:{states},date_time_filter:{created_at:{start_at:startAt}}},sort:{sort_field:'CREATED_AT',sort_order:'DESC'}}});orders.push(...(json.orders||[]));cursor=json.cursor||null;if(cursor&&orders.length<maxOrders)await sleep(200);}while(cursor&&orders.length<maxOrders);
  return orders.slice(0,maxOrders);
}
function isOrderFullyRefunded(order) {
  const netTotal = order?.net_amounts?.total_money?.amount;
  if (netTotal != null && Number(netTotal) <= 0) return true;
  const returnTotal = order?.return_amounts?.total_money?.amount;
  const orderTotal = order?.total_money?.amount;
  if (returnTotal != null && orderTotal != null && Number(orderTotal) > 0 && Number(returnTotal) >= Number(orderTotal)) return true;
  return false;
}
function buildRefundedOrderIdSet(orders) { const s = new Set(); for (const o of orders || []) { if (isOrderFullyRefunded(o)) s.add(o.id); } return s; }
function flattenOrderItems(orders) {
  const items=[];
  for(const order of orders||[]){
    const lineItems=order?.line_items||[];
    const refundedQtyByUid=new Map();
    for(const rli of order?.return_line_items||[]){const uid=rli?.source_line_item_uid;if(!uid)continue;const rq=Math.round(Number(rli?.quantity||1))||1;refundedQtyByUid.set(uid,(refundedQtyByUid.get(uid)||0)+rq);}
    for(const li of lineItems){const itemName=normalizeText(li?.name||li?.note);if(!itemName||shouldIgnoreManualOrderLabel(itemName))continue;const totalQty=Math.round(Number(li?.quantity||1))||1;const refundedQty=refundedQtyByUid.get(li?.uid)||0;const netQty=Math.max(0,totalQty-refundedQty);if(netQty<=0)continue;const eu=toAmountCents(li?.base_price_money?.amount);const gr=toAmountCents(li?.gross_sales_money?.amount||li?.total_money?.amount);const ac=eu||(totalQty>0?Math.round(gr/totalQty):gr);const ts=order?.state==='COMPLETED'?'completed':'pending';for(let i=0;i<netQty;i++)items.push({order_id:order?.id,line_item_uid:li?.uid?`${li.uid}-${i}`:(order?.id+'-'+(li?.catalog_object_id||itemName)+'-'+i),location_id:order?.location_id||null,item_name:itemName,amount_cents:ac,catalog_object_id:li?.catalog_object_id||null,payment_date:order?.created_at||null,note:order?.note||'',transaction_status:ts});}
  }
  return items;
}

// ── Collection detection ──
const PAYMENT_TYPE_LOWERCASE_OFFLINE = new Set(['cash', 'check', 'other']);
const PAYMENT_TYPE_EXACT_CARD = new Set(['Debit', 'Credit', 'card', 'debit', 'credit', 'Card']);
function hasOfflinePayment(d) { return (Array.isArray(d?.cod_payments) ? d.cod_payments : []).some((p) => PAYMENT_TYPE_LOWERCASE_OFFLINE.has(String(p?.type || '').toLowerCase()) && Number(p?.amount || 0) > 0); }
function hasCardPayment(d) { return (Array.isArray(d?.cod_payments) ? d.cod_payments : []).some((p) => PAYMENT_TYPE_EXACT_CARD.has(String(p?.type || '')) && Number(p?.amount || 0) > 0); }
const isDeliveryAlreadyCollected = (d) => d?.status === 'completed' && (hasOfflinePayment(d) || hasCardPayment(d));

// ── Inline Square API helpers (replaces base44.functions.invoke calls) ──
async function createCatalogItem({ itemName, amountCents, locationId, deliveryId, patientName, token }) {
  const j = await squareFetch('/v2/catalog/batch-upsert', 'POST', token, { idempotency_key: crypto.randomUUID(), batches: [{ objects: [{ type: 'ITEM', id: `#item-${deliveryId}`, present_at_all_locations: false, present_at_location_ids: locationId ? [locationId] : [], item_data: { name: itemName, description: `COD for ${patientName || 'patient'} | Delivery ${deliveryId}`, is_taxable: true, product_type: 'REGULAR', variations: [{ type: 'ITEM_VARIATION', id: `#variation-${deliveryId}`, present_at_all_locations: false, present_at_location_ids: locationId ? [locationId] : [], item_variation_data: { name: 'Default', pricing_type: 'FIXED_PRICING', price_money: { amount: amountCents, currency: 'CAD' }, sellable: true, stockable: true } }] } }] }] });
  return (j.objects || []).find((o) => o.type === 'ITEM') || null;
}
async function deleteCatalogObject(catalogObjectId, token) {
  if (!catalogObjectId) return { attempted: false, ok: false };
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(`${SQUARE_BASE_URL}/v2/catalog/object/${catalogObjectId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}`, 'Square-Version': SQUARE_VERSION } });
      if (r.ok || r.status === 404) return { attempted: true, ok: true, status: r.status };
      if (attempt < 3 && isRetryableSquareStatus(r.status)) { await sleep(400 * attempt); continue; }
      return { attempted: true, ok: false, status: r.status };
    } catch (e) { if (attempt < 3) { await sleep(400 * attempt); continue; } return { attempted: true, ok: false, error: e?.message }; }
  }
  return { attempted: true, ok: false };
}

async function getStoreCtx(b44, storeId) {
  if (!storeId) throw new HttpError(400, 'Store ID required');
  const store = await b44.asServiceRole.entities.Store.get(storeId).catch(() => null);
  if (!store) throw new HttpError(400, `Store not found: ${storeId}`);
  if (!store.square_location_config_id) throw new HttpError(400, `Store "${store.name}" not configured for Square COD`);
  const cfg = await b44.asServiceRole.entities.SquareLocationConfig.get(store.square_location_config_id).catch(() => null);
  if (!cfg) throw new HttpError(400, `Square config not found for store "${store.name}"`);
  if (cfg.status !== 'active') throw new HttpError(400, `Square location "${cfg.name}" inactive for store "${store.name}"`);
  return { store, locationId: cfg.square_location_id };
}

async function resolvePatientName(b44, delivery, patientsById) {
  const ref = normalizeText(delivery?.patient_id);
  if (!ref) return normalizeText(delivery?.patient_name) || 'Unknown Patient';
  const mapped = patientsById.get(ref);
  if (mapped) return normalizeText(mapped.full_name || delivery?.patient_name) || 'Unknown Patient';
  if (isValidEntityId(ref)) {
    const p = await b44.asServiceRole.entities.Patient.get(ref).catch(() => null);
    if (p) { patientsById.set(p.id, p); return normalizeText(p.full_name || delivery?.patient_name) || 'Unknown Patient'; }
  }
  const ms = await b44.asServiceRole.entities.Patient.filter({ patient_id: ref }, '-updated_date', 1).catch(() => []);
  const p = Array.isArray(ms) ? ms[0] : null;
  if (p) { patientsById.set(p.id, p); return normalizeText(p.full_name || delivery?.patient_name) || 'Unknown Patient'; }
  return normalizeText(delivery?.patient_name) || 'Unknown Patient';
}

async function handleSyncCatalog(base44, payload={}) {
  const accessToken=ensureSquareToken();
  const daysBack=Math.max(1,Number(payload?.daysBack||TRANSACTION_RETENTION_DAYS)||TRANSACTION_RETENTION_DAYS);

  // ── Step 1: Fetch all data in parallel (no base44.functions.invoke) ──
  const [stores, locationConfigs, patients, existingCatalogDb] = await Promise.all([
    base44.asServiceRole.entities.Store.list('-updated_date', 500).catch(() => []),
    base44.asServiceRole.entities.SquareLocationConfig.list('-updated_date', 500).catch(() => []),
    base44.asServiceRole.entities.Patient.list('-updated_date', 5000).catch(() => []),
    base44.asServiceRole.entities.SquareCatalogItems.list('-updated_date', 2000).catch(() => []),
  ]);
  const safeStores = (Array.isArray(stores) ? stores : []).map(unwrapEntityRecord).filter(Boolean);
  const safeConfigs = (Array.isArray(locationConfigs) ? locationConfigs : []).map(unwrapEntityRecord).filter(Boolean);
  const activeConfigById = new Map(safeConfigs.filter((c) => c?.status === 'active').map((c) => [c.id, c]));
  const storesByLocationId = buildStoresByLocationId(safeStores, activeConfigById);
  const patientsById = new Map((Array.isArray(patients) ? patients : []).map((p) => [p.id, unwrapEntityRecord(p)]).filter(([_, v]) => v));
  const existingCatalog = (Array.isArray(existingCatalogDb) ? existingCatalogDb : []).map(unwrapEntityRecord).filter(Boolean);
  const catalogDeliveryIds = new Set(existingCatalog.map((c) => c?.delivery_id).filter(Boolean));

  // Fetch deliveries
  const startDateStr = formatLocalDate(new Date(Date.now() - daysBack * 86400000));
  const endDateStr = formatLocalDate(new Date());
  const deliveries = await base44.asServiceRole.entities.Delivery.filter({ delivery_date: { $gte: startDateStr, $lte: endDateStr } }, '-updated_date', 5000).catch(() => []);
  const safeDeliveries = (Array.isArray(deliveries) ? deliveries : []).map(unwrapEntityRecord).filter(Boolean);

  // Exclude already-collected deliveries from creation
  const deliveriesWithCod = safeDeliveries.filter((d) => Number(d?.cod_total_amount_required || 0) > 0 && d?.status !== 'failed' && d?.status !== 'cancelled' && !isDeliveryAlreadyCollected(d));

  // ── Step 2: Create missing COD items (inline — no base44.functions.invoke) ──
  const createResults = [];
  const toCreate = deliveriesWithCod.filter((d) => !catalogDeliveryIds.has(d.id));
  for (const delivery of toCreate) {
    try {
      const { store, locationId } = await getStoreCtx(base44, delivery.store_id);
      const patientName = await resolvePatientName(base44, delivery, patientsById);
      const epn = normalizeText(patientName) || `Delivery ${delivery.id.slice(-6)}`;
      const rsa = getPreferredStoreAbbreviation(store);
      const ac = Math.round(Number(delivery.cod_total_amount_required) * 100);
      const iname = formatItemName(delivery.delivery_date, rsa, epn);
      const catItem = await createCatalogItem({ itemName: iname, amountCents: ac, locationId, deliveryId: delivery.id, patientName: epn, token: accessToken });
      const catId = catItem?.id || null;
      const catVer = catItem?.version || null;
      if (catId) {
        // Write to SquareTransaction DB
        const exTx = await base44.asServiceRole.entities.SquareTransaction.filter({ delivery_id: delivery.id, status: 'pending' }).catch(() => []);
        const tp = { square_catalog_object_id: catId, square_catalog_version: catVer, item_name: iname, amount: Number(delivery.cod_total_amount_required), amount_cents: ac, patient_id: delivery.patient_id, store_id: delivery.store_id, location_id: locationId };
        if (exTx?.length > 0) await base44.asServiceRole.entities.SquareTransaction.update(exTx[0].id, tp).catch(() => null);
        else await base44.asServiceRole.entities.SquareTransaction.create({ ...tp, type: 'collection', status: 'pending', delivery_id: delivery.id }).catch(() => null);
        // Write to SquareCatalogItems DB
        const exCat = await base44.asServiceRole.entities.SquareCatalogItems.filter({ delivery_id: delivery.id }).catch(() => []);
        const cp = { square_catalog_object_id: catId, square_catalog_version: catVer, item_name: iname, description: '', amount: Number(delivery.cod_total_amount_required || 0), amount_cents: ac, delivery_id: delivery.id, delivery_date: delivery.delivery_date || null, patient_id: delivery.patient_id || null, store_id: delivery.store_id || null, location_id: locationId, status: 'active' };
        if (exCat?.length > 0) await base44.asServiceRole.entities.SquareCatalogItems.update(exCat[0].id, cp).catch(() => null);
        else await base44.asServiceRole.entities.SquareCatalogItems.create(cp).catch(() => null);
      }
      createResults.push({ deliveryId: delivery.id, status: 'ok', catalogObjectId: catId });
    } catch (e) {
      console.error('[squareSyncCatalog2] Create error for', delivery.id, ':', e?.message);
      createResults.push({ deliveryId: delivery.id, status: 'error', error: e?.message });
    }
  }

  // ── Step 3: Fetch orders and identify collected items for cleanup ──
  const locationIds = Array.from(new Set(safeConfigs.filter((c) => c?.status === 'active').map((c) => c?.square_location_id).filter(Boolean)));
  const completedOrders = await listOrders(locationIds, getLookbackStartAt(daysBack), accessToken, MAX_TRANSACTION_ORDERS, ['COMPLETED', 'OPEN']).catch(() => []);
  const refundedOrderIds = buildRefundedOrderIdSet(completedOrders);
  const paidOrderItems = flattenOrderItems((completedOrders || []).filter((o) => !refundedOrderIds.has(o?.id)));
  const paidCatalogObjectIds = new Set(paidOrderItems.map((x) => x.catalog_object_id).filter(Boolean));

  // Get live catalog to find collected items
  const liveCatalogItems = await listActiveCatalogItems(accessToken).catch(() => []);

  // Build collected delivery IDs (from delivery status + cod_payments)
  const COLLECTED_PAYMENT_TYPES = new Set(['Cash', 'Check', 'Other', 'Debit', 'Credit', 'cash', 'check', 'other', 'debit', 'credit', 'card']);
  const deliveryHasRecordedCodPayment = (d) => (Array.isArray(d?.cod_payments) ? d.cod_payments : []).some((p) => Number(p?.amount || 0) > 0 && COLLECTED_PAYMENT_TYPES.has(String(p?.type || '')));
  const collectedDeliveryIds = new Set(
    safeDeliveries.filter((d) => d?.status === 'completed' && deliveryHasRecordedCodPayment(d)).map((d) => d?.id).filter(Boolean)
  );
  // Also include deliveries with completed Square transactions
  for (const pi of paidOrderItems) {
    if (pi?.transaction_status === 'completed') {
      // Try to match to a delivery by amount + patient name
      const abbrStore = safeStores.find((s) => itemNameContainsStore(pi.item_name, s));
      const locationStore = resolveStoreForItem(pi.item_name, pi.location_id, storesByLocationId);
      const resolvedStore = abbrStore || locationStore;
      const cands = resolvedStore ? safeDeliveries.filter((d) => d.store_id === resolvedStore.id) : safeDeliveries;
      for (const d of cands) {
        if (d?.cod_total_amount_required && toAmountCents(d.cod_total_amount_required * 100) === toAmountCents(pi.amount_cents) && d?.status === 'completed') {
          collectedDeliveryIds.add(d.id);
          break;
        }
      }
    }
  }
  const extractDeliveryIdFromCatalog = (item) => {
    const desc = String(item?.item_data?.description || '').toLowerCase();
    const m = desc.match(/delivery\s+([a-f0-9]{24})/i);
    return m ? m[1] : null;
  };

  const toDelete = (liveCatalogItems || []).filter((item) => {
    if (!item?.id) return false;
    const varIds = (item?.item_data?.variations || []).map((v) => v?.id).filter(Boolean);
    if (paidCatalogObjectIds.has(item.id)) return true;
    if (varIds.some((v) => paidCatalogObjectIds.has(v))) return true;
    // Structured name match against paid order items
    const n = normalizeText(item?.item_data?.name);
    if (isStructuredCodName(n) && paidOrderItems.some((pi) => normalizeText(pi.item_name) === n)) return true;
    // Description → delivery_id → already collected
    const descDeliveryId = extractDeliveryIdFromCatalog(item);
    if (descDeliveryId && collectedDeliveryIds.has(descDeliveryId)) return true;
    return false;
  });

  // ── Delete collected items (inline — no base44.functions.invoke) ──
  let deletedCount = 0;
  for (const item of toDelete) {
    const del = await deleteCatalogObject(item.id, accessToken);
    if (del?.ok) {
      deletedCount++;
      // Clean up DB records
      const dbMatches = await base44.asServiceRole.entities.SquareCatalogItems.filter({ square_catalog_object_id: item.id }).catch(() => []);
      for (const r of dbMatches) await base44.asServiceRole.entities.SquareCatalogItems.delete(r.id).catch(() => null);
      // Update transaction status
      const txMatches = await base44.asServiceRole.entities.SquareTransaction.filter({ square_catalog_object_id: item.id }).catch(() => []);
      for (const tx of txMatches) await base44.asServiceRole.entities.SquareTransaction.update(tx.id, { status: 'completed' }).catch(() => null);
    }
  }

  // ── Step 4: Mirror catalog to DB (inline — no base44.functions.invoke) ──
  const catalogRecords = (liveCatalogItems || []).map((item) => {
    const itemName = normalizeText(item?.item_data?.name);
    const ac = getCatalogItemAmountCents(item);
    const lids = getCatalogItemLocationIds(item);
    const rl = lids.find((l) => storesByLocationId.has(l)) || lids[0];
    const store = resolveStoreForItem(itemName, rl, storesByLocationId);
    return { square_catalog_object_id: item.id, square_catalog_version: item.version || null, item_name: itemName, description: item?.item_data?.description || '', amount: ac / 100, amount_cents: ac, delivery_id: null, delivery_date: toIsoDate(itemName), patient_id: null, store_id: store?.id || null, location_id: rl, status: 'active' };
  });

  // Upsert catalog records to DB
  let mirrorDbCount = 0;
  const existingByObjId = new Map(existingCatalog.map((r) => [r.square_catalog_object_id, r]));
  for (const cr of catalogRecords) {
    const existing = existingByObjId.get(cr.square_catalog_object_id);
    if (existing) {
      const changed = existing.item_name !== cr.item_name || existing.amount !== cr.amount || existing.status !== cr.status;
      if (changed) await base44.asServiceRole.entities.SquareCatalogItems.update(existing.id, cr).catch(() => null);
    } else {
      await base44.asServiceRole.entities.SquareCatalogItems.create(cr).catch(() => null);
      mirrorDbCount++;
    }
  }
  // Remove DB records for catalog items no longer in Square
  const liveObjIds = new Set(catalogRecords.map((r) => r.square_catalog_object_id));
  for (const existing of existingCatalog) {
    if (existing?.square_catalog_object_id && !liveObjIds.has(existing.square_catalog_object_id)) {
      await base44.asServiceRole.entities.SquareCatalogItems.delete(existing.id).catch(() => null);
      mirrorDbCount--;
    }
  }

  return {
    success: true,
    mirrorResult: { success: true, catalogCount: catalogRecords.length, dbDelta: mirrorDbCount },
    created: createResults.filter((r) => r.status === 'ok').length,
    createErrors: createResults.filter((r) => r.status === 'error').length,
    deleted: deletedCount,
    syncOnlineResult: { success: true },
    catalogCount: catalogRecords.length,
  };
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const payload = await req.json().catch(() => ({}));
    await requireAdminIfAuthenticated(base44);
    return Response.json(await handleSyncCatalog(base44, payload));
  } catch (error) {
    const status = error?.status || 500;
    return Response.json({ error: error?.message || 'Internal Server Error' }, { status });
  }
});
