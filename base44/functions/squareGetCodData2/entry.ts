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
// Resolve a store by matching its abbreviation as a standalone token in the FULL
// item name text. Searches across ALL stores (not location-scoped) because multiple
// stores share one Square location (card). The abbreviation in the item name is the
// authoritative store signal — never the Square Location ID alone. Returns null when
// no store's abbreviation appears as a token in the text.
const resolveStoreByAbbrInText = (text, allStores) => {
  const tokens = new Set(tokenizeName(text));
  if (!tokens.size) return null;
  for (const s of allStores) {
    const abbr = normalizeText(s?.abbreviation).toLowerCase();
    if (abbr && abbr.length >= 2 && tokens.has(abbr)) return s;
  }
  return null;
};
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

  // Build set of failed delivery IDs for catalog cleanup + exclude from matching/return paths.
  // Rule: a delivery marked as 'failed' is exempt from the Square COD Deliveries tab list,
  // the Reconcile flow, and the Square Catalog update path. Its COD catalog item (if any
  // survived the on-failure deletion) is cleaned up during sync.
  const failedDeliveryIds = new Set(deliveriesWithAmounts
    .filter((d) => d?.status === 'failed')
    .map((d) => d?.id)
    .filter(Boolean));
  // Active deliveries = all minus failed — used for transaction matching, catalog linking,
  // and the returned strippedDeliveries payload.
  const activeDeliveriesWithAmounts = deliveriesWithAmounts.filter((d) => d?.status !== 'failed');

  console.log('[squareGetCodData2] Deliveries loaded:', deliveriesWithAmounts.length, 'elapsed:', Date.now() - t0);

  // Pre-build delivery index by store_id for faster matching (active deliveries only)
  const deliveriesByStoreId = new Map();
  for (const d of activeDeliveriesWithAmounts) {
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

  // Use store-indexed deliveries. When the item name contains a store abbreviation
  // (found across ALL stores, not just the transaction's location), restrict the
  // candidate pool to that single store's deliveries — this is the authoritative
  // store signal and prevents cross-store mismatches when multiple stores share a
  // Square location/card. Only when the abbreviation is absent do we gather
  // candidates from all stores sharing the transaction's location.
  const getDeliveryCandidatesForItem = (item, resolvedStore) => {
    const payIso = (item?.payment_date || item?.order_created_at || '').slice(0, 10);
    const combined = `${normalizeText(item?.note || '')} ${normalizeText(item?.item_name || '')}`.trim();
    const abbrStore = resolveStoreByAbbrInText(combined, safeStores);
    let candidatePool;
    if (abbrStore) {
      candidatePool = deliveriesByStoreId.get(abbrStore.id) || [];
    } else {
      const locationStores = storesByLocationId.get(item?.location_id) || [];
      candidatePool = [];
      for (const s of locationStores) {
        const storeDels = deliveriesByStoreId.get(s?.id) || [];
        storeDels.forEach((d) => candidatePool.push(d));
      }
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
    const combinedText = `${normalizeText(item?.note || '')} ${normalizeText(item?.item_name || '')}`.trim();
    const abbrStore = resolveStoreByAbbrInText(combinedText, safeStores);
    const locationStore = resolveStoreForItem(item?.item_name, item?.location_id, storesByLocationId);
    const resolvedStore = abbrStore || locationStore;
    const md = matchDeliveryForItem(item, resolvedStore);
    const mp = md ? patientsById.get(md?.patient_id) : null;
    const mdr = md ? getDriverFromDelivery(md) : null;
    // Store priority: 1) abbreviation in item name, 2) matched delivery's store,
    // 3) patient's assigned store, 4) location-based fallback (last resort).
    // The Square Location ID alone is never the store determinant when an
    // abbreviation is present, since multiple stores share each card.
    const mdStore = md ? (safeStores || []).find((s) => s?.id === md.store_id) : null;
    const patientStore = mp ? (safeStores || []).find((s) => s?.id === mp.store_id) : null;
    const ms = abbrStore || mdStore || patientStore || locationStore;
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
      store_id: ms?.id || md?.store_id || locationStore?.id || null,
      location_id: item?.location_id || null,
      driver_id: md?.driver_id || mdr?.id || mdr?.user_id || null,
      dispatcher_id: md?.created_by_app_user_id || null,
      payment_method: 'card',
      raw_square_data: { ...(existing?.raw_square_data || {}), line_item_uid: item?.line_item_uid || null, payment_date: item?.payment_date || null, order_created_at: item?.order_created_at || null, order_state: item?.order_state || null, notes: item?.note || '', original_item_name: item?.item_name || '', is_custom_amount: isCustom, matched_by: md ? (abbrStore ? 'abbr_store_match' : 'delivery_match') : 'unmatched' }
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
    const abbrStore = resolveStoreByAbbrInText(itemName, safeStores);
    const store = abbrStore || resolveStoreForItem(itemName, rl, storesByLocationId);
    let deliveryId = mt?.delivery_id || null;
    let patientId = mt?.patient_id || null;
    let storeId = abbrStore?.id || mt?.store_id || null;
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
        if (!storeId) storeId = matchedDelivery.store_id || null;
      }
    }
    acc.push({ id: item?.id, square_catalog_object_id: item?.id, square_catalog_version: item?.version || null, item_name: itemName, description: item?.item_data?.description || '', amount: ac / 100, amount_cents: ac, delivery_id: deliveryId, delivery_date: toIsoDate(itemName), patient_id: patientId, store_id: storeId || store?.id || null, location_id: rl, status: 'active' });
    return acc;
  }, []);

  // ── 4b) Cleanup orphaned catalog items for FAILED deliveries ─────────
  // Rule: failed deliveries are exempt from Square COD. Their catalog items should
  // have been deleted by the event-driven syncSquareCods handler when the delivery
  // was marked as failed, but if that deletion timed out or failed, the catalog
  // item persists in Square as an orphan. Here we identify catalog items linked
  // to failed deliveries (via the catalogRecords built in step 4) and include
  // them in the cleanup deletion below.

  // ── 5) Cleanup collected catalog items (reuses fetched data) ─────────
  // ONLY delete by explicit catalog-object ID match — i.e. when the order's
  // line item was actually rung up with this catalog item selected in Square
  // POS. The previous structured-name match path was too aggressive: it
  // deleted any catalog item whose name matched an old paid order's typed
  // line item name, which silently wiped out catalog items created by the
  // "Update Catalog" flow for deliveries that had been paid in a prior
  // Square order with the same structured name. Completed-delivery cleanup
  // is handled separately by the event-driven syncSquareCods handleDeleteCodItem.
  const paidCatalogObjectIds = new Set(paidOrderItems.map((x) => x.catalog_object_id).filter(Boolean));
  // Build a set of catalog object IDs linked to failed deliveries (from catalogRecords)
  const failedCatalogObjectIds = new Set(
    catalogRecords
      .filter((cr) => cr?.delivery_id && failedDeliveryIds.has(cr.delivery_id))
      .map((cr) => cr.square_catalog_object_id)
      .filter(Boolean)
  );

  // Drain the recreated-item backlog. When a previous sync run recreated a catalog
  // item (after a prior cleanup deleted the original), the recreated item carries a
  // brand-new catalog_object_id that no longer matches the historical Square order
  // line item catalog_object_ids — so the paidCatalogObjectIds match silently misses
  // them and they linger in the Square Catalog API as "already collected" items.
  // The catalog item's description carries our own stable delivery_id
  // ("COD for <patient> | Delivery <deliveryId>"), so we use it here to finally
  // delete catalog items whose referenced delivery is already completed+collected.
  // Mirrors the collection rule from syncSquareCods' event trigger.
  // IMPORTANT: Only card payments (Debit/Credit) count as "collected" here — those
  // bypass Square entirely via the card machine, so any lingering catalog item is
  // stale and safe to delete. Cash/Check completions must NOT be treated as
  // collected just because cod_payments has an entry: those are exactly the items
  // that need to STAY in the Square catalog until the store actually rings them
  // through the register (tracked via a completed SquareTransaction below).
  const COLLECTED_PAYMENT_TYPES = new Set(['Debit', 'Credit', 'debit', 'credit', 'card']);
  const deliveryHasRecordedCodPayment = (d) => (Array.isArray(d?.cod_payments) ? d.cod_payments : []).some((p) => Number(p?.amount || 0) > 0 && COLLECTED_PAYMENT_TYPES.has(String(p?.type || '')));
  const collectedDeliveryIds = new Set(
    (deliveriesWithAmounts || [])
      .filter((d) => d?.status === 'completed' && deliveryHasRecordedCodPayment(d))
      .map((d) => d?.id)
      .filter(Boolean)
  );
  // Also include deliveries that have ANY Square transaction record (pending or
  // completed). A pending transaction means the item was already rung up in the
  // Square POS (order is OPEN), so the catalog item has been used and should be
  // deleted. A completed transaction means the payment was collected. Either way,
  // the catalog item should not persist in the active catalog.
  for (const tx of transactionRecords) {
    if (tx?.delivery_id) {
      collectedDeliveryIds.add(tx.delivery_id);
    }
  }

  // Catalog items that are already linked to a SquareTransaction record (i.e. they
  // show a "Transaction ID" in the UI). The link is the same the catalog builder's
  // `mt` lookup uses: direct catalog_object_id match OR name+amount signature match.
  // The direct-ID check covers the catalog-tap POS path; the signature check covers
  // the custom-line-item path. Both must be drained — paidCatalogObjectIds alone
  // only sees historical Square orders' line-item catalog_object_ids, which miss
  // items whose catalog_object_id was recreated since the original payment.
  const txCatalogObjectIds = new Set();
  const txSignatureSet = new Set();
  for (const t of (existingTransactions || [])) {
    const cid = normalizeText(t?.square_catalog_object_id);
    if (cid && cid !== '') txCatalogObjectIds.add(cid);
    const sig = buildItemSignature(t?.item_name, t?.amount_cents ?? Math.round(Number(t?.amount || 0) * 100));
    if (sig && sig !== '::0') txSignatureSet.add(sig);
  }

  const extractDeliveryIdFromCatalog = (item) => {
    const desc = String(item?.item_data?.description || '').toLowerCase();
    const m = desc.match(/delivery\s+([a-f0-9]{24})/i);
    return m ? m[1] : null;
  };

  const toDelete = (liveCatalogItems || []).filter((item) => {
    if (!item?.id) return false;
    // Delete catalog items for failed deliveries (orphan cleanup)
    if (failedCatalogObjectIds.has(item.id)) return true;
    const varIds = (item?.item_data?.variations || []).map((v) => v?.id).filter(Boolean);
    if (paidCatalogObjectIds.has(item.id)) return true;
    if (varIds.some((v) => paidCatalogObjectIds.has(v))) return true;
    // Catalog item already linked to a SquareTransaction in our DB by direct ID
    // ("has a Transaction ID" via catalog-tap path).
    if (txCatalogObjectIds.has(item.id)) return true;
    if (varIds.some((v) => txCatalogObjectIds.has(v))) return true;
    // Catalog item linked by name+amount signature (custom-line-item path).
    const liveItemName = item?.item_data?.name || '';
    const liveItemAmountCents = getCatalogItemAmountCents(item);
    const liveItemSig = buildItemSignature(liveItemName, liveItemAmountCents);
    if (liveItemSig && liveItemSig !== '::0' && txSignatureSet.has(liveItemSig)) return true;
    // Recreated-item backlog: description → delivery_id → already collected
    const descDeliveryId = extractDeliveryIdFromCatalog(item);
    if (descDeliveryId && collectedDeliveryIds.has(descDeliveryId)) return true;
    return false;
  });

  let deletedCatalogIds = [];
  let cleanupDbCount = 0;
  let attemptedDeleteObjectIds = new Set();
  if (toDelete.length > 0) {
    const objectIds = toDelete.map((i) => i.id).filter(Boolean);
    attemptedDeleteObjectIds = new Set(objectIds);
    const deleteResult = await deleteCatalogObjects(objectIds, accessToken);
    deletedCatalogIds = deleteResult.deleted || [];
    // Clean up DB records for deleted objects — batch in parallel
    const dbCleanupPromises = objectIds.map(async (objId) => {
      const dbMatches = await base44.asServiceRole.entities.SquareCatalogItems.filter({ square_catalog_object_id: objId }).catch(() => []);
      for (const r of dbMatches) { await base44.asServiceRole.entities.SquareCatalogItems.delete(r.id).catch(() => null); cleanupDbCount++; }
      // Also delete stale PENDING SquareTransaction records for this catalog object.
      // These were created as bookkeeping when the catalog item was first created, but
      // the catalog item is now being deleted from Square. Leaving them would cause
      // handleCreateCodItem to skip re-creation with a false "transaction_exists" —
      // trapping the delivery in a state where it can never get a new catalog item.
      const staleTxs = await base44.asServiceRole.entities.SquareTransaction.filter({ square_catalog_object_id: objId, status: 'pending' }).catch(() => []);
      for (const r of staleTxs) { await base44.asServiceRole.entities.SquareTransaction.delete(r.id).catch(() => null); }
    });
    await Promise.all(dbCleanupPromises);
  }

  // ── CRITICAL: strip deleted items out of catalogRecords ──────────────
  // catalogRecords was built in step 4 from the PRE-deletion liveCatalogItems
  // snapshot, so without this filter, every item we just deleted from Square
  // above would be written straight back into SquareCatalogItems (step 5b)
  // and returned to the frontend — undoing the deletion within the same
  // sync call. Filter by attempted deletion (not just confirmed deletedCatalogIds)
  // since a 404 during delete already means the object is gone in Square.
  let filteredCatalogRecords = attemptedDeleteObjectIds.size > 0 ?
    catalogRecords.filter((cr) => !attemptedDeleteObjectIds.has(cr?.square_catalog_object_id)) :
    catalogRecords;

  console.log('[squareGetCodData2] Cleanup done:', { deleted: deletedCatalogIds.length, dbCleaned: cleanupDbCount, elapsed: Date.now() - t0 });

  // ── 5c) Auto-create missing catalog items (drain the Reconcile backlog) ──
  // Each Sync run also backfills catalog items for COD deliveries that should
  // have one but never got one (the event-driven syncSquareCods trigger missed
  // the transition — pre-trigger imports, completions done outside the
  // dashboard, sync timeouts). Mirrors the UI's "NEW CATALOG ITEMS" rule:
  // cod_total > 0, Square-configured store, not failed/cancelled/pending, not a
  // card-only completion (cards bypass Square), and no live catalog item or
  // existing SquareTransaction already linked by delivery_id.
  const deliveryNeedsCatalogItem = (d) => {
    if (!d?.id || Number(d?.cod_total_amount_required || 0) <= 0) return false;
    if (['failed', 'cancelled', 'pending'].includes(d?.status)) return false;
    if (d?.delivery_date && d.delivery_date > formatLocalDate(new Date())) return false;
    const store = (safeStores || []).find((s) => s?.id === d?.store_id);
    if (!store?.square_location_config_id) return false;
    const cfg = activeConfigById.get(store.square_location_config_id);
    if (!cfg?.square_location_id || cfg.status !== 'active') return false;
    const cps = Array.isArray(d?.cod_payments) ? d.cod_payments : [];
    const hasCardPayment = cps.some((p) => ['Debit', 'Credit', 'card', 'debit', 'credit'].includes(String(p?.type || '')) && Number(p?.amount || 0) > 0);
    if (d?.status === 'completed' && hasCardPayment) return false; // card bypasses Square catalog
    return true;
  };
  const existingTxDeliveryIds = new Set(
    (existingTransactions || []).map((t) => normalizeText(t?.delivery_id)).filter(Boolean)
  );
  const liveCatalogDeliveryIds = new Set();
  for (const item of (liveCatalogItems || [])) {
    const did = extractDeliveryIdFromCatalog(item);
    if (did) liveCatalogDeliveryIds.add(did);
  }
  const createdCatalogRecords = [];
  for (const d of (activeDeliveriesWithAmounts || [])) {
    if (!deliveryNeedsCatalogItem(d)) continue;
    if (existingTxDeliveryIds.has(d.id)) continue;
    if (liveCatalogDeliveryIds.has(d.id)) continue;
    try {
      const store = (safeStores || []).find((s) => s?.id === d?.store_id);
      const cfg = activeConfigById.get(store?.square_location_config_id);
      const locationId = cfg?.square_location_id || null;
      const pat = patientsById.get(d.patient_id);
      const epn = normalizeText(pat?.full_name || d?.patient_name) || `Delivery ${d.id.slice(-6)}`;
      const rsa = getPreferredStoreAbbreviation(store);
      const ac = Math.round(Number(d.cod_total_amount_required) * 100);
      const iname = formatItemName(d.delivery_date, rsa, epn);
      const catItem = await squareFetch('/v2/catalog/batch-upsert', 'POST', accessToken, { idempotency_key: crypto.randomUUID(), batches: [{ objects: [{ type: 'ITEM', id: `#item-${d.id}`, present_at_all_locations: false, present_at_location_ids: locationId ? [locationId] : [], item_data: { name: iname, description: `COD for ${epn} | Delivery ${d.id}`, is_taxable: true, product_type: 'REGULAR', variations: [{ type: 'ITEM_VARIATION', id: `#variation-${d.id}`, present_at_all_locations: false, present_at_location_ids: locationId ? [locationId] : [], item_variation_data: { name: 'Default', pricing_type: 'FIXED_PRICING', price_money: { amount: ac, currency: 'CAD' }, sellable: true, stockable: true } }] } }] }] });
      const createdItem = (catItem.objects || []).find((o) => o.type === 'ITEM') || null;
      if (createdItem?.id) {
        createdCatalogRecords.push({
          id: createdItem.id, square_catalog_object_id: createdItem.id, square_catalog_version: createdItem.version || null,
          item_name: iname, description: `COD for ${epn} | Delivery ${d.id}`, amount: ac / 100, amount_cents: ac,
          delivery_id: d.id, delivery_date: d.delivery_date, patient_id: pat?.id || d.patient_id || null,
          store_id: d.store_id, location_id: locationId, status: 'active',
        });
      }
    } catch (e) { console.warn('[squareGetCodData2] auto-create failed for', d.id, ':', e?.message); }
  }
  if (createdCatalogRecords.length > 0) {
    filteredCatalogRecords = [...filteredCatalogRecords, ...createdCatalogRecords];
    console.log('[squareGetCodData2] auto-created', createdCatalogRecords.length, 'missing catalog items, elapsed:', Date.now() - t0);
  }

  // ── 5b) Write transactions + catalog items to online DB ─────────────
  // Non-blocking: errors are caught so they never fail the sync. The IDB
  // write (handled by the frontend) is the primary data path; the online DB
  // is secondary, used for cross-device visibility and admin queries.
  const dbWriteErrors = [];
  try {
    if (txToCreate.length > 0) {
      await batchWriteEntities(base44.asServiceRole.entities.SquareTransaction, txToCreate);
      console.log('[squareGetCodData2] DB: created', txToCreate.length, 'transactions');
    }
    if (txToUpdate.length > 0) {
      await batchWriteEntities(base44.asServiceRole.entities.SquareTransaction, txToUpdate);
      console.log('[squareGetCodData2] DB: updated', txToUpdate.length, 'transactions');
    }
  } catch (e) { dbWriteErrors.push({type:'transactions', error: e?.message || String(e)}); console.warn('[squareGetCodData2] DB transaction write failed:', e?.message); }

  try {
    // Build catalog upsert operations: update existing, create new
    const existingCatalogByObjId = new Map();
    for (const r of (Array.isArray(existingCatalogDb) ? existingCatalogDb : []).map(unwrapEntityRecord).filter(Boolean)) {
      if (r?.square_catalog_object_id) existingCatalogByObjId.set(r.square_catalog_object_id, r);
    }
    const catalogOps = [];
    for (const cr of filteredCatalogRecords) {
      const existing = existingCatalogByObjId.get(cr.square_catalog_object_id);
      if (existing) {
        const changed = existing.item_name !== cr.item_name || existing.amount !== cr.amount || existing.delivery_id !== cr.delivery_id || existing.status !== cr.status;
        if (changed) catalogOps.push({ type: 'update', id: existing.id, data: cr });
      } else {
        catalogOps.push({ type: 'create', data: cr });
      }
    }
    if (catalogOps.length > 0) {
      await batchWriteEntities(base44.asServiceRole.entities.SquareCatalogItems, catalogOps);
      console.log('[squareGetCodData2] DB: wrote', catalogOps.length, 'catalog items');
    }
  } catch (e) { dbWriteErrors.push({type:'catalog', error: e?.message || String(e)}); console.warn('[squareGetCodData2] DB catalog write failed:', e?.message); }

  // ── 6) Return everything in one response ────────────────────────────
  // Failed deliveries are excluded from strippedDeliveries — they are exempt from
  // the Deliveries tab list, Reconcile flow, and Square Catalog update path.
  const strippedDeliveries = activeDeliveriesWithAmounts.map((d) => ({ id: d?.id, delivery_id: d?.delivery_id, delivery_date: d?.delivery_date, status: d?.status, cod_total_amount_required: d?.cod_total_amount_required, cod_payments: d?.cod_payments, store_id: d?.store_id, patient_id: d?.patient_id, driver_id: d?.driver_id, driver_name: d?.driver_name, delivery_notes: d?.delivery_notes }));

  console.log('[squareGetCodData2] COMPLETE, elapsed:', Date.now() - t0, 'ms');

  return {
    success: true,
    deliveries: strippedDeliveries,
    shouldRefreshDeliveries: refreshDeliveries,
    deliverySyncWindow: { startDate: formatLocalDate(new Date(Date.now() - daysBack * 86400000)), endDate: formatLocalDate(new Date()), daysBack, refreshedAt: refreshDeliveries ? new Date().toISOString() : null },
    catalogRecords: filteredCatalogRecords,
    transactionRecords,
    deletedCatalogIds,
    cleanupDbCount,
    locationConfigs: safeConfigs,
    locationIds,
    dbWriteErrors,
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