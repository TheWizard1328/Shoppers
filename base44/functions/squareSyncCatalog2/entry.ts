import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

class HttpError extends Error { constructor(s, m) { super(m); this.status = s; } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const normalizeText = (v) => String(v || '').trim();
const toAmountCents = (v) => Math.max(0, Math.round(Number(v || 0)));
const requireUser = async (b44) => { const u = await b44.auth.me().catch(() => null); if (!u) throw new HttpError(401, 'Unauthorized'); return u; };
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
const getTransactionRetentionStartMs = () => { const t = new Date(); t.setHours(0,0,0,0); t.setDate(t.getDate()-TRANSACTION_RETENTION_DAYS); return t.getTime(); };
const buildItemSignature = (n, c) => `${normalizeText(n)}::${toAmountCents(c)}`;
const normalizeMatchName = (v) => normalizeText(v).replace(/\s+/g,' ').replace(/\s-\s\$\d+(?:\.\d{2})?$/,'').replace(/^(\d{2})-(\d{2})/,'$1/$2').toLowerCase();
const isStructuredCodName = (v) => /^\d{2}[\/-]\d{2}\([^)]+\)-.+/.test(String(v||'').trim());
const getCatalogItemLocationIds = (item) => Array.from(new Set([...(item?.present_at_location_ids||[]),...(item?.item_data?.variations||[]).flatMap((v)=>v?.present_at_location_ids||[])].filter(Boolean)));
const isCatalogItemAtLocation = (item, lid) => { if (!item||!lid) return false; if (item?.present_at_all_locations) return true; return getCatalogItemLocationIds(item).includes(lid); };
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
const buildComparableLocationSignature = (n, c, lid) => `${normalizeText(lid)}::${normalizeMatchName(n)}::${toAmountCents(c)}`;

async function handleSyncCatalog(base44, payload={}) {
  const accessToken=ensureSquareToken();
  const daysBack=Math.max(1,Number(payload?.daysBack||TRANSACTION_RETENTION_DAYS)||TRANSACTION_RETENTION_DAYS);
  const skipLock=payload?.skipLock===true;

  // Step 1: Mirror catalog from Square (delegates to squareMirrorCatalog for the heavy lifting)
  const mirrorResult=await base44.functions.invoke('squareMirrorCatalog',{}).catch((e)=>{console.error('squareMirrorCatalog failed:',e?.message);return{success:false,error:e?.message};});

  // Step 2: Fetch deliveries and create missing COD items
  const[stores,locationConfigs,patients,existingCatalogDb]=await Promise.all([
    base44.asServiceRole.entities.Store.list('-updated_date',500).catch(()=>[]),
    base44.asServiceRole.entities.SquareLocationConfig.list('-updated_date',500).catch(()=>[]),
    base44.asServiceRole.entities.Patient.list('-updated_date',5000).catch(()=>[]),
    base44.asServiceRole.entities.SquareCatalogItems.list('-updated_date',2000).catch(()=>[])
  ]);
  const safeStores=(Array.isArray(stores)?stores:[]).map(unwrapEntityRecord).filter(Boolean);
  const safeConfigs=(Array.isArray(locationConfigs)?locationConfigs:[]).map(unwrapEntityRecord).filter(Boolean);
  const activeConfigById=new Map(safeConfigs.filter((c)=>c?.status==='active').map((c)=>[c.id,c]));
  const storesByLocationId=buildStoresByLocationId(safeStores,activeConfigById);
  const patientsById=new Map((Array.isArray(patients)?patients:[]).map((p)=>[p.id,p]));
  const catalogDeliveryIds=new Set((existingCatalogDb||[]).map((c)=>c?.delivery_id||c?.data?.delivery_id).filter(Boolean));

  // Fetch deliveries with COD amounts
  const startDateStr=formatLocalDate(new Date(Date.now()-daysBack*86400000));
  const endDateStr=formatLocalDate(new Date());
  const deliveries=await base44.asServiceRole.entities.Delivery.filter({delivery_date:{$gte:startDateStr,$lte:endDateStr}},'-updated_date',5000).catch(()=>[]);
  const safeDeliveries=(Array.isArray(deliveries)?deliveries:[]).map(unwrapEntityRecord).filter(Boolean);
  const deliveriesWithCod=safeDeliveries.filter((d)=>Number(d?.cod_total_amount_required||0)>0&&d?.status!=='failed'&&d?.status!=='cancelled');

  // Create missing COD items via squareCreateCodItem
  const createResults=[];
  const toCreate=deliveriesWithCod.filter((d)=>!catalogDeliveryIds.has(d.id));
  for(const delivery of toCreate){
    const r=await base44.functions.invoke('squareCreateCodItem',{
      deliveryId:delivery.id,codAmount:delivery.cod_total_amount_required,
      deliveryDate:delivery.delivery_date,storeId:delivery.store_id,
      patientName:delivery.patient_name||patientsById.get(delivery.patient_id)?.full_name||null
    }).catch((e)=>({error:e?.message}));
    createResults.push({deliveryId:delivery.id,status:r?.error?'error':'ok',result:r});
  }

  // Step 3: Fetch orders and identify collected items for cleanup
  const locationIds=Array.from(new Set(safeConfigs.map((c)=>c?.square_location_id).filter(Boolean)));
  const completedOrders=await listOrders(locationIds,getLookbackStartAt(daysBack),accessToken,MAX_TRANSACTION_ORDERS,['COMPLETED','OPEN']).catch(()=>[]);
  const refundedOrderIds=buildRefundedOrderIdSet(completedOrders);
  const paidOrderItems=flattenOrderItems((completedOrders||[]).filter((o)=>!refundedOrderIds.has(o?.id)));
  const paidCatalogObjectIds=new Set(paidOrderItems.map((x)=>x.catalog_object_id).filter(Boolean));

  // Get live catalog to find collected items
  const liveCatalogItems=await listActiveCatalogItems(accessToken).catch(()=>[]);
  const toDelete=(liveCatalogItems||[]).filter((item)=>{
    if(!item?.id)return false;
    const varIds=(item?.item_data?.variations||[]).map((v)=>v?.id).filter(Boolean);
    if(paidCatalogObjectIds.has(item.id))return true;
    if(varIds.some((v)=>paidCatalogObjectIds.has(v)))return true;
    const n=normalizeText(item?.item_data?.name);
    if(isStructuredCodName(n)){return paidOrderItems.some((pi)=>{const a=normalizeText(pi.item_name),b=normalizeText(n);return a===b;});}
    return false;
  });

  // Delete collected items via squareDeleteCodItem
  let deletedCount=0;
  for(const item of toDelete){
    const r=await base44.functions.invoke('squareDeleteCodItem',{catalogObjectId:item.id,reason:'collected_cleanup'}).catch(()=>null);
    if(r)deletedCount++;
  }

  // Step 4: Sync online entities (delegates to squareSyncOnline)
  const syncOnlineResult=await base44.functions.invoke('squareSyncOnline',{
    catalogRecords:(existingCatalogDb||[]).map(unwrapEntityRecord).filter(Boolean),
    transactionRecords:[]
  }).catch((e)=>({success:false,error:e?.message}));

  return{success:true,mirrorResult,created:createResults.length,deleted:deletedCount,syncOnlineResult,catalogCount:(existingCatalogDb||[]).length};
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const payload = await req.json().catch(() => ({}));
    await requireAdminIfAuthenticated(base44);
    return Response.json(await handleSyncCatalog(base44, payload));
  } catch(error){const status=error?.status||500;return Response.json({error:error?.message||'Internal Server Error'},{status});}
});