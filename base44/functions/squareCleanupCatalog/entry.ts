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

async function squareFetch(path, method, accessToken, body, options={}) {
  const {monitor,queue}=options;let lastError=null;
  for (let attempt=1;attempt<=SQUARE_API_MAX_RETRIES;attempt++) {
    try {
      const doFetch=()=>fetch(`${SQUARE_BASE_URL}${path}`,{method,headers:{Authorization:`Bearer ${accessToken}`,'Content-Type':'application/json','Square-Version':SQUARE_VERSION},body:body?JSON.stringify(body):undefined});
      const response=await(queue?queue.run(path,doFetch):doFetch());
      const text=await response.text();const json=text?JSON.parse(text):{};
      if(!response.ok){const msg=json?.errors?.map((e)=>e.detail).join(', ')||`Square API error ${response.status}`;lastError=new HttpError(response.status,msg);if(attempt<SQUARE_API_MAX_RETRIES&&isRetryableSquareStatus(response.status)){if(monitor){monitor.state.retryCount++;if(response.status===429)monitor.state.rateLimitHits++;}await sleep(SQUARE_RETRY_BASE_DELAY_MS*attempt);continue;}throw lastError;}
      return json;
    } catch(error){lastError=error;if(attempt<SQUARE_API_MAX_RETRIES){if(monitor)monitor.state.retryCount++;await sleep(SQUARE_RETRY_BASE_DELAY_MS*attempt);continue;}if(monitor)monitor.state.errorCount++;throw lastError;}
  }
  throw lastError||new Error('Square API request failed');
}

const TRANSACTION_RETENTION_DAYS = 90;
const MAX_TRANSACTION_ORDERS = 2000;
const shouldIgnoreManualOrderLabel = (v) => ['top ups','top up','topup','tip','top'].includes(String(v||'').replace(/\s+/g,' ').trim().toLowerCase());
const requireAdminIfAuthenticated = async (b44) => { const ok = await b44.auth.isAuthenticated().catch(() => false); if (!ok) return null; const u = await b44.auth.me().catch(() => null); if (u?.role !== 'admin') throw new HttpError(403, 'Forbidden: Admin access required'); return u; };
const getTransactionRetentionStartMs = () => { const t = new Date(); t.setHours(0,0,0,0); t.setDate(t.getDate()-TRANSACTION_RETENTION_DAYS); return t.getTime(); };
const normalizeMatchName = (v) => normalizeText(v).replace(/\s+/g,' ').replace(/\s-\s\$\d+(?:\.\d{2})?$/,'').replace(/^(\d{2})-(\d{2})/,'$1/$2').toLowerCase();
const isStructuredCodName = (v) => /^\d{2}[\/-]\d{2}\([^)]+\)-.+/.test(String(v||'').trim());
const getStructuredCodDate = (v) => { if (!isStructuredCodName(v)) return null; return toIsoDate(v); };
const structuredCodNamesMatch = (txName, catalogName, _txDateIso) => {
  if (!isStructuredCodName(txName) || !isStructuredCodName(catalogName)) return null;
  // Pure 1-to-1: trim only, no lowercasing, no date/prefix stripping — must be identical
  if (normalizeText(txName) !== normalizeText(catalogName)) return false;
  // Chronology: use only the date embedded in the name strings themselves.
  // If the tx name and catalog name are identical (above check passed), their embedded
  // dates are also identical, so this guard is primarily a safety net for caller misuse.
  const txNameDateIso = getStructuredCodDate(txName);
  const catDateIso = getStructuredCodDate(catalogName);
  if (txNameDateIso && catDateIso && txNameDateIso < catDateIso) return false;
  return true;
};
const getCatalogItemLocationIds = (item) => Array.from(new Set([...(item?.present_at_location_ids||[]),...(item?.item_data?.variations||[]).flatMap((v)=>v?.present_at_location_ids||[])].filter(Boolean)));
const getCatalogItemAmountCents = (item) => { const vs=item?.item_data?.variations||[]; const v=vs.find((e)=>e?.item_variation_data?.price_money?.amount!=null)||vs[0]; return toAmountCents(v?.item_variation_data?.price_money?.amount); };
const toIsoDate = (v) => { const p=parseDateValue(v); return (p&&!Number.isNaN(p.getTime()))?p.toISOString().slice(0,10):null; };
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
async function safeDeleteSquareCatalogObject(catalogObjectId, accessToken) {
  if (!catalogObjectId) return {attempted:false,ok:false};let lastFailure=null;
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
  catch{const deleted=[];const failed=[];for(const id of objectIds){const r=await safeDeleteSquareCatalogObject(id,accessToken);if(r?.ok)deleted.push(id);else failed.push({objectId:id,result:r});}if(failed.length)throw new Error(`Failed to delete Square catalog items: ${failed.map((e)=>e.objectId).join(', ')}`);return{deleted,failed:[]};}
}
async function listActiveCatalogItems(accessToken, options={}) {
  const objects=[];let cursor;
  do{const json=await squareFetch('/v2/catalog/search','POST',accessToken,{object_types:['ITEM'],include_deleted_objects:false,archived_state:'ARCHIVED_STATE_NOT_ARCHIVED',limit:1000,cursor},options);objects.push(...(json.objects||[]));cursor=json.cursor;if(cursor)await sleep(200);}while(cursor);
  return objects;
}
async function listOrders(locationIds, startAt, accessToken, maxOrders=2000, states=['COMPLETED','OPEN'], options={}) {
  if(!locationIds.length)return[];const orders=[];let cursor=null;
  do{const json=await squareFetch('/v2/orders/search','POST',accessToken,{location_ids:locationIds,cursor,limit:500,query:{filter:{state_filter:{states},date_time_filter:{created_at:{start_at:startAt}}},sort:{sort_field:'CREATED_AT',sort_order:'DESC'}}},options);orders.push(...(json.orders||[]));cursor=json.cursor||null;if(cursor&&orders.length<maxOrders)await sleep(200);}while(cursor&&orders.length<maxOrders);
  return orders.slice(0,maxOrders);
}
function isOrderFullyRefunded(order) {
  // net_amounts.total_money reflects post-refund net — if <= 0, fully refunded
  const netTotal = order?.net_amounts?.total_money?.amount;
  if (netTotal != null && Number(netTotal) <= 0) return true;
  // return_amounts.total_money is the sum of all returns — if >= order total, fully refunded
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
    // Build a map of refunded quantities per line_item_uid from return line items
    const refundedQtyByUid=new Map();
    for(const rli of order?.return_line_items||[]){const uid=rli?.source_line_item_uid;if(!uid)continue;const rq=Math.round(Number(rli?.quantity||1))||1;refundedQtyByUid.set(uid,(refundedQtyByUid.get(uid)||0)+rq);}
    for(const li of lineItems){const itemName=normalizeText(li?.name||li?.note);if(!itemName||shouldIgnoreManualOrderLabel(itemName))continue;const totalQty=Math.round(Number(li?.quantity||1))||1;const refundedQty=refundedQtyByUid.get(li?.uid)||0;const netQty=Math.max(0,totalQty-refundedQty);if(netQty<=0)continue;const eu=toAmountCents(li?.base_price_money?.amount);const gr=toAmountCents(li?.gross_sales_money?.amount||li?.total_money?.amount);const ac=eu||(totalQty>0?Math.round(gr/totalQty):gr);const ts=order?.state==='COMPLETED'?'completed':'pending';for(let i=0;i<netQty;i++)items.push({order_id:order?.id,line_item_uid:li?.uid?`${li.uid}-${i}`:(order?.id+'-'+(li?.catalog_object_id||itemName)+'-'+i),location_id:order?.location_id||null,item_name:itemName,amount_cents:ac,catalog_object_id:li?.catalog_object_id||null,payment_date:order?.created_at||null,order_created_at:order?.created_at||null,note:order?.note||'',order_state:order?.state||null,transaction_status:ts});}
  }
  return items;
}
const buildItemSignature = (n, c) => `${normalizeText(n)}::${toAmountCents(c)}`;
const getLookbackStartAt = (days) => new Date(Date.now() - days * 86400000).toISOString();

async function handleCleanupCollectedCatalogItems(base44, payload={}) {
  const accessToken = ensureSquareToken();
  const[allLocationConfigs]=await Promise.all([base44.asServiceRole.entities.SquareLocationConfig.list('-updated_date',500).catch(()=>[])]);
  const locationIds = Array.from(new Set((allLocationConfigs||[]).map((c)=>c?.square_location_id).filter(Boolean)));
  if (!locationIds.length) return { success: true, deleted: [], skipped: 'no_locations' };

  // Fetch live catalog items and completed orders in parallel
  const [liveCatalogItems, completedOrders] = await Promise.all([
    listActiveCatalogItems(accessToken),
    listOrders(locationIds, getLookbackStartAt(TRANSACTION_RETENTION_DAYS), accessToken, MAX_TRANSACTION_ORDERS, ['COMPLETED', 'OPEN']),
  ]);

  if (!liveCatalogItems?.length) return { success: true, deleted: [], skipped: 'no_catalog_items' };

  const refundedOrderIds = buildRefundedOrderIdSet(completedOrders);
  const paidOrderItems = flattenOrderItems((completedOrders||[]).filter((o) => !refundedOrderIds.has(o?.id)));

  // Build lookup set for paid items — by catalog_object_id only (exact Square ID match).
  // Do NOT use name+amount signature here: buildItemSignature strips the date prefix so
  // "06/02(LD)-Angela Dottor" and "06/30(LD)-Angela Dottor" would collide and the June 30
  // catalog item would be falsely deleted when only June 2 was paid.
  const paidCatalogObjectIds = new Set(paidOrderItems.map((x) => x.catalog_object_id).filter(Boolean));

  // Find catalog items that have been paid — exact Square object ID match only.
  const toDelete = (liveCatalogItems||[]).filter((item) => {
    if (!item?.id) return false;
    const varIds = (item?.item_data?.variations||[]).map((v)=>v?.id).filter(Boolean);
    if (paidCatalogObjectIds.has(item.id)) return true;
    if (varIds.some((v) => paidCatalogObjectIds.has(v))) return true;
    // Structured name: require exact structural match with a paid order item (same date+store+patient)
    const n = normalizeText(item?.item_data?.name);
    if (isStructuredCodName(n)) {
      return paidOrderItems.some((pi) => structuredCodNamesMatch(pi.item_name, n, null)===true);
    }
    return false;
  });

  if (!toDelete.length) return { success: true, deleted: [], message: 'No collected catalog items found' };

  const objectIds = toDelete.map((i) => i.id).filter(Boolean);
  const deleteResult = await deleteCatalogObjects(objectIds, accessToken);

  // Clean up SquareCatalogItems DB records for deleted objects
  const dbCleanupPromises = objectIds.map(async (objId) => {
    const dbMatches = await base44.asServiceRole.entities.SquareCatalogItems.filter({ square_catalog_object_id: objId }).catch(() => []);
    for (const r of dbMatches) await base44.asServiceRole.entities.SquareCatalogItems.delete(r.id).catch(() => null);
    // Also mark related pending transactions as completed
    const txMatches = await base44.asServiceRole.entities.SquareTransaction.filter({ square_catalog_object_id: objId, status: 'pending' }).catch(() => []);
    for (const t of txMatches) await base44.asServiceRole.entities.SquareTransaction.update(t.id, { status: 'completed', raw_square_data: { ...(t.raw_square_data||{}), deleted_at: new Date().toISOString(), deleted_reason: 'collected_cleanup' } }).catch(() => null);
  });
  await Promise.all(dbCleanupPromises);

  return { success: true, deleted: deleteResult.deleted, failed: deleteResult.failed, checkedCount: liveCatalogItems.length, deletedCount: deleteResult.deleted.length };
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const payload = await req.json().catch(() => ({}));
    await requireAdminIfAuthenticated(base44);
    return Response.json(await handleCleanupCollectedCatalogItems(base44, payload));
  } catch(error){const status=error?.status||500;return Response.json({error:error?.message||'Internal Server Error'},{status});}
});
