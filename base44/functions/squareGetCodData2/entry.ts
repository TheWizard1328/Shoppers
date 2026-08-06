import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

class HttpError extends Error { constructor(s, m) { super(m); this.status = s; } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const normalizeText = (v) => String(v || '').trim();
const toAmountCents = (v) => Math.max(0, Math.round(Number(v || 0)));
const requireUser = async (b44) => { const u = await b44.auth.me().catch(() => null); if (!u) throw new HttpError(401, 'Unauthorized'); return u; };
const ensureSquareToken = () => { const t = Deno.env.get('SQUARE_ACCESS_TOKEN'); if (!t) throw new HttpError(500, 'Square credentials not configured'); return t; };
const SQUARE_BASE_URL = 'https://connect.squareup.com';
const SQUARE_VERSION = '2025-01-23';
const SQUARE_API_MAX_RETRIES = 3;
const SQUARE_RETRY_BASE_DELAY_MS = 400;
const isRetryableSquareStatus = (s) => [408, 409, 429, 500, 502, 503, 504].includes(Number(s));

async function squareFetch(path, method, accessToken, body) {
  let lastError=null;
  for (let attempt=1;attempt<=SQUARE_API_MAX_RETRIES;attempt++) {
    try {
      const response=await fetch(`${SQUARE_BASE_URL}${path}`,{method,headers:{Authorization:`Bearer ${accessToken}`,'Content-Type':'application/json','Square-Version':SQUARE_VERSION},body:body?JSON.stringify(body):undefined});
      const text=await response.text();const json=text?JSON.parse(text):{};
      if(!response.ok){const msg=json?.errors?.map((e)=>e.detail).join(', ')||`Square API error ${response.status}`;lastError=new HttpError(response.status,msg);if(attempt<SQUARE_API_MAX_RETRIES&&isRetryableSquareStatus(response.status)){await sleep(SQUARE_RETRY_BASE_DELAY_MS*attempt);continue;}throw lastError;}
      return json;
    } catch(error){lastError=error;if(attempt<SQUARE_API_MAX_RETRIES){await sleep(SQUARE_RETRY_BASE_DELAY_MS*attempt);continue;}throw lastError;}
  }
  throw lastError||new Error('Square API request failed');
}

const TRANSACTION_RETENTION_DAYS = 90;
const MATCH_DATE_STRICT_DAYS = 7;
const MAX_TRANSACTION_ORDERS = 2000;
const DELIVERY_BULK_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const DB_WRITE_BATCH_SIZE = 10;
const formatLocalDate = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const unwrapEntityRecord = (r) => { if (!r || typeof r !== 'object') return null; if (r.data && typeof r.data === 'object') return { ...r.data, id: r.data.id || r.id }; return r; };
const shouldRefreshDeliveries = (at, force=false) => { if (force) return true; const ms = new Date(at||0).getTime(); return !Number.isFinite(ms)||ms<=0||Date.now()-ms>=DELIVERY_BULK_REFRESH_INTERVAL_MS; };
const getTransactionRetentionStartMs = () => { const t = new Date(); t.setHours(0,0,0,0); t.setDate(t.getDate()-TRANSACTION_RETENTION_DAYS); return t.getTime(); };
const shouldIgnoreManualOrderLabel = (v) => ['top ups','top up','topup','tip','top'].includes(String(v||'').replace(/\s+/g,' ').trim().toLowerCase());
const normalizeMatchName = (v) => normalizeText(v).replace(/\s+/g,' ').replace(/\s-\s\$\d+(?:\.\d{2})?$/,'').replace(/^(\d{2})-(\d{2})/,'$1/$2').toLowerCase();
const getPreferredStoreAbbreviation = (store) => { const n=normalizeText(store?.abbreviation); if (n) return n.toUpperCase(); const ts=normalizeText(store?.name).split(/[^a-zA-Z0-9]+/).map((p)=>p.trim()).filter(Boolean); if (!ts.length) return 'NA'; if (ts.length===1) return ts[0].slice(0,2).toUpperCase(); return ts.map((t)=>t[0]).join('').slice(0,2).toUpperCase(); };
const buildItemSignature = (n, c) => `${normalizeText(n)}::${toAmountCents(c)}`;

function extractItemNameAbbr(itemName) { const m = String(itemName||'').match(/\(([^)]+)\)/); return m ? normalizeText(m[1]).toUpperCase() : ''; }
function getStoreAbbreviationVariants(store) {
  const vs=new Set();const push=(v)=>{const n=normalizeText(v);if(!n)return;vs.add(n.toLowerCase());n.split(/[^a-zA-Z0-9]+/).map((p)=>p.trim().toLowerCase()).filter(Boolean).forEach((p)=>vs.add(p));};
  push(store?.abbreviation);push(store?.name);return Array.from(vs);
}
const itemNameContainsStore=(itemName,store)=>{const n=normalizeMatchName(itemName);return !!n&&getStoreAbbreviationVariants(store).some((v)=>n.includes(v));};
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

function tokenizeName(v) { return normalizeMatchName(v).replace(/[^a-z0-9\s]/g,' ').split(' ').map((p)=>p.trim()).filter((p)=>p.length>=2); }
function levenshteinDistance(a,b) { const l=String(a||'');const r=String(b||'');if(!l)return r.length;if(!r)return l.length;const m=Array.from({length:l.length+1},()=>Array(r.length+1).fill(0));for(let i=0;i<=l.length;i++)m[i][0]=i;for(let j=0;j<=r.length;j++)m[0][j]=j;for(let i=1;i<=l.length;i++)for(let j=1;j<=r.length;j++){const c=l[i-1]===r[j-1]?0:1;m[i][j]=Math.min(m[i-1][j]+1,m[i][j-1]+1,m[i-1][j-1]+c);}return m[l.length][r.length]; }
function notesContainPatientName(notesValue, patientName) {
  const nn=normalizeMatchName(notesValue).replace(/[^a-z0-9\s]/g,' ');const np=normalizeMatchName(patientName).replace(/[^a-z0-9\s]/g,' ');if(!nn||!np)return false;if(nn.includes(np))return true;
  const pt=tokenizeName(np);const nt=tokenizeName(nn);if(!pt.length||!nt.length)return false;
  if(pt.every((t)=>nt.some((n)=>n.includes(t)||t.includes(n))))return true;
  const ol=pt.filter((t)=>nt.some((n)=>n.includes(t)||t.includes(n))).length;if(pt.length>=2&&ol>=Math.min(2,pt.length))return true;
  return pt.every((t)=>nt.some((n)=>{const d=levenshteinDistance(t,n);return Math.max(t.length,n.length)>=4&&d<=1;}));
}

const getCatalogItemLocationIds = (item) => Array.from(new Set([...(item?.present_at_location_ids||[]),...(item?.item_data?.variations||[]).flatMap((v)=>v?.present_at_location_ids||[])].filter(Boolean)));
const getCatalogItemAmountCents = (item) => { const vs=item?.item_data?.variations||[]; const v=vs.find((e)=>e?.item_variation_data?.price_money?.amount!=null)||vs[0]; return toAmountCents(v?.item_variation_data?.price_money?.amount); };
const isStructuredCodName = (v) => /^\d{2}[\/-]\d{2}\([^)]+\)-.+/.test(String(v||'').trim());
function structuredCodNamesMatch(txName, catalogName) {
  if (!isStructuredCodName(txName) || !isStructuredCodName(catalogName)) return null;
  if (normalizeText(txName) !== normalizeText(catalogName)) return false;
  return true;
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
function buildRefundedOrderIdSet(orders) {
  const s = new Set();
  for (const o of orders || []) { if (isOrderFullyRefunded(o)) s.add(o.id); }
  return s;
}
function flattenOrderItems(orders) {
  const items=[];
  for(const order of orders||[]){
    const lineItems=order?.line_items||[];
    const refundedQtyByUid=new Map();
    for(const rli of order?.return_line_items||[]){const uid=rli?.source_line_item_uid;if(!uid)continue;const rq=Math.round(Number(rli?.quantity||1))||1;refundedQtyByUid.set(uid,(refundedQtyByUid.get(uid)||0)+rq);}
    for(const li of lineItems){
      const itemName=normalizeText(li?.name||li?.note);
      if(!itemName||shouldIgnoreManualOrderLabel(itemName))continue;
      const totalQty=Math.round(Number(li?.quantity||1))||1;
      const refundedQty=refundedQtyByUid.get(li?.uid)||0;
      const netQty=Math.max(0,totalQty-refundedQty);
      if(netQty<=0)continue;
      const eu=toAmountCents(li?.base_price_money?.amount);
      const gr=toAmountCents(li?.gross_sales_money?.amount||li?.total_money?.amount);
      const ac=eu||(totalQty>0?Math.round(gr/totalQty):gr);
      const ts=order?.state==='COMPLETED'?'completed':'pending';
      for(let i=0;i<netQty;i++)items.push({order_id:order?.id,line_item_uid:li?.uid?`${li.uid}-${i}`:(order?.id+'-'+(li?.catalog_object_id||itemName)+'-'+i),location_id:order?.location_id||null,item_name:itemName,amount_cents:ac,catalog_object_id:li?.catalog_object_id||null,payment_date:order?.created_at||null,order_created_at:order?.created_at||null,note:order?.note||'',order_state:order?.state||null,transaction_status:ts});
    }
  }
  return items;
}

async function safeDeleteSquareCatalogObject(catalogObjectId, accessToken) {
  if (!catalogObjectId) return {attempted:false,ok:false};
  let lastFailure=null;
  for (let attempt=1;attempt<=SQUARE_API_MAX_RETRIES;attempt++) {
    try {
      const r=await fetch(`${SQUARE_BASE_URL}/v2/catalog/object/${catalogObjectId}`,{method:'DELETE',headers:{Authorization:`Bearer ${accessToken}`,'Square-Version':SQUARE_VERSION}});
      const text=await r.text();let body=null;try{body=text?JSON.parse(text):null;}catch{body=text||null;}
      if(r.ok||r.status===404)return{attempted:true,ok:true,status:r.status,body};
      lastFailure={attempted:true,ok:false,status:r.status,body};if(attempt<SQUARE_API_MAX_RETRIES&&isRetryableSquareStatus(r.status)){await sleep(SQUARE_RETRY_BASE_DELAY_MS*attempt);continue;}return lastFailure;
    } catch(e){lastFailure={attempted:true,ok:false,error:e?.message||String(e)};if(attempt<SQUARE_API_MAX_RETRIES){await sleep(SQUARE_RETRY_BASE_DELAY_MS*attempt);continue;}return lastFailure;}
  }
  return lastFailure||{attempted:true,ok:false,error:'Delete failed'};
}
async function deleteCatalogObjects(objectIds, accessToken) {
  if (!objectIds.length) return {deleted:[],failed:[]};
  try{await squareFetch('/v2/catalog/batch-delete','POST',accessToken,{object_ids:objectIds});return{deleted:objectIds,failed:[]};}
  catch{const deleted=[];const failed=[];for(const id of objectIds){const r=await safeDeleteSquareCatalogObject(id,accessToken);if(r?.ok)deleted.push(id);else failed.push({objectId:id,result:r});}if(failed.length)throw new Error(`Failed to delete: ${failed.map((e)=>e.objectId).join(', ')}`);return{deleted,failed:[]};}
}

// Batch DB writes in parallel chunks to avoid sequential bottleneck
async function batchWriteEntities(entityApi, operations) {
  const results = [];
  for (let i = 0; i < operations.length; i += DB_WRITE_BATCH_SIZE) {
    const chunk = operations.slice(i, i + DB_WRITE_BATCH_SIZE);
    const chunkResults = await Promise.all(chunk.map((op) =>
      op.type === 'create' ? entityApi.create(op.data) : entityApi.update(op.id, op.data)
    ));
    results.push(...chunkResults);
  }
  return results;
}

async function handleGetCodData(base44, payload={}) {
  const t0 = Date.now();
  console.log('[squareGetCodData2] START');
  const user = await requireUser(base44);
  const accessToken = ensureSquareToken();
  const daysBack = Math.max(1, Number(payload?.daysBack||TRANSACTION_RETENTION_DAYS)||TRANSACTION_RETENTION_DAYS);
  const refreshDeliveries = shouldRefreshDeliveries(payload?.lastDeliverySyncAt, payload?.forceDeliveryRefresh===true);
  const lookbackStartAt = new Date(Date.now() - daysBack * 86400000).toISOString();

  // ── 1) Fetch ALL entity context in parallel ──────────────────────────
  console.log('[squareGetCodData2] Fetching entity context...');
  const [allLocationConfigs, stores, appUsers, patients, existingTransactionsRaw, existingCatalogDb] = await Promise.all([
    base44.asServiceRole.entities.SquareLocationConfig.list('-updated_date', 500).catch(() => []),
    base44.asServiceRole.entities.Store.list('-updated_date', 500).catch(() => []),
    base44.asServiceRole.entities.AppUser.list('-updated_date', 2000).catch(() => []),
    base44.asServiceRole.entities.Patient.list('-updated_date', 5000).catch(() => []),
    base44.asServiceRole.entities.SquareTransaction.list('-updated_date', 5000).catch(() => []),
    base44.asServiceRole.entities.SquareCatalogItems.list('-updated_date', 2000).catch(() => []),
  ]);

  const safeAllConfigs = (Array.isArray(allLocationConfigs) ? allLocationConfigs : []).map(unwrapEntityRecord).filter(Boolean);
  const safeConfigs = safeAllConfigs.filter((c) => c?.status === 'active');
  const safeStores = (Array.isArray(stores) ? stores : []).map(unwrapEntityRecord).filter(Boolean);
  const existingTransactions = (Array.isArray(existingTransactionsRaw) ? existingTransactionsRaw : []).map(unwrapEntityRecord).filter(Boolean);
  const activeConfigById = new Map(safeConfigs.map((c) => [c.id, c]));
  const storesByLocationId = buildStoresByLocationId(safeStores, activeConfigById);
  const locationIds = Array.from(new Set(safeAllConfigs.map((c) => c?.square_location_id).filter(Boolean)));
  const drivers = (appUsers || []).filter((u) => Array.isArray(u?.app_roles) && u.app_roles.includes('driver'));
  const patientsById = new Map((patients || []).map((p) => [p.id, p]));

  // Build fast lookup index for existing transactions (avoids O(n) scan per item)
  const existingTxIndex = new Map();
  for (const t of existingTransactions) {
    const key = `${normalizeText(t?.square_transaction_id)}::${normalizeText(t?.raw_square_data?.line_item_uid)}`;
    existingTxIndex.set(key, t);
  }

  console.log('[squareGetCodData2] Context loaded:', {
    stores: safeStores.length, configs: safeAllConfigs.length, locationIds: locationIds.length,
    existingTx: existingTransactions.length, patients: patientsById.size, drivers: drivers.length,
    elapsed: Date.now() - t0
  });

  // ── 2) Fetch Square API: catalog + orders in parallel (ONE pass each) ─
  console.log('[squareGetCodData2] Fetching Square catalog + orders...');
  const [liveCatalogItems, completedOrders] = await Promise.all([
    listActiveCatalogItems(accessToken),
    listOrders(locationIds, lookbackStartAt, accessToken, MAX_TRANSACTION_ORDERS, ['COMPLETED', 'OPEN']),
  ]);
  console.log('[squareGetCodData2] Square API done:', {
    catalogItems: liveCatalogItems.length, orders: completedOrders.length,
    elapsed: Date.now() - t0
  });

  // ── 3) Process orders → transaction records ───────────────────────────
  const refundedOrderIds = buildRefundedOrderIdSet(completedOrders);
  const paidOrderItems = flattenOrderItems(
    (completedOrders || []).filter((o) => !refundedOrderIds.has(o?.id))
  ).filter((item) => {
    const t = new Date(item?.payment_date || item?.order_created_at || 0).getTime();
    return Number.isFinite(t) && t >= getTransactionRetentionStartMs();
  });
  console.log('[squareGetCodData2] Paid order items:', paidOrderItems.length, 'elapsed:', Date.now() - t0);

  // Delivery matching context
  const deliveriesWithAmounts = (await (async () => {
    if (!refreshDeliveries) return [];
    const startDateStr = formatLocalDate(new Date(Date.now() - daysBack * 86400000));
    const endDateStr = formatLocalDate(new Date());
    const storeSquareEligibility = new Map();
    for (const store of safeStores) {
      const c = activeConfigById.get(store?.square_location_config_id);
      if (!c?.square_location_id) continue;
      const fh = Array.isArray(store.app_fee_history) ? store.app_fee_history : [];
      const ae = fh.filter((e) => e?.pays_app_fees === true && e?.effective_date).sort((a, b) => String(a.effective_date).localeCompare(String(b.effective_date)));
      storeSquareEligibility.set(store.id, ae.length > 0 ? ae[0].effective_date : null);
    }
    const rawDeliveries = await base44.asServiceRole.entities.Delivery.filter({ delivery_date: { $gte: startDateStr, $lte: endDateStr } }, '-updated_date', 5000).catch(() => []);
    const all = (Array.isArray(rawDeliveries) ? rawDeliveries : []).map(unwrapEntityRecord).filter(Boolean);
    return all.filter((d) => { if (!storeSquareEligibility.has(d?.store_id)) return false; const ef = storeSquareEligibility.get(d.store_id); return !(ef && d.delivery_date < ef); });
  })());

  console.log('[squareGetCodData2] Deliveries loaded:', deliveriesWithAmounts.length, 'elapsed:', Date.now() - t0);

  // Pre-build delivery index by store_id for faster matching
  const deliveriesByStoreId = new Map();
  for (const d of deliveriesWithAmounts) {
    if (!d?.store_id) continue;
    if (!deliveriesByStoreId.has(d.store_id)) deliveriesByStoreId.set(d.store_id, []);
    deliveriesByStoreId.get(d.store_id).push(d);
  }

  const getDriverFromDelivery = (d) => drivers.find((dr) => dr?.user_id === d?.driver_id || dr?.id === d?.driver_id) || null;
  const txIsOnOrAfterDelivery = (payIso, deliveryDate) => { if (!payIso || !deliveryDate) return true; return payIso >= deliveryDate; };
  const sortByDateProximity = (candidates, payIso) => {
    if (!payIso || candidates.length <= 1) return candidates;
    const payMs = new Date(payIso + 'T00:00:00').getTime();
    if (!Number.isFinite(payMs)) return candidates;
    return [...candidates].sort((a, b) => {
      const da = Math.abs(new Date((a.delivery_date || '') + 'T00:00:00').getTime() - payMs);
      const db = Math.abs(new Date((b.delivery_date || '') + 'T00:00:00').getTime() - payMs);
      return da - db;
    });
  };

  // Optimized: use store-indexed deliveries instead of scanning all
  const getDeliveryCandidatesForItem = (item, resolvedStore) => {
    const payIso = (item?.payment_date || item?.order_created_at || '').slice(0, 10);
    const combined = `${normalizeText(item?.note || '')} ${normalizeText(item?.item_name || '')}`.trim();
    const locationStores = storesByLocationId.get(item?.location_id) || [];
    // Gather candidate deliveries from all stores at this location
    const candidatePool = [];
    for (const s of locationStores) {
      const storeDels = deliveriesByStoreId.get(s?.id) || [];
      storeDels.forEach((d) => candidatePool.push(d));
    }
    const raw = candidatePool.filter((d) => {
      const matchingStore = locationStores.find((s) => s?.id === d?.store_id) || resolvedStore;
      if (matchingStore && !itemNameContainsStore(item?.item_name, matchingStore) && !itemNameContainsStore(item?.note, matchingStore)) {
        const anyStoreMatch = locationStores.some((s) => itemNameContainsStore(item?.item_name, s) || itemNameContainsStore(item?.note, s));
        if (!anyStoreMatch) return false;
      }
      const da = Math.round(Number(d?.cod_total_amount_required || 0) * 100);
      if (da !== toAmountCents(item?.amount_cents)) return false;
      if (!txIsOnOrAfterDelivery(payIso, d?.delivery_date)) return false;
      const pt = patientsById.get(d?.patient_id);
      return pt && notesContainPatientName(combined, pt.full_name);
    });
    return sortByDateProximity(raw, payIso);
  };
  // Cross-location fallback: when the item name is NOT structured (doesn't follow
  // MM/DD(STORE)-Patient Name), search ALL stores across ALL Square locations.
  // Relies on exact amount match + chronology (tx date >= delivery date) + fuzzy
  // patient name match (handles misspellings and varied name/abbr orderings).
  const getCrossLocationDeliveryCandidates = (item) => {
    const payIso = (item?.payment_date || item?.order_created_at || '').slice(0, 10);
    const combined = `${normalizeText(item?.note || '')} ${normalizeText(item?.item_name || '')}`.trim();
    const candidatePool = [];
    for (const s of safeStores) {
      const storeDels = deliveriesByStoreId.get(s?.id) || [];
      storeDels.forEach((d) => candidatePool.push(d));
    }
    const raw = candidatePool.filter((d) => {
      const da = Math.round(Number(d?.cod_total_amount_required || 0) * 100);
      if (da !== toAmountCents(item?.amount_cents)) return false;
      if (!txIsOnOrAfterDelivery(payIso, d?.delivery_date)) return false;
      const pt = patientsById.get(d?.patient_id);
      return pt && notesContainPatientName(combined, pt.full_name);
    });
    return sortByDateProximity(raw, payIso);
  };

  // Pick the best delivery match from a candidate list using note/id/name heuristics.
  const pickBestFromCandidates = (cands, note, item, payIso, preferredStoreId) => {
    if (!cands.length) return null;
    const ssc = preferredStoreId ? cands.filter((d) => d?.store_id === preferredStoreId) : [];
    const pri = ssc.length ? [...ssc, ...cands.filter((d) => d?.store_id !== preferredStoreId)] : cands;
    const dm = note.match(/delivery\s*(id|#)?\s*[:=-]?\s*([a-f0-9]{24})/i);
    if (dm) { const m = pri.find((d) => d?.id === dm[2]); if (m) return m; }
    const sm = note.match(/\b(?:sid|stop\s*id)\s*[:=-]?\s*([a-z0-9-]+)/i);
    if (sm) { const m = pri.find((d) => normalizeText(d?.stop_id).toLowerCase() === normalizeText(sm[1]).toLowerCase()); if (m) return m; }
    const withinWindow = (d) => { if (!payIso || !d?.delivery_date) return false; const diffMs = new Date(payIso + 'T00:00:00').getTime() - new Date(d.delivery_date + 'T00:00:00').getTime(); return diffMs >= 0 && diffMs <= MATCH_DATE_STRICT_DAYS * 86400000; };
    const closeByNote = pri.find((d) => withinWindow(d) && notesContainPatientName(note, patientsById.get(d?.patient_id)?.full_name || ''));
    if (closeByNote) return closeByNote;
    const closeByName = pri.find((d) => withinWindow(d) && notesContainPatientName(item?.item_name, patientsById.get(d?.patient_id)?.full_name || ''));
    if (closeByName) return closeByName;
    return pri.find((d) => { const p = patientsById.get(d?.patient_id); return p && notesContainPatientName(note, p.full_name); }) || pri.find((d) => { const p = patientsById.get(d?.patient_id); return p && notesContainPatientName(item?.item_name, p.full_name); }) || pri[0];
  };

  const matchDeliveryForItem = (item, resolvedStore) => {
    const note = normalizeText(item?.note || '');
    const payIso = (item?.payment_date || item?.order_created_at || '').slice(0, 10);
    // Primary: location-scoped match (same Square location as the transaction)
    const cands = getDeliveryCandidatesForItem(item, resolvedStore);
    const primary = pickBestFromCandidates(cands, note, item, payIso, resolvedStore?.id);
    if (primary) return primary;
    // Fallback: non-structured names — search across ALL Square locations by
    // amount + chronology + fuzzy patient name (handles misspellings / varied formats)
    if (!isStructuredCodName(item?.item_name)) {
      const xlCands = getCrossLocationDeliveryCandidates(item);
      return pickBestFromCandidates(xlCands, note, item, payIso, resolvedStore?.id);
    }
    return null;
  };

  // Build all transaction records + prepare batch writes
  console.log('[squareGetCodData2] Matching deliveries + building transaction records...');
  const txToCreate = [];
  const txToUpdate = [];
  const transactionRecords = [];
  const seenKeys = new Set();

  for (const item of paidOrderItems) {
    const ukey = `${item?.order_id}::${item?.line_item_uid}`;
    if (seenKeys.has(ukey)) continue;
    seenKeys.add(ukey);
    const store = resolveStoreForItem(item?.item_name, item?.location_id, storesByLocationId);
    const md = matchDeliveryForItem(item, store);
    const mp = md ? patientsById.get(md?.patient_id) : null;
    const mdr = md ? getDriverFromDelivery(md) : null;
    const ms = md ? (safeStores || []).find((s) => s?.id === md.store_id) || store : store;
    const isCustom = !normalizeText(item?.catalog_object_id);
    const fmtName = md ? formatItemName(md.delivery_date, getPreferredStoreAbbreviation(ms), mp?.full_name || md?.patient_name) : '';
    const dn = isCustom && fmtName ? fmtName : (item?.item_name || '');
    const txKey = `${normalizeText(item?.order_id)}::${normalizeText(item?.line_item_uid)}`;
    const existing = existingTxIndex.get(txKey);
    const pr = {
      square_transaction_id: item?.order_id || null,
      square_payment_id: `${item?.order_id || 'order'}:${item?.line_item_uid || 'line'}`,
      square_catalog_object_id: item?.catalog_object_id || null,
      item_name: dn,
      amount: toAmountCents(item?.amount_cents) / 100,
      amount_cents: toAmountCents(item?.amount_cents),
      type: 'collection',
      status: item?.transaction_status || 'pending',
      delivery_id: md?.id || null,
      patient_id: mp?.id || md?.patient_id || null,
      store_id: md?.store_id || store?.id || null,
      location_id: item?.location_id || null,
      driver_id: md?.driver_id || mdr?.id || mdr?.user_id || null,
      dispatcher_id: md?.created_by_app_user_id || null,
      payment_method: 'card',
      raw_square_data: { ...(existing?.raw_square_data || {}), line_item_uid: item?.line_item_uid || null, payment_date: item?.payment_date || null, order_created_at: item?.order_created_at || null, order_state: item?.order_state || null, notes: item?.note || '', original_item_name: item?.item_name || '', is_custom_amount: isCustom, matched_by: md ? 'delivery_match' : 'unmatched' }
    };
    if (existing) {
      // Skip update if nothing changed (quick field comparison)
      const changed = existing.item_name !== pr.item_name || existing.status !== pr.status || existing.delivery_id !== pr.delivery_id || existing.driver_id !== pr.driver_id || existing.patient_id !== pr.patient_id || existing.store_id !== pr.store_id;
      if (changed) {
        txToUpdate.push({ type: 'update', id: existing.id, data: pr });
        transactionRecords.push({ id: existing.id, ...pr });
      } else {
        transactionRecords.push(existing);
      }
    } else {
      txToCreate.push({ type: 'create', data: pr });
    }
  }

  console.log('[squareGetCodData2] Transaction prep done:', {
    total: transactionRecords.length, toCreate: txToCreate.length, toUpdate: txToUpdate.length,
    skipped: paidOrderItems.length - txToCreate.length - txToUpdate.length,
    elapsed: Date.now() - t0
  });

  // SKIP DB writes for transactions — the frontend saves transactionRecords to IDB directly.
  // Writing to the online DB was the bottleneck causing 429 timeouts for driver devices.
  // For new transactions (no existing ID), add a synthetic ID so the frontend can dedupe.
  for (const op of txToCreate) {
    transactionRecords.push({ ...op.data, id: `${op.data.square_transaction_id || 'tx'}::${op.data.raw_square_data?.line_item_uid || 'unknown'}` });
  }

  console.log('[squareGetCodData2] Transaction records built (DB writes skipped), elapsed:', Date.now() - t0);

  // ── 4) Build catalog records from live Square catalog ───────────────
  // Role-neutral: link catalog items to deliveries by name+amount+location
  // even when no Square transaction has been recorded yet. Without this, the
  // catalog item's delivery_id stays null, and the frontend's reconciliation
  // fallback falls back to fuzzy patient-name matching against the locally
  // scoped patients state — admins see all patients, drivers see their
  // city's subset, so the same catalog item links for admin but not driver.
  const catalogRecords = (liveCatalogItems || []).reduce((acc, item) => {
    const ac = getCatalogItemAmountCents(item);
    const itemName = item?.item_data?.name || '';
    if (!itemName) return acc;
    const lids = getCatalogItemLocationIds(item);
    if (!lids.length) return acc;
    const mt = (existingTransactions || []).find((t) =>
      normalizeText(t.square_catalog_object_id) === normalizeText(item?.id) ||
      buildItemSignature(t?.item_name, t?.amount_cents ?? Math.round(Number(t?.amount || 0) * 100)) === buildItemSignature(itemName, ac)
    );
    const rl = mt?.location_id && lids.includes(mt.location_id) ? mt.location_id : lids.find((l) => storesByLocationId.has(l)) || lids[0];
    const store = resolveStoreForItem(itemName, rl, storesByLocationId);
    let deliveryId = mt?.delivery_id || null;
    let patientId = mt?.patient_id || null;
    let storeId = mt?.store_id || null;
    if (!deliveryId) {
      // No matching transaction yet — try matching the catalog item to a
      // delivery by name + amount + location. Reads only service-role data
      // that is already loaded, so the result is identical for every user
      // regardless of role-scoped offline caches.
      const matchedDelivery = matchDeliveryForItem({ item_name: itemName, note: '', amount_cents: ac, location_id: rl, payment_date: null, order_created_at: null }, store);
      if (matchedDelivery) {
        deliveryId = matchedDelivery.id;
        const matchedPatient = patientsById.get(matchedDelivery.patient_id);
        patientId = matchedPatient?.id || matchedDelivery.patient_id || null;
        storeId = matchedDelivery.store_id || null;
      }
    }
    acc.push({ id: item?.id, square_catalog_object_id: item?.id, square_catalog_version: item?.version || null, item_name: itemName, description: item?.item_data?.description || '', amount: ac / 100, amount_cents: ac, delivery_id: deliveryId, delivery_date: toIsoDate(itemName), patient_id: patientId, store_id: storeId || store?.id || null, location_id: rl, status: 'active' });
    return acc;
  }, []);

  // ── 5) Cleanup collected catalog items (reuses fetched data) ─────────
  const paidCatalogObjectIds = new Set(paidOrderItems.map((x) => x.catalog_object_id).filter(Boolean));
  const toDelete = (liveCatalogItems || []).filter((item) => {
    if (!item?.id) return false;
    const varIds = (item?.item_data?.variations || []).map((v) => v?.id).filter(Boolean);
    if (paidCatalogObjectIds.has(item.id)) return true;
    if (varIds.some((v) => paidCatalogObjectIds.has(v))) return true;
    const n = normalizeText(item?.item_data?.name);
    if (isStructuredCodName(n)) {
      return paidOrderItems.some((pi) => structuredCodNamesMatch(pi.item_name, n) === true);
    }
    return false;
  });

  let deletedCatalogIds = [];
  let cleanupDbCount = 0;
  if (toDelete.length > 0) {
    const objectIds = toDelete.map((i) => i.id).filter(Boolean);
    const deleteResult = await deleteCatalogObjects(objectIds, accessToken);
    deletedCatalogIds = deleteResult.deleted || [];
    // Clean up DB records for deleted objects — batch in parallel
    const dbCleanupPromises = objectIds.map(async (objId) => {
      const dbMatches = await base44.asServiceRole.entities.SquareCatalogItems.filter({ square_catalog_object_id: objId }).catch(() => []);
      for (const r of dbMatches) { await base44.asServiceRole.entities.SquareCatalogItems.delete(r.id).catch(() => null); cleanupDbCount++; }
      // Transaction status update skipped — transactions are no longer written to the online DB
      // (the frontend manages them in IDB). This was causing 429 timeouts for driver devices.
    });
    await Promise.all(dbCleanupPromises);
  }

  console.log('[squareGetCodData2] Cleanup done:', { deleted: deletedCatalogIds.length, dbCleaned: cleanupDbCount, elapsed: Date.now() - t0 });

  // ── 6) Return everything in one response ────────────────────────────
  const strippedDeliveries = deliveriesWithAmounts.map((d) => ({ id: d?.id, delivery_id: d?.delivery_id, delivery_date: d?.delivery_date, status: d?.status, cod_total_amount_required: d?.cod_total_amount_required, cod_payments: d?.cod_payments, store_id: d?.store_id, patient_id: d?.patient_id, driver_id: d?.driver_id, driver_name: d?.driver_name }));

  console.log('[squareGetCodData2] COMPLETE, elapsed:', Date.now() - t0, 'ms');

  return {
    success: true,
    deliveries: strippedDeliveries,
    shouldRefreshDeliveries: refreshDeliveries,
    deliverySyncWindow: { startDate: formatLocalDate(new Date(Date.now() - daysBack * 86400000)), endDate: formatLocalDate(new Date()), daysBack, refreshedAt: refreshDeliveries ? new Date().toISOString() : null },
    catalogRecords,
    transactionRecords,
    deletedCatalogIds,
    cleanupDbCount,
    locationConfigs: safeConfigs,
    locationIds,
  };
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const payload = await req.json().catch(() => ({}));
    return Response.json(await handleGetCodData(base44, payload));
  } catch(error) {
    const status = error?.status || 500;
    console.error('[squareGetCodData2] ERROR:', error?.message || error);
    return Response.json({ error: error?.message || 'Internal Server Error' }, { status });
  }
});