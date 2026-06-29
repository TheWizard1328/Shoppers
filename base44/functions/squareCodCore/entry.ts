// Redeployed on 2026-05-21 - Via Superagent The Boss
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

const SQUARE_BASE_URL = 'https://connect.squareup.com';
const SQUARE_VERSION = '2025-01-23';
const TRANSACTION_RETENTION_DAYS = 90;
const MATCH_DATE_OFFSET_DAYS = 2;
const SQUARE_API_MAX_RETRIES = 3;
const SQUARE_RETRY_BASE_DELAY_MS = 400;
const SQUARE_REQUEST_SPACING_MS = 100;
const SQUARE_BATCH_PAUSE_MS = 400;
const SQUARE_BATCH_SIZE = 8;
const DELIVERY_BULK_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const MAX_TRANSACTION_ORDERS = 2000;
const BASE44_SYNC_CHUNK_DELAY_MS = 300;

class HttpError extends Error { constructor(s, m) { super(m); this.status = s; } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const normalizeText = (v) => String(v || '').trim();
const toAmountCents = (v) => Math.max(0, Math.round(Number(v || 0)));
const isValidEntityId = (v) => /^[a-f0-9]{24}$/i.test(String(v || ''));
const isRetryableSquareStatus = (s) => [408, 409, 429, 500, 502, 503, 504].includes(Number(s));
const isOfflineCollectedPaymentMethod = (m) => ['cash', 'check', 'other'].includes(String(m || '').toLowerCase());
const shouldIgnoreManualOrderLabel = (v) => ['top ups','top up','topup','tip','top'].includes(String(v||'').replace(/\s+/g,' ').trim().toLowerCase());
const formatLocalDate = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const getLookbackStartAt = (days) => new Date(Date.now() - days * 86400000).toISOString();
const unwrapEntityRecord = (r) => { if (!r || typeof r !== 'object') return null; if (r.data && typeof r.data === 'object') return { ...r.data, id: r.data.id || r.id, created_date: r.data.created_date || r.created_date, updated_date: r.data.updated_date || r.updated_date }; return r; };
const ensureSquareToken = () => { const t = Deno.env.get('SQUARE_ACCESS_TOKEN'); if (!t) throw new HttpError(500, 'Square credentials not configured'); return t; };
const requireUser = async (b44) => { const u = await b44.auth.me().catch(() => null); if (!u) throw new HttpError(401, 'Unauthorized'); return u; };
const requireAdminIfAuthenticated = async (b44) => { const ok = await b44.auth.isAuthenticated().catch(() => false); if (!ok) return null; const u = await b44.auth.me().catch(() => null); if (u?.role !== 'admin') throw new HttpError(403, 'Forbidden: Admin access required'); return u; };
const hasCollectedCardPayment = (d) => (Array.isArray(d?.cod_payments)?d.cod_payments:[]).some((p)=>['Debit','Credit'].includes(p?.type)&&Number(p?.amount||0)>0);
const hasCollectedOfflinePayment = (d) => (Array.isArray(d?.cod_payments)?d.cod_payments:[]).some((p)=>isOfflineCollectedPaymentMethod(p?.type)&&Number(p?.amount||0)>0);
const shouldRefreshDeliveries = (at, force=false) => { if (force) return true; const ms = new Date(at||0).getTime(); return !Number.isFinite(ms)||ms<=0||Date.now()-ms>=DELIVERY_BULK_REFRESH_INTERVAL_MS; };
const getTransactionRetentionStartMs = () => { const t = new Date(); t.setHours(0,0,0,0); t.setDate(t.getDate()-TRANSACTION_RETENTION_DAYS); return t.getTime(); };
const buildItemSignature = (n, c) => `${normalizeText(n)}::${toAmountCents(c)}`;
const normalizeMatchName = (v) => normalizeText(v).replace(/\s+/g,' ').replace(/\s-\s\$\d+(?:\.\d{2})?$/,'').replace(/^(\d{2})-(\d{2})/,'$1/$2').toLowerCase();
const buildComparableLocationSignature = (n, c, lid) => `${normalizeText(lid)}::${normalizeMatchName(n)}::${toAmountCents(c)}`;
const getCatalogItemLocationIds = (item) => Array.from(new Set([...(item?.present_at_location_ids||[]),...(item?.item_data?.variations||[]).flatMap((v)=>v?.present_at_location_ids||[])].filter(Boolean)));
const isCatalogItemAtLocation = (item, lid) => { if (!item||!lid) return false; if (item?.present_at_all_locations) return true; return getCatalogItemLocationIds(item).includes(lid); };
const getCatalogItemAmountCents = (item) => { const vs=item?.item_data?.variations||[]; const v=vs.find((e)=>e?.item_variation_data?.price_money?.amount!=null)||vs[0]; return toAmountCents(v?.item_variation_data?.price_money?.amount); };
const toIsoDate = (v) => { const p=parseDateValue(v); return (p&&!Number.isNaN(p.getTime()))?p.toISOString().slice(0,10):null; };
const getPreferredStoreAbbreviation = (store) => { const n=normalizeText(store?.abbreviation); if (n) return n.toUpperCase(); const ts=normalizeText(store?.name).split(/[^a-zA-Z0-9]+/).map((p)=>p.trim()).filter(Boolean); if (!ts.length) return 'NA'; if (ts.length===1) return ts[0].slice(0,2).toUpperCase(); return ts.map((t)=>t[0]).join('').slice(0,2).toUpperCase(); };

// Extract the store abbreviation from an item name like "06/20(KW)-Patient Name"
function extractItemNameAbbr(itemName) { const m = String(itemName||'').match(/\(([^)]+)\)/); return m ? normalizeText(m[1]).toUpperCase() : ''; }

// Build a multi-store map: locationId → [store, store, ...] (preserves all stores sharing a location)
function buildStoresByLocationId(stores, activeConfigById) {
  const map = new Map();
  for (const s of stores||[]) {
    const c = activeConfigById.get(s?.square_location_config_id);
    if (!c?.square_location_id) continue;
    const lid = c.square_location_id;
    if (!map.has(lid)) map.set(lid, []);
    map.get(lid).push(s);
  }
  return map;
}

// Resolve the best-matching store for a Square order item.
// When multiple stores share a location ID, use the abbreviation in the item name to disambiguate.
function resolveStoreForItem(itemName, locationId, storesByLocationId) {
  const candidates = storesByLocationId.get(locationId) || [];
  if (!candidates.length) return null;
  if (candidates.length === 1) return candidates[0];
  const abbr = extractItemNameAbbr(itemName).toLowerCase();
  if (abbr) {
    const exact = candidates.find((s) => normalizeText(s?.abbreviation).toLowerCase() === abbr);
    if (exact) return exact;
    const partial = candidates.find((s) => getStoreAbbreviationVariants(s).some((v) => v === abbr || abbr.includes(v) || v.includes(abbr)));
    if (partial) return partial;
  }
  return candidates[0]; // fallback to first
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

function getMonthDayKey(v, ref=new Date()) {
  const p=parseDateValue(v,ref); if (!p||Number.isNaN(p.getTime())) return '';
  return `${String(p.getMonth()+1).padStart(2,'0')}-${String(p.getDate()).padStart(2,'0')}`;
}

function buildLocationDateAmountSignature(lid, dv, ac, ref=new Date()) {
  return `${normalizeText(lid)}::${getMonthDayKey(dv,ref)||'unknown-date'}::${toAmountCents(ac)}`;
}

function buildLocationDateAmountSignatureCandidates(lid, dv, ac, offsetDays=MATCH_DATE_OFFSET_DAYS, ref=new Date()) {
  const p=parseDateValue(dv,ref); if (!p||Number.isNaN(p.getTime())) return [buildLocationDateAmountSignature(lid,dv,ac,ref)];
  const sigs=[];
  for (let o=-offsetDays;o<=offsetDays;o++) { const c=new Date(p.getTime()+o*86400000); sigs.push(`${normalizeText(lid)}::${String(c.getMonth()+1).padStart(2,'0')}-${String(c.getDate()).padStart(2,'0')}::${toAmountCents(ac)}`); }
  return Array.from(new Set(sigs));
}

function buildPlaceholderItemNames(deliveryDate, abbr) {
  const [,mo,da]=String(deliveryDate||'').split('-'); const mm=(mo||'00').padStart(2,'0'); const dd=(da||'00').padStart(2,'0'); const a=abbr||'NA';
  return [`${mm}/${dd}(${a})-COD`,`${mm}/${dd}(${a})-Unknown Patient`,`${mm}-${dd}(${a})-COD`,`${mm}-${dd}(${a})-Unknown Patient`];
}

function tokenizeName(v) { return normalizeMatchName(v).replace(/[^a-z0-9\s]/g,' ').split(' ').map((p)=>p.trim()).filter((p)=>p.length>=2); }
function levenshteinDistance(a,b) { const l=String(a||'');const r=String(b||'');if(!l)return r.length;if(!r)return l.length;const m=Array.from({length:l.length+1},()=>Array(r.length+1).fill(0));for(let i=0;i<=l.length;i++)m[i][0]=i;for(let j=0;j<=r.length;j++)m[0][j]=j;for(let i=1;i<=l.length;i++)for(let j=1;j<=r.length;j++){const c=l[i-1]===r[j-1]?0:1;m[i][j]=Math.min(m[i-1][j]+1,m[i][j-1]+1,m[i-1][j-1]+c);}return m[l.length][r.length]; }

function notesContainPatientName(notesValue, patientName) {
  const nn=normalizeMatchName(notesValue).replace(/[^a-z0-9\s]/g,' ');const np=normalizeMatchName(patientName).replace(/[^a-z0-9\s]/g,' ');if(!nn||!np)return false;if(nn.includes(np))return true;
  const pt=tokenizeName(np);const nt=tokenizeName(nn);if(!pt.length||!nt.length)return false;
  if(pt.every((t)=>nt.some((n)=>n.includes(t)||t.includes(n))))return true;
  const ol=pt.filter((t)=>nt.some((n)=>n.includes(t)||t.includes(n))).length;if(pt.length>=2&&ol>=Math.min(2,pt.length))return true;
  return pt.every((t)=>nt.some((n)=>{const d=levenshteinDistance(t,n);return Math.max(t.length,n.length)>=4&&d<=1;}));
}

function getStoreAbbreviationVariants(store) {
  const vs=new Set();const push=(v)=>{const n=normalizeText(v);if(!n)return;vs.add(n.toLowerCase());n.split(/[^a-zA-Z0-9]+/).map((p)=>p.trim().toLowerCase()).filter(Boolean).forEach((p)=>vs.add(p));};
  push(store?.abbreviation);push(store?.name);return Array.from(vs);
}
const itemNameContainsStore=(itemName,store)=>{const n=normalizeMatchName(itemName);return !!n&&getStoreAbbreviationVariants(store).some((v)=>n.includes(v));};

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

async function createCatalogItem({itemName,amountCents,locationId,deliveryId,patientName,accessToken}) {
  const json=await squareFetch('/v2/catalog/batch-upsert','POST',accessToken,{idempotency_key:crypto.randomUUID(),batches:[{objects:[{type:'ITEM',id:`#item-${deliveryId}`,present_at_all_locations:false,present_at_location_ids:locationId?[locationId]:[],item_data:{name:itemName,description:`COD for ${patientName||'patient'} | Delivery ${deliveryId}`,is_taxable:true,product_type:'REGULAR',variations:[{type:'ITEM_VARIATION',id:`#variation-${deliveryId}`,present_at_all_locations:false,present_at_location_ids:locationId?[locationId]:[],item_variation_data:{name:'Default',pricing_type:'FIXED_PRICING',price_money:{amount:amountCents,currency:'CAD'},sellable:true,stockable:true}}]}}]}]});
  return (json.objects||[]).find((o)=>o.type==='ITEM')||null;
}

// Update an existing Square catalog item's name/price in-place via batch-upsert
async function updateCatalogItem({catalogObjectId,catalogVersion,itemName,amountCents,locationId,deliveryId,patientName,accessToken}) {
  const existingJson=await squareFetch(`/v2/catalog/object/${catalogObjectId}`,'GET',accessToken,null).catch(()=>null);
  const existingItem=existingJson?.object;
  if(!existingItem)return createCatalogItem({itemName,amountCents,locationId,deliveryId,patientName,accessToken});
  const evs=existingItem?.item_data?.variations||[];
  const presentAtLids=locationId?[locationId]:[];
  const updatedVariations=evs.length>0
    ?evs.map((v)=>({type:'ITEM_VARIATION',id:v.id,version:v.version,present_at_all_locations:false,present_at_location_ids:presentAtLids,item_variation_data:{...v.item_variation_data,name:'Default',pricing_type:'FIXED_PRICING',price_money:{amount:amountCents,currency:'CAD'}}}))
    :[{type:'ITEM_VARIATION',id:`#variation-${deliveryId}`,present_at_all_locations:false,present_at_location_ids:presentAtLids,item_variation_data:{name:'Default',pricing_type:'FIXED_PRICING',price_money:{amount:amountCents,currency:'CAD'},sellable:true,stockable:true}}];
  const json=await squareFetch('/v2/catalog/batch-upsert','POST',accessToken,{idempotency_key:crypto.randomUUID(),batches:[{objects:[{type:'ITEM',id:catalogObjectId,version:catalogVersion||existingItem.version,present_at_all_locations:false,present_at_location_ids:presentAtLids,item_data:{name:itemName,description:`COD for ${patientName||'patient'} | Delivery ${deliveryId}`,is_taxable:true,product_type:'REGULAR',variations:updatedVariations}}]}]});
  return (json.objects||[]).find((o)=>o.type==='ITEM')||null;
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

// Returns true if a Square order has been fully refunded.
// Square includes net_amounts and return_amounts on orders when refunds exist.
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

// Build a Set of order IDs that are fully refunded, for fast lookup
function buildRefundedOrderIdSet(orders) {
  const s = new Set();
  for (const o of orders || []) { if (isOrderFullyRefunded(o)) s.add(o.id); }
  return s;
}

function flattenOrderItems(orders) {
  const items=[];
  for(const order of orders||[])for(const li of order?.line_items||[]){const itemName=normalizeText(li?.name||li?.note);if(!itemName||shouldIgnoreManualOrderLabel(itemName))continue;const qty=Math.round(Number(li?.quantity||1))||1;const eu=toAmountCents(li?.base_price_money?.amount);const gr=toAmountCents(li?.gross_sales_money?.amount||li?.total_money?.amount);const ac=eu||(qty>0?Math.round(gr/qty):gr);const ts=order?.state==='COMPLETED'?'completed':'pending';for(let i=0;i<qty;i++)items.push({order_id:order?.id,line_item_uid:li?.uid||`${order?.id}-${li?.catalog_object_id||itemName}-${i}`,location_id:order?.location_id||null,item_name:itemName,amount_cents:ac,catalog_object_id:li?.catalog_object_id||null,payment_date:order?.created_at||null,order_created_at:order?.created_at||null,note:order?.note||'',order_state:order?.state||null,transaction_status:ts});}
  return items;
}

async function resolveDeliveryPatient(base44, delivery, patientById, patientByPid) {
  const ref=normalizeText(delivery?.patient_id);if(!ref)return null;
  const mapped=patientById.get(ref)||patientByPid.get(ref);if(mapped)return mapped;
  if(isValidEntityId(ref)){const p=await base44.asServiceRole.entities.Patient.get(ref).catch(()=>null);if(p){patientById.set(p.id,p);const pid=normalizeText(p.patient_id);if(pid)patientByPid.set(pid,p);return p;}}
  const ms=await base44.asServiceRole.entities.Patient.filter({patient_id:ref},'-updated_date',1).catch(()=>[]);const p=Array.isArray(ms)?ms[0]:null;
  if(p){patientById.set(p.id,p);const pid=normalizeText(p.patient_id);if(pid)patientByPid.set(pid,p);return p;}return null;
}

async function resolveDeliveryPatientName(base44, delivery, patientById, patientByPid) {
  const p=await resolveDeliveryPatient(base44,delivery,patientById,patientByPid);
  return normalizeText(p?.full_name||delivery?.patient_name)||'Unknown Patient';
}

async function getStoreSquareContext(base44, effectiveStoreId) {
  if(!effectiveStoreId)throw new HttpError(400,'Store ID is required for Square COD item creation');
  const store=await base44.asServiceRole.entities.Store.get(effectiveStoreId).catch(()=>null);if(!store)throw new HttpError(400,`Store not found with ID: ${effectiveStoreId}`);
  if(!store.square_location_config_id)throw new HttpError(400,`Store "${store.name}" is not configured for Square COD payments.`);
  const config=await base44.asServiceRole.entities.SquareLocationConfig.get(store.square_location_config_id).catch(()=>null);if(!config)throw new HttpError(400,`Square location config not found for store "${store.name}"`);
  if(config.status!=='active')throw new HttpError(400,`Square location "${config.name}" is inactive for store "${store.name}"`);
  return{store,config,locationId:config.square_location_id};
}

async function buildPatientMaps(base44, deliveries) {
  const refs=Array.from(new Set((deliveries||[]).map((d)=>normalizeText(d?.patient_id)).filter(Boolean)));
  const eids=refs.filter((id)=>isValidEntityId(id));const pids=refs.filter((id)=>!isValidEntityId(id));
  const [byEid,byPid]=await Promise.all([eids.length?base44.asServiceRole.entities.Patient.filter({id:{$in:eids}}):[], pids.length?base44.asServiceRole.entities.Patient.filter({patient_id:{$in:pids}}):[]]);
  const patients=[...(byEid||[]),...((byPid||[]).filter((p)=>!(byEid||[]).some((e)=>e.id===p.id)))];
  return{patientById:new Map(patients.map((p)=>[p.id,p])),patientByPid:new Map(patients.map((p)=>[normalizeText(p?.patient_id),p]).filter(([id])=>id))};
}

function createSquareSyncMonitor(base44, syncName='square_sync') {
  const state={runId:null,requestCount:0,retryCount:0,rateLimitHits:0,errorCount:0};
  const writeLog=async(level,step,message,details={})=>{console.log(`[SquareSync][${level}] ${step}: ${message}`,JSON.stringify(details));await base44.asServiceRole.entities.SquareSyncLog.create({sync_run_id:state.runId,level,step,message,details,logged_at:new Date().toISOString()}).catch(()=>null);};
  return{state,async start(meta={}){const run=await base44.asServiceRole.entities.SquareSyncHealth.create({sync_name:syncName,status:'running',started_at:new Date().toISOString(),request_count:0,retry_count:0,rate_limit_hits:0,error_count:0,summary:'Sync started',meta}).catch(()=>null);state.runId=run?.id||null;await writeLog('info','start','Square sync started',meta);},async finish(status,summary,meta={}){if(state.runId)await base44.asServiceRole.entities.SquareSyncHealth.update(state.runId,{status,finished_at:new Date().toISOString(),request_count:state.requestCount,retry_count:state.retryCount,rate_limit_hits:state.rateLimitHits,error_count:state.errorCount,summary,meta}).catch(()=>null);await writeLog(status==='error'?'error':status==='warning'?'warn':'info','finish',summary,meta);},async log(level,step,message,details={}){await writeLog(level,step,message,details);}};
}

function createSquareRequestQueue(monitor) {
  let counter=0;
  return{async run(step,task){const idx=counter++;if(idx>0)await sleep(SQUARE_REQUEST_SPACING_MS);if(idx>0&&idx%SQUARE_BATCH_SIZE===0)await sleep(SQUARE_BATCH_PAUSE_MS);monitor.state.requestCount++;return task();}};
}

async function paginatedDeleteAll(entityApi, pageSize=50) {
  while(true){const records=await entityApi.list('-updated_date',pageSize).catch(()=>[]);if(!records?.length)break;for(let i=0;i<records.length;i+=5){const chunk=records.slice(i,i+5);await Promise.all(chunk.map((r)=>entityApi.delete(r.id).catch(()=>null)));if(i+5<records.length)await sleep(BASE44_SYNC_CHUNK_DELAY_MS*4);}if(records.length<pageSize)break;await sleep(BASE44_SYNC_CHUNK_DELAY_MS*4);}
}

// ─── HANDLERS ────────────────────────────────────────────────────────────────

async function handleCreateCodItem(base44, payload) {
  const accessToken=ensureSquareToken();
  const{deliveryId,patientName,storeAbbreviation,codAmount,deliveryDate,storeId}=payload||{};
  if(!deliveryId||codAmount==null||Number(codAmount)<=0)throw new HttpError(400,'Missing required fields: deliveryId, codAmount');
  const deliveryRecord=await base44.asServiceRole.entities.Delivery.get(deliveryId).catch(()=>null);
  const{patientById,patientByPid}=await buildPatientMaps(base44,deliveryRecord?[deliveryRecord]:[]);
  const patientRecord=deliveryRecord?await resolveDeliveryPatient(base44,deliveryRecord,patientById,patientByPid):null;
  const effectiveStoreId=storeId||deliveryRecord?.store_id;
  const{store,locationId}=await getStoreSquareContext(base44,effectiveStoreId);
  const resolvedDeliveryDate=deliveryDate||deliveryRecord?.delivery_date;
  const lookedUp=deliveryRecord?await resolveDeliveryPatientName(base44,deliveryRecord,patientById,patientByPid):'';
  const usableName=lookedUp==='Unknown Patient'?'':lookedUp;
  const resolvedPatientName=normalizeText(usableName||patientName||deliveryRecord?.patient_name);
  if(!resolvedPatientName||resolvedPatientName==='COD'||resolvedPatientName==='Unknown Patient')return{success:true,skipped:true,reason:'missing_patient_name'};
  const resolvedPatientId=patientRecord?.id||(isValidEntityId(deliveryRecord?.patient_id)?deliveryRecord.patient_id:null);
  const resolvedStoreAbbr=normalizeText(store?.abbreviation||storeAbbreviation||'XX');
  const amountCents=Math.round(Number(codAmount)*100);
  const itemName=formatItemName(resolvedDeliveryDate,resolvedStoreAbbr,resolvedPatientName);
  const existingPending=await base44.asServiceRole.entities.SquareTransaction.filter({delivery_id:deliveryId,status:'pending'}).catch(()=>[]);
  // Exact match — no change needed
  if(existingPending?.length&&existingPending[0]?.square_catalog_object_id&&existingPending[0]?.item_name===itemName&&existingPending[0]?.amount_cents===amountCents){const tx=existingPending[0];return{success:true,catalogObjectId:tx.square_catalog_object_id,catalogVersion:tx.square_catalog_version,itemName:tx.item_name,transactionId:tx.id,note:'Skipped create: existing pending Square item found'};}
  let catalogObjectId,catalogVersion;
  // Existing item with changed name/amount — update in-place
  if(existingPending?.length&&existingPending[0]?.square_catalog_object_id&&(existingPending[0]?.item_name!==itemName||existingPending[0]?.amount_cents!==amountCents)){const updated=await updateCatalogItem({catalogObjectId:existingPending[0].square_catalog_object_id,catalogVersion:existingPending[0].square_catalog_version,itemName,amountCents,locationId,deliveryId,patientName:resolvedPatientName,accessToken});catalogObjectId=updated?.id||existingPending[0].square_catalog_object_id;catalogVersion=updated?.version||existingPending[0].square_catalog_version;}
  else{const ci=await createCatalogItem({itemName,amountCents,locationId,deliveryId,patientName:resolvedPatientName,accessToken});catalogObjectId=ci?.id||null;catalogVersion=ci?.version||null;if(!catalogObjectId)throw new Error(`Square did not return a catalog item for delivery ${deliveryId}`);}
  const existingTx=await base44.asServiceRole.entities.SquareTransaction.filter({delivery_id:deliveryId,status:'pending'}).catch(()=>[]);
  const txPayload={square_catalog_object_id:catalogObjectId,square_catalog_version:catalogVersion,item_name:itemName,amount:Number(codAmount),amount_cents:amountCents,patient_id:resolvedPatientId,store_id:effectiveStoreId,location_id:locationId};
  const transaction=existingTx.length>0?await base44.asServiceRole.entities.SquareTransaction.update(existingTx[0].id,txPayload):await base44.asServiceRole.entities.SquareTransaction.create({...txPayload,type:'collection',status:'pending',delivery_id:deliveryId});
  const existingCatalogItems=await base44.asServiceRole.entities.SquareCatalogItems.filter({delivery_id:deliveryId}).catch(()=>[]);
  const catalogPayload={square_catalog_object_id:catalogObjectId,square_catalog_version:catalogVersion,item_name:itemName,description:'',amount:Number(codAmount||0),amount_cents:amountCents,delivery_id:deliveryId,delivery_date:resolvedDeliveryDate||null,patient_id:resolvedPatientId,store_id:effectiveStoreId||null,location_id:locationId,status:'active'};
  if(existingCatalogItems.length>0)await base44.asServiceRole.entities.SquareCatalogItems.update(existingCatalogItems[0].id,catalogPayload);
  else await base44.asServiceRole.entities.SquareCatalogItems.create(catalogPayload);
  return{success:true,catalogObjectId,catalogVersion,itemName,transactionId:transaction?.id||existingTx[0]?.id};
}

// Delete catalog items by item name + amount + location — used when catalogObjectId is unknown.
// Fetches the live Square catalog, finds all matching items, deletes them, then cleans up DB records.
async function handleDeleteCodItemsByNameAmount(base44, payload) {
  const accessToken = ensureSquareToken();
  const { itemName, amountCents, locationId, deliveryId, reason } = payload || {};
  if (!itemName && !deliveryId) throw new HttpError(400, 'itemName or deliveryId is required');

  // Fetch live catalog to find the actual Square object IDs
  const allCatalogItems = await listActiveCatalogItems(accessToken);
  const targetAmountCents = toAmountCents(amountCents);
  const normalizedTarget = normalizeText(itemName).toLowerCase();

  const matchingItems = (allCatalogItems || []).filter((item) => {
    const itemItemName = normalizeText(item?.item_data?.name).toLowerCase();
    const itemAmountCents = getCatalogItemAmountCents(item);
    const atLocation = !locationId || isCatalogItemAtLocation(item, locationId);
    // Match by exact name + amount, or by delivery_id in description
    const nameMatch = itemItemName === normalizedTarget || (normalizedTarget && itemItemName.includes(normalizedTarget));
    const amountMatch = !targetAmountCents || itemAmountCents === targetAmountCents;
    // Also match by delivery_id embedded in description
    const descMatch = deliveryId && normalizeText(item?.item_data?.description).includes(deliveryId);
    return atLocation && ((nameMatch && amountMatch) || descMatch);
  });

  if (!matchingItems.length) {
    // Nothing in Square catalog — just clean up DB records
    if (deliveryId) {
      const dbItems = await base44.asServiceRole.entities.SquareCatalogItems.filter({ delivery_id: deliveryId }).catch(() => []);
      for (const r of dbItems) await base44.asServiceRole.entities.SquareCatalogItems.delete(r.id).catch(() => null);
    }
    return { success: true, deleted: [], notFound: true };
  }

  const objectIds = matchingItems.map((i) => i.id).filter(Boolean);
  const deleteResult = await deleteCatalogObjects(objectIds, accessToken);

  // Clean up SquareCatalogItems entity records
  for (const objId of objectIds) {
    const dbMatches = await base44.asServiceRole.entities.SquareCatalogItems.filter({ square_catalog_object_id: objId }).catch(() => []);
    for (const r of dbMatches) await base44.asServiceRole.entities.SquareCatalogItems.delete(r.id).catch(() => null);
  }
  if (deliveryId) {
    const dbByDelivery = await base44.asServiceRole.entities.SquareCatalogItems.filter({ delivery_id: deliveryId }).catch(() => []);
    for (const r of dbByDelivery) await base44.asServiceRole.entities.SquareCatalogItems.delete(r.id).catch(() => null);
  }

  // Cancel any pending SquareTransaction records linked to these items
  for (const objId of objectIds) {
    const txMatches = await base44.asServiceRole.entities.SquareTransaction.filter({ square_catalog_object_id: objId, status: 'pending' }).catch(() => []);
    for (const t of txMatches) await base44.asServiceRole.entities.SquareTransaction.update(t.id, { status: 'cancelled', raw_square_data: { ...(t.raw_square_data || {}), deleted_at: new Date().toISOString(), deleted_reason: reason || 'name_amount_cleanup' } }).catch(() => null);
  }

  return { success: true, deleted: deleteResult.deleted, failed: deleteResult.failed, matchCount: matchingItems.length };
}

async function handleDeleteCodItem(base44, payload) {
  const accessToken=ensureSquareToken();
  const{deliveryId,transactionId,catalogObjectId,reason}=payload||{};
  if(!deliveryId&&!transactionId&&!catalogObjectId)throw new HttpError(400,'Missing required field: deliveryId, transactionId, or catalogObjectId');
  let primaryTransaction=null;const relatedTransactions=[];
  if(transactionId){const t=await base44.asServiceRole.entities.SquareTransaction.get(transactionId).catch(()=>null);if(t){primaryTransaction=t;relatedTransactions.push(t);}}
  if(deliveryId){const dts=await base44.asServiceRole.entities.SquareTransaction.filter({delivery_id:deliveryId},'-updated_date',50).catch(()=>[]);for(const t of dts||[])if(!relatedTransactions.some((x)=>x?.id===t?.id))relatedTransactions.push(t);if(!primaryTransaction&&relatedTransactions.length>0)primaryTransaction=relatedTransactions[0];}
  const catId=catalogObjectId||primaryTransaction?.square_catalog_object_id||relatedTransactions[0]?.square_catalog_object_id||null;
  const sqDel=await safeDeleteSquareCatalogObject(catId,accessToken);
  const isTempFail=[408,429,500,502,503,504].includes(Number(sqDel?.status));
  if(catId&&!sqDel?.ok&&!isTempFail)throw new Error(`Failed to delete Square catalog item ${catId}`);
  const newStatus=reason==='failed'?'failed':'cancelled';
  for(let i=0;i<relatedTransactions.length;i+=10){const chunk=relatedTransactions.slice(i,i+10);await Promise.all(chunk.map((t)=>base44.asServiceRole.entities.SquareTransaction.update(t.id,{status:newStatus,raw_square_data:{...(t.raw_square_data||{}),deleted_at:new Date().toISOString(),deleted_reason:reason||'manual_delete'}}).catch(()=>null)));if(i+10<relatedTransactions.length)await sleep(50);}
  const catalogMatches=[];
  if(deliveryId){const bd=await base44.asServiceRole.entities.SquareCatalogItems.filter({delivery_id:deliveryId},'-updated_date',50).catch(()=>[]);catalogMatches.push(...(bd||[]));}
  if(catId){const bc=await base44.asServiceRole.entities.SquareCatalogItems.filter({square_catalog_object_id:catId},'-updated_date',50).catch(()=>[]);catalogMatches.push(...(bc||[]));}
  const uniqueCat=Array.from(new Map(catalogMatches.filter(Boolean).map((x)=>[x.id,x])).values());
  if(sqDel?.ok||!catId||isTempFail){for(let i=0;i<uniqueCat.length;i+=10){const chunk=uniqueCat.slice(i,i+10);await Promise.all(chunk.map((x)=>base44.asServiceRole.entities.SquareCatalogItems.delete(x.id).catch(()=>null)));if(i+10<uniqueCat.length)await sleep(50);}}
  return{success:true,deletedCatalogId:catId,transactionCount:relatedTransactions.length,deletedCatalogRecordCount:uniqueCat.length,squareDeleteResult:sqDel,squareDeleteDeferred:!!(catId&&isTempFail),transactionStatus:relatedTransactions.length>0?newStatus:'deleted_from_square'};
}

async function handleMarkCollectedDebit(base44, payload) {
  const{deliveryId,transactionId,catalogObjectId}=payload||{};
  if(!deliveryId)throw new HttpError(400,'Missing required field: deliveryId');
  const delivery=await base44.asServiceRole.entities.Delivery.get(deliveryId).catch(()=>null);
  if(!delivery)throw new HttpError(404,'Delivery not found');
  await base44.asServiceRole.entities.Delivery.update(deliveryId,{cod_payments:[{type:'Debit',amount:Number(delivery.cod_total_amount_required||0)}]});
  const deleteResult=await handleDeleteCodItem(base44,{deliveryId,transactionId,catalogObjectId,reason:'collected_debit'});
  return{success:true,deliveryId,paymentType:'Debit',...deleteResult};
}

async function handleFetchPayments(base44, payload) {
  await requireUser(base44);const accessToken=ensureSquareToken();
  const daysBack=Math.max(1,Number(payload?.daysBack||TRANSACTION_RETENTION_DAYS)||TRANSACTION_RETENTION_DAYS);
  const lookbackStartAt=new Date(Date.now()-daysBack*86400000).toISOString();
  const[stores,locationConfigs,deliveries,appUsers,patients,existingTransactions]=await Promise.all([base44.asServiceRole.entities.Store.list('-updated_date',500).catch(()=>[]),base44.asServiceRole.entities.SquareLocationConfig.list('-updated_date',500).catch(()=>[]),base44.asServiceRole.entities.Delivery.filter({delivery_date:{$gte:formatLocalDate(new Date(Date.now()-daysBack*86400000)),$lte:formatLocalDate(new Date())}},'-updated_date',5000).catch(()=>[]),base44.asServiceRole.entities.AppUser.list('-updated_date',2000).catch(()=>[]),base44.asServiceRole.entities.Patient.list('-updated_date',5000).catch(()=>[]),base44.asServiceRole.entities.SquareTransaction.list('-updated_date',5000).catch(()=>[])]);
  // For store-matching, only use active configs; for Square API queries, use all location IDs
  const activeConfigById=new Map((locationConfigs||[]).filter((c)=>c?.status==='active').map((c)=>[c.id,c]));
  const storesByLocationId=buildStoresByLocationId(stores,activeConfigById);
  const drivers=(appUsers||[]).filter((u)=>Array.isArray(u?.app_roles)&&u.app_roles.includes('driver'));
  const patientsById=new Map((patients||[]).map((p)=>[p.id,p]));
  const deliveriesWithAmounts=(deliveries||[]).filter((d)=>Number(d?.cod_total_amount_required||0)>0);
  // Query ALL location IDs from all configs (active + inactive) to catch transactions on any terminal
  const locationIds=Array.from(new Set((locationConfigs||[]).map((c)=>c?.square_location_id).filter(Boolean)));
  const completedOrders=await listOrders(locationIds,lookbackStartAt,accessToken,MAX_TRANSACTION_ORDERS,['COMPLETED','OPEN']);
  const refundedOrderIds=buildRefundedOrderIdSet(completedOrders);
  const paidOrderItems=flattenOrderItems((completedOrders||[]).filter((o)=>!refundedOrderIds.has(o?.id))).filter((item)=>{const t=new Date(item?.payment_date||item?.order_created_at||0).getTime();return Number.isFinite(t)&&t>=getTransactionRetentionStartMs();});
  const getDriverFromDelivery=(d)=>drivers.find((dr)=>dr?.user_id===d?.driver_id||dr?.id===d?.driver_id)||null;
  // For matching, use the resolved store (abbr-aware) but also search across all stores at the same location
  const getDeliveryCandidatesForItem=(item,resolvedStore)=>{const payIso=(item?.payment_date||item?.order_created_at||'').slice(0,10);const combined=`${normalizeText(item?.note||'')} ${normalizeText(item?.item_name||'')}`.trim();const locationStores=storesByLocationId.get(item?.location_id)||[];return deliveriesWithAmounts.filter((d)=>{const storeMatch=locationStores.some((s)=>s?.id===d?.store_id);if(!storeMatch)return false;const matchingStore=locationStores.find((s)=>s?.id===d?.store_id)||resolvedStore;if(matchingStore&&!itemNameContainsStore(item?.item_name,matchingStore)&&!itemNameContainsStore(item?.note,matchingStore)){const anyStoreMatch=locationStores.some((s)=>itemNameContainsStore(item?.item_name,s)||itemNameContainsStore(item?.note,s));if(!anyStoreMatch)return false;}const da=Math.round(Number(d?.cod_total_amount_required||0)*100);if(da!==toAmountCents(item?.amount_cents))return false;const cs=buildLocationDateAmountSignatureCandidates(item?.location_id,d?.delivery_date,da,5);const is=buildLocationDateAmountSignature(item?.location_id,payIso||item?.item_name,item?.amount_cents);if(!cs.includes(is))return false;const pt=patientsById.get(d?.patient_id);return pt&&notesContainPatientName(combined,pt.full_name);});};
  const matchDeliveryForItem=(item,resolvedStore)=>{const note=normalizeText(item?.note||'');const cands=getDeliveryCandidatesForItem(item,resolvedStore);if(!cands.length)return null;const ssc=resolvedStore?.id?cands.filter((d)=>d?.store_id===resolvedStore.id):[];const pri=ssc.length?[...ssc,...cands.filter((d)=>d?.store_id!==resolvedStore?.id)]:cands;const dm=note.match(/delivery\s*(id|#)?\s*[:=-]?\s*([a-f0-9]{24})/i);if(dm){const m=pri.find((d)=>d?.id===dm[2]);if(m)return m;}const sm=note.match(/\b(?:sid|stop\s*id)\s*[:=-]?\s*([a-z0-9-]+)/i);if(sm){const m=pri.find((d)=>normalizeText(d?.stop_id).toLowerCase()===normalizeText(sm[1]).toLowerCase());if(m)return m;}return pri.find((d)=>{const p=patientsById.get(d?.patient_id);return p&&notesContainPatientName(note,p.full_name);})||pri.find((d)=>{const p=patientsById.get(d?.patient_id);return p&&notesContainPatientName(item?.item_name,p.full_name);})||pri[0];};
  const transactionRecords=[];const seenKeys=new Set();
  for(const item of paidOrderItems){const ukey=`${item?.order_id}::${item?.line_item_uid}`;if(seenKeys.has(ukey))continue;seenKeys.add(ukey);const store=resolveStoreForItem(item?.item_name,item?.location_id,storesByLocationId);const md=matchDeliveryForItem(item,store);const mp=md?patientsById.get(md?.patient_id):null;const mdr=md?getDriverFromDelivery(md):null;// Use the matched delivery's actual store for the item name (it's the authoritative store)
  const ms=md?(stores||[]).find((s)=>s?.id===md.store_id)||store:store;const isCustom=!normalizeText(item?.catalog_object_id);const fmtName=md?formatItemName(md.delivery_date,getPreferredStoreAbbreviation(ms),mp?.full_name||md?.patient_name):'';const dn=isCustom&&fmtName?fmtName:(item?.item_name||'');const existing=(existingTransactions||[]).find((t)=>normalizeText(t?.square_transaction_id)===normalizeText(item?.order_id)&&normalizeText(t?.raw_square_data?.line_item_uid)===normalizeText(item?.line_item_uid));const pr={square_transaction_id:item?.order_id||null,square_payment_id:`${item?.order_id||'order'}:${item?.line_item_uid||'line'}`,square_catalog_object_id:item?.catalog_object_id||null,item_name:dn,amount:toAmountCents(item?.amount_cents)/100,amount_cents:toAmountCents(item?.amount_cents),type:'collection',status:item?.transaction_status||'pending',delivery_id:md?.id||null,patient_id:mp?.id||md?.patient_id||null,store_id:md?.store_id||store?.id||null,location_id:item?.location_id||null,driver_id:md?.driver_id||mdr?.id||mdr?.user_id||null,dispatcher_id:md?.created_by_app_user_id||null,payment_method:'card',raw_square_data:{...(existing?.raw_square_data||{}),line_item_uid:item?.line_item_uid||null,payment_date:item?.payment_date||null,order_created_at:item?.order_created_at||null,order_state:item?.order_state||null,notes:item?.note||'',original_item_name:item?.item_name||'',is_custom_amount:isCustom,matched_by:md?'delivery_match':'unmatched'}};
  if(existing){await base44.asServiceRole.entities.SquareTransaction.update(existing.id,pr);transactionRecords.push({id:existing.id,...pr});}else{const c=await base44.asServiceRole.entities.SquareTransaction.create(pr);transactionRecords.push(c);}}
  return{success:true,paused:false,paymentsCount:transactionRecords.length,transactions:transactionRecords,soldItems:transactionRecords,soldCatalogItems:transactionRecords.filter((t)=>t?.square_catalog_object_id),catalogItems:[],catalogItemCount:0,dateRange:{start_at:lookbackStartAt,end_at:new Date().toISOString(),days_back:daysBack}};
}

async function handleGetCodData(base44, payload={}) {
  const accessToken=ensureSquareToken();const monitor=createSquareSyncMonitor(base44,'square_get_cod_data');const queue=createSquareRequestQueue(monitor);await monitor.start({action:'getCodData'});
  const daysBack=Math.max(1,Number(payload?.daysBack||TRANSACTION_RETENTION_DAYS)||TRANSACTION_RETENTION_DAYS);
  const transactionRetentionStartMs=Date.now()-daysBack*86400000;const refreshDeliveries=shouldRefreshDeliveries(payload?.lastDeliverySyncAt,payload?.forceDeliveryRefresh===true);
  // quickSync: only query Square API for the daysBack window — caller merges with existing offline data
  const[allLocationConfigs,stores,existingTransactions]=await Promise.all([base44.asServiceRole.entities.SquareLocationConfig.list('-updated_date',500).catch(()=>[]),base44.asServiceRole.entities.Store.list('-updated_date',500).catch(()=>[]),base44.asServiceRole.entities.SquareTransaction.list('-updated_date',2000).catch(()=>[])]);
  const safeAllConfigs=(Array.isArray(allLocationConfigs)?allLocationConfigs:[]).map(unwrapEntityRecord).filter(Boolean);
  // Active configs are used for store-matching; ALL configs (including inactive) are used for the Square API location query
  const safeConfigs=safeAllConfigs.filter((c)=>c?.status==='active');
  const safeStores=(Array.isArray(stores)?stores:[]).map(unwrapEntityRecord).filter(Boolean);
  const activeConfigById=new Map(safeConfigs.map((c)=>[c.id,c]));
  const storesByLocationIdGCD=buildStoresByLocationId(safeStores,activeConfigById);
  // Pull ALL unique square_location_ids (active + inactive) so we don't miss transactions for any card/terminal
  const locationIds=Array.from(new Set(safeAllConfigs.map((c)=>c?.square_location_id).filter(Boolean)));
  const endDate=new Date();const startDate=new Date();startDate.setDate(startDate.getDate()-daysBack);
  const startDateStr=formatLocalDate(startDate);const endDateStr=formatLocalDate(endDate);
  const storeSquareEligibility=new Map();
  for(const store of safeStores){const c=activeConfigById.get(store?.square_location_config_id);if(!c?.square_location_id)continue;const fh=Array.isArray(store.app_fee_history)?store.app_fee_history:[];const ae=fh.filter((e)=>e?.pays_app_fees===true&&e?.effective_date).sort((a,b)=>String(a.effective_date).localeCompare(String(b.effective_date)));storeSquareEligibility.set(store.id,ae.length>0?ae[0].effective_date:null);}
  let deliveryFetchPromise=Promise.resolve([]);
  if(refreshDeliveries){deliveryFetchPromise=base44.asServiceRole.entities.Delivery.filter({delivery_date:{$gte:startDateStr,$lte:endDateStr}},'-updated_date',5000).catch(()=>[]);}
  let safeDeliveries=[];
  const [liveCatalogItems,completedOrders,rawDeliveries]=await Promise.all([
    listActiveCatalogItems(accessToken,{monitor,queue}).catch(()=>[]),
    listOrders(locationIds,getLookbackStartAt(daysBack),accessToken,MAX_TRANSACTION_ORDERS,['COMPLETED','OPEN'],{monitor,queue}).catch(()=>[]),
    deliveryFetchPromise
  ]);
  if(refreshDeliveries){const all=(Array.isArray(rawDeliveries)?rawDeliveries:[]).map(unwrapEntityRecord).filter(Boolean);safeDeliveries=all.filter((d)=>{if(!storeSquareEligibility.has(d?.store_id))return false;const ef=storeSquareEligibility.get(d.store_id);return!(ef&&d.delivery_date<ef);});}
  const refundedOrderIds=buildRefundedOrderIdSet(completedOrders);
  const paidOrderItems=flattenOrderItems((completedOrders||[]).filter((o)=>!refundedOrderIds.has(o?.id))).filter((item)=>{const t=new Date(item?.payment_date||item?.order_created_at||0).getTime();return Number.isFinite(t)&&t>=transactionRetentionStartMs;});
  const catalogRecords=(liveCatalogItems||[]).reduce((acc,item)=>{const ac=getCatalogItemAmountCents(item);const itemName=item?.item_data?.name||'';const lids=Array.from(new Set([...(item?.present_at_location_ids||[]),...(item?.item_data?.variations||[]).flatMap((v)=>v?.present_at_location_ids||[])].filter(Boolean)));if(!lids.length)return acc;const mt=(existingTransactions||[]).find((t)=>normalizeText(t.square_catalog_object_id)===normalizeText(item?.id)||buildItemSignature(t?.item_name,t?.amount_cents??Math.round(Number(t?.amount||0)*100))===buildItemSignature(itemName,ac));const rl=mt?.location_id&&lids.includes(mt.location_id)?mt.location_id:lids.find((l)=>storesByLocationIdGCD.has(l))||lids[0];// Use abbreviation in item name to resolve correct store when multiple stores share a location
  const store=resolveStoreForItem(itemName,rl,storesByLocationIdGCD);acc.push({id:item?.id,square_catalog_object_id:item?.id,square_catalog_version:item?.version||null,item_name:itemName,description:item?.item_data?.description||'',amount:ac/100,amount_cents:ac,delivery_id:mt?.delivery_id||null,delivery_date:toIsoDate(itemName),patient_id:mt?.patient_id||null,store_id:mt?.store_id||store?.id||null,location_id:rl,status:'active',created_date:item?.created_at||null,updated_date:item?.updated_at||null});return acc;},[]);
  const seenTxKeys=new Set();const recentTxRecords=[];
  for(const item of paidOrderItems){const uk=`${item?.order_id}::${item?.line_item_uid}`;if(!item?.order_id||seenTxKeys.has(uk))continue;seenTxKeys.add(uk);const store=resolveStoreForItem(item?.item_name,item?.location_id,storesByLocationIdGCD);const mt=(existingTransactions||[]).find((t)=>normalizeText(t?.square_transaction_id)===normalizeText(item?.order_id)&&normalizeText(t?.raw_square_data?.line_item_uid)===normalizeText(item?.line_item_uid));const ac=toAmountCents(item?.amount_cents);recentTxRecords.push({id:mt?.id||`${item?.order_id}:${item?.line_item_uid}`,square_transaction_id:item?.order_id||null,square_payment_id:`${item?.order_id||'order'}:${item?.line_item_uid||'line'}`,square_catalog_object_id:item?.catalog_object_id||null,item_name:item?.item_name||'',amount:ac/100,amount_cents:ac,type:'collection',status:item?.transaction_status||'pending',delivery_id:mt?.delivery_id||null,patient_id:mt?.patient_id||null,store_id:mt?.store_id||store?.id||null,location_id:item?.location_id||null,driver_id:mt?.driver_id||null,dispatcher_id:mt?.dispatcher_id||null,payment_method:mt?.payment_method||'card',created_date:item?.payment_date||mt?.created_date||null,updated_date:item?.payment_date||mt?.updated_date||null,raw_square_data:{...(mt?.raw_square_data||{}),line_item_uid:item?.line_item_uid||null,payment_date:item?.payment_date||null,order_created_at:item?.order_created_at||null,order_state:item?.order_state||null,notes:item?.note||''}});}
  const strippedDeliveries=safeDeliveries.map((d)=>({id:d?.id,delivery_id:d?.delivery_id,delivery_date:d?.delivery_date,status:d?.status,cod_total_amount_required:d?.cod_total_amount_required,cod_payments:d?.cod_payments,store_id:d?.store_id,patient_id:d?.patient_id,driver_id:d?.driver_id,driver_name:d?.driver_name}));
  await monitor.finish(monitor.state.rateLimitHits>0?'warning':'success','Square COD data sync completed',{catalogCount:catalogRecords.length,transactionCount:recentTxRecords.length,deliveriesLoaded:strippedDeliveries.length,locationCount:locationIds.length});
  return{success:true,deliveries:strippedDeliveries,shouldRefreshDeliveries:refreshDeliveries,deliverySyncWindow:{startDate:startDateStr,endDate:endDateStr,daysBack,refreshedAt:refreshDeliveries?new Date().toISOString():null},catalogRecords,transactionRecords:recentTxRecords,locationConfigs:safeConfigs,locationIds};
}

async function handleRecordPayment(base44, payload) {
  const{deliveryId,paymentMethod,driverId,patientId,storeId}=payload||{};
  if(!deliveryId||!paymentMethod)throw new HttpError(400,'Missing required fields: deliveryId, paymentMethod');
  const user=await requireUser(base44);
  const transactions=await base44.asServiceRole.entities.SquareTransaction.filter({delivery_id:deliveryId,status:'pending'});
  if(transactions.length===0)throw new HttpError(404,'No pending Square transaction found for this delivery');
  const tx=transactions[0];
  await base44.asServiceRole.entities.SquareTransaction.update(tx.id,{status:'completed',payment_method:paymentMethod.toLowerCase(),driver_id:driverId||user.id,patient_id:patientId,store_id:storeId,raw_square_data:{...tx.raw_square_data,payment_recorded_at:new Date().toISOString(),payment_method:paymentMethod}});
  return{success:true,transactionId:tx.id,itemName:tx.item_name,amount:tx.amount,paymentMethod};
}

async function handleSyncCatalogItems(base44, payload={}) {
  const accessToken=ensureSquareToken();
  const daysBack=Math.max(1,Number(payload?.daysBack||TRANSACTION_RETENTION_DAYS)||TRANSACTION_RETENTION_DAYS);
  const lookbackStartStr=formatLocalDate(new Date(Date.now()-daysBack*86400000));
  const todayStr=formatLocalDate(new Date());
  const[deliveries,stores,squareConfigs,squareTransactions]=await Promise.all([base44.asServiceRole.entities.Delivery.filter({delivery_date:{$gte:lookbackStartStr,$lte:todayStr}},'-updated_date',5000),base44.asServiceRole.entities.Store.list('-updated_date',200),base44.asServiceRole.entities.SquareLocationConfig.list('-updated_date',200),base44.asServiceRole.entities.SquareTransaction.list('-updated_date',5000)]);
  const activeConfigById=new Map((squareConfigs||[]).filter((c)=>c?.status==='active'&&c?.square_location_id).map((c)=>[c.id,c]));
  const storeById=new Map((stores||[]).map((s)=>[s.id,s]));const deliveryById=new Map((deliveries||[]).map((d)=>[d.id,d]));
  // Query ALL location IDs (active + inactive) so we catch paid transactions from any terminal
  const allSquareLocationIds=Array.from(new Set((squareConfigs||[]).map((c)=>c?.square_location_id).filter(Boolean)));
  const txRetentionMs=getTransactionRetentionStartMs();
  // Bulk reconciliation: include all COD deliveries in the date window that are active or completed.
  // Pending/failed/cancelled are excluded — pending items are not yet out for delivery,
  // failed/cancelled should have their Square items removed (handled by event-driven sync).
  const allCodDeliveries=(deliveries||[]).filter((d)=>
    Number(d?.cod_total_amount_required||0)>0 &&
    (d?.status==='in_transit'||d?.status==='en_route'||d?.status==='completed') &&
    d?.delivery_date>=lookbackStartStr &&
    d?.delivery_date<=todayStr
  );
  const{patientById,patientByPid}=await buildPatientMaps(base44,allCodDeliveries);
  const[allCatalogItems,completedOrders]=await Promise.all([listActiveCatalogItems(accessToken),listOrders(allSquareLocationIds,getLookbackStartAt(TRANSACTION_RETENTION_DAYS),accessToken,MAX_TRANSACTION_ORDERS,['COMPLETED','OPEN'])]);
  // Pre-fetch ALL patients upfront so the delivery loop never needs individual async lookups
  const allPatients=await base44.asServiceRole.entities.Patient.list('-updated_date',5000).catch(()=>[]);
  for(const p of allPatients||[]){if(p?.id&&!patientById.has(p.id))patientById.set(p.id,p);const pid=normalizeText(p?.patient_id);if(pid&&!patientByPid.has(pid))patientByPid.set(pid,p);}
  const refundedOrderIds=buildRefundedOrderIdSet(completedOrders);
  const nonRefundedOrders=(completedOrders||[]).filter((o)=>!refundedOrderIds.has(o?.id));
  const recentCatalogItems=allCatalogItems||[];const paidOrderItems=flattenOrderItems(nonRefundedOrders);
  const recentSquareTx=(squareTransactions||[]).filter((t)=>{const tm=new Date(t?.created_date||t?.updated_date||0).getTime();return Number.isFinite(tm)&&tm>=txRetentionMs;});
  const catalogBySignature=new Map();const catalogByDateLocationAmount=new Map();
  for(const item of recentCatalogItems){const n=normalizeText(item?.item_data?.name);if(!n)continue;const ac=getCatalogItemAmountCents(item);catalogBySignature.set(buildItemSignature(n,ac),item);for(const lid of getCatalogItemLocationIds(item)){const sig=buildLocationDateAmountSignature(lid,n,ac);if(!catalogByDateLocationAmount.has(sig))catalogByDateLocationAmount.set(sig,item);}}
  const paidCatalogObjectIds=new Set(paidOrderItems.map((x)=>x.catalog_object_id).filter(Boolean));
  const paidOrderItemSignatures=new Set();const paidOrderComparableSignatures=new Set();const paidOrderItemsByDLA=new Map();
  for(const item of paidOrderItems){const sig=buildLocationDateAmountSignature(item.location_id,item.item_name,item.amount_cents);paidOrderItemSignatures.add(buildItemSignature(item.item_name,item.amount_cents));paidOrderComparableSignatures.add(buildComparableLocationSignature(item.item_name,item.amount_cents,item.location_id));if(!paidOrderItemsByDLA.has(sig))paidOrderItemsByDLA.set(sig,[]);paidOrderItemsByDLA.get(sig).push(item);}
  const txByDeliveryId=new Map();const settledCatIds=new Set();const settledItemSigs=new Set();const settledComparableSigs=new Set();const settledDLASigs=new Set();
  for(const t of recentSquareTx){const ac=t?.amount_cents??Math.round(Number(t?.amount||0)*100);if(t?.delivery_id){if(!txByDeliveryId.has(t.delivery_id))txByDeliveryId.set(t.delivery_id,[]);txByDeliveryId.get(t.delivery_id).push(t);}if(t?.status&&t.status!=='pending'){if(t?.square_catalog_object_id)settledCatIds.add(t.square_catalog_object_id);settledItemSigs.add(buildItemSignature(t?.item_name,ac));settledComparableSigs.add(buildComparableLocationSignature(t?.item_name,ac,t?.location_id));for(const sig of buildLocationDateAmountSignatureCandidates(t?.location_id,t?.item_name,ac))settledDLASigs.add(sig);}}
  const itemsToDelete=[];const txToCancel=[];const txToComplete=[];const deliveriesToSync=[];const matchedCatIds=new Set();const matchedDLASigs=new Set();
  for(const item of recentCatalogItems){const n=normalizeText(item?.item_data?.name);if(!n)continue;const ac=getCatalogItemAmountCents(item);const isig=buildItemSignature(n,ac);const lids=getCatalogItemLocationIds(item);const compSigs=lids.map((l)=>buildComparableLocationSignature(n,ac,l));const varIds=(item?.item_data?.variations||[]).map((v)=>v?.id).filter(Boolean);const dateSigs=lids.map((l)=>buildLocationDateAmountSignature(l,n,ac));const byPaid=paidCatalogObjectIds.has(item.id)||varIds.some((v)=>paidCatalogObjectIds.has(v))||paidOrderItemSignatures.has(isig)||compSigs.some((s)=>paidOrderComparableSignatures.has(s))||dateSigs.some((s)=>paidOrderItemsByDLA.has(s));const bySettled=settledCatIds.has(item.id)||varIds.some((v)=>settledCatIds.has(v))||settledItemSigs.has(isig)||compSigs.some((s)=>settledComparableSigs.has(s))||dateSigs.some((s)=>settledDLASigs.has(s));if(byPaid||bySettled){matchedCatIds.add(item.id);dateSigs.forEach((s)=>matchedDLASigs.add(s));itemsToDelete.push(item.id);}}
  for(const t of recentSquareTx){if(t?.status!=='pending')continue;const cs=buildLocationDateAmountSignatureCandidates(t?.location_id,deliveryById.get(t?.delivery_id)?.delivery_date||t?.item_name,t?.amount_cents??Math.round(Number(t?.amount||0)*100));if(matchedCatIds.has(t?.square_catalog_object_id)||cs.some((s)=>matchedDLASigs.has(s)))txToComplete.push(t.id);}
  for(const delivery of allCodDeliveries){const store=storeById.get(delivery.store_id);const ac=activeConfigById.get(store?.square_location_config_id);
  // Use pre-loaded patient maps — no async lookup needed
  const rp=patientById.get(delivery.patient_id)||patientByPid.get(normalizeText(delivery.patient_id))||null;
  const rpn=normalizeText(rp?.full_name||delivery?.patient_name)||'Unknown Patient';const itemName=formatItemName(delivery.delivery_date,store?.abbreviation,rpn);const amountCents=Math.round(Number(delivery.cod_total_amount_required||0)*100);const sig=buildItemSignature(itemName,amountCents);const dSigs=buildLocationDateAmountSignatureCandidates(ac?.square_location_id,delivery.delivery_date,amountCents);let catalogItem=catalogBySignature.get(sig)||dSigs.map((s)=>catalogByDateLocationAmount.get(s)).find(Boolean)||null;const exTx=txByDeliveryId.get(delivery.id)||[];const settledTx=exTx.filter((t)=>t?.status&&t.status!=='pending');const phNames=new Set(buildPlaceholderItemNames(delivery.delivery_date,store?.abbreviation));if(rpn!=='Unknown Patient'&&ac?.square_location_id)for(const pi of recentCatalogItems){const pn=normalizeText(pi?.item_data?.name);if(!phNames.has(pn))continue;if(getCatalogItemAmountCents(pi)!==amountCents)continue;if(isCatalogItemAtLocation(pi,ac.square_location_id))itemsToDelete.push(pi.id);}
  const exPending=exTx.find((t)=>t.status==='pending');if(exPending?.square_catalog_object_id&&(exPending.item_name!==itemName||toAmountCents(exPending.amount_cents)!==amountCents)){itemsToDelete.push(exPending.square_catalog_object_id);if(catalogItem?.id===exPending.square_catalog_object_id)catalogItem=null;}
  const hasCard=hasCollectedCardPayment(delivery);const hasOffline=hasCollectedOfflinePayment(delivery);const hasSquarePaid=paidOrderItemSignatures.has(sig)||paidOrderComparableSignatures.has(buildComparableLocationSignature(itemName,amountCents,ac?.square_location_id))||dSigs.some((s)=>paidOrderItemsByDLA.has(s))||settledTx.length>0||settledItemSigs.has(sig)||settledComparableSigs.has(buildComparableLocationSignature(itemName,amountCents,ac?.square_location_id))||dSigs.some((s)=>settledDLASigs.has(s));
  const delForInvalid=!ac||!store?.square_location_config_id||!ac?.square_location_id||delivery?.status==='failed';const shouldDel=delForInvalid||hasSquarePaid;
  if(catalogItem&&!isCatalogItemAtLocation(catalogItem,ac?.square_location_id)){itemsToDelete.push(catalogItem.id);catalogItem=null;}
  if(shouldDel){if(catalogItem?.id)itemsToDelete.push(catalogItem.id);for(const t of exTx){if(t.status!=='pending')continue;if(delForInvalid)txToCancel.push(t.id);else if(hasSquarePaid)txToComplete.push(t.id);}continue;}
  deliveriesToSync.push({delivery,itemName,patientName:rpn,patientId:rp?.id||(isValidEntityId(delivery.patient_id)?delivery.patient_id:null),amountCents,locationId:ac.square_location_id,existingCatalogItem:catalogItem});}
  const uniqueDel=Array.from(new Set(itemsToDelete.filter(Boolean)));const deleteResult=uniqueDel.length?await deleteCatalogObjects(uniqueDel,accessToken):{deleted:[],failed:[]};
  for(const tid of Array.from(new Set(txToCancel.filter(Boolean))))await base44.asServiceRole.entities.SquareTransaction.update(tid,{status:'cancelled'});
  for(const tid of Array.from(new Set(txToComplete.filter(Boolean))))await base44.asServiceRole.entities.SquareTransaction.update(tid,{status:'completed'});
  let createdCount=0;let updatedCount=0;
  for(const entry of deliveriesToSync){const{delivery,itemName,patientName,patientId,amountCents,locationId,existingCatalogItem}=entry;const sig=buildItemSignature(itemName,amountCents);let ci=existingCatalogItem||catalogBySignature.get(sig)||null;if(!ci?.id){ci=await createCatalogItem({itemName,amountCents,locationId,deliveryId:delivery.id,patientName,accessToken});if(!ci?.id)throw new Error(`Square did not return a catalog item for delivery ${delivery.id}`);catalogBySignature.set(sig,ci);catalogByDateLocationAmount.set(buildLocationDateAmountSignature(locationId,delivery.delivery_date,amountCents),ci);createdCount++;}const exPending=(txByDeliveryId.get(delivery.id)||[]).find((t)=>t.status==='pending');const txPayload={item_name:itemName,amount:Number(delivery.cod_total_amount_required||0),amount_cents:amountCents,type:'collection',status:'pending',delivery_id:delivery.id,patient_id:patientId,store_id:delivery.store_id,location_id:locationId,driver_id:delivery.driver_id||null,dispatcher_id:delivery.dispatcher_id||null,square_catalog_object_id:ci.id,square_catalog_version:ci.version||null};if(exPending){await base44.asServiceRole.entities.SquareTransaction.update(exPending.id,txPayload);updatedCount++;}else await base44.asServiceRole.entities.SquareTransaction.create(txPayload);}
  const allTxAfter=await base44.asServiceRole.entities.SquareTransaction.list('-updated_date',2000);const toRemove=(allTxAfter||[]).filter((t)=>t?.square_catalog_object_id&&t?.status&&t.status!=='pending');const extraIds=Array.from(new Set(toRemove.map((t)=>t.square_catalog_object_id).filter(Boolean))).filter((id)=>!deleteResult.deleted.includes(id));const extraDel=extraIds.length?await deleteCatalogObjects(extraIds,accessToken):{deleted:[],failed:[]};
  const stale=(allTxAfter||[]).filter((t)=>{const tm=new Date(t?.created_date||t?.updated_date||0).getTime();return Number.isFinite(tm)&&tm<txRetentionMs;});for(const t of stale)await base44.asServiceRole.entities.SquareTransaction.delete(t.id);
  return{success:true,scanned_deliveries:allCodDeliveries.length,catalog_items_seen:recentCatalogItems.length,paid_order_items_seen:paidOrderItems.length,deleted_catalog_items:deleteResult.deleted.length+extraDel.deleted.length,cancelled_transactions:Array.from(new Set(txToCancel.filter(Boolean))).length,completed_transactions:Array.from(new Set(txToComplete.filter(Boolean))).length,created_catalog_items:createdCount,updated_pending_transactions:updatedCount,pruned_transactions:stale.length,synced_square_catalog_items:0};
}

async function handleSyncOnlineSquareEntities(base44, payload) {
  const catalogRecords=Array.isArray(payload?.catalogRecords)?payload.catalogRecords.filter(Boolean):[];
  const transactionRecords=Array.isArray(payload?.transactionRecords)?payload.transactionRecords.filter(Boolean):[];
  const stripMeta=(r)=>{const{id,created_date,updated_date,created_by,created_by_id,is_sample,...rest}=r||{};return rest;};
  const normCatalog=(r)=>{const c=stripMeta(r);if(!c)return null;return{square_catalog_object_id:c.square_catalog_object_id||c.catalog_object_id||null,square_catalog_version:c.square_catalog_version||c.version||null,item_name:c.item_name||c.name||null,description:c.description||'',amount:c.amount??c.price_dollars??(c.price_cents!=null?Number(c.price_cents)/100:null),amount_cents:c.amount_cents??c.price_cents??null,delivery_id:c.delivery_id||null,delivery_date:c.delivery_date||null,patient_id:c.patient_id||null,store_id:c.store_id||null,location_id:c.location_id||null,status:c.status||'active'};};
  const cleanCatalog=catalogRecords.map(normCatalog).filter((r)=>r?.square_catalog_object_id&&r?.item_name&&r?.amount!=null&&r?.location_id);const cleanTx=transactionRecords.map(stripMeta).filter(Boolean);
  const bulkCreate=async(api,records)=>{if(!records.length)return;const cs=20;for(let i=0;i<records.length;i+=cs){await api.bulkCreate(records.slice(i,i+cs));if(i+cs<records.length)await sleep(100);}};
  await Promise.all([paginatedDeleteAll(base44.asServiceRole.entities.SquareCatalogItems,100),paginatedDeleteAll(base44.asServiceRole.entities.SquareTransaction,100)]);
  await Promise.all([cleanCatalog.length>0?bulkCreate(base44.asServiceRole.entities.SquareCatalogItems,cleanCatalog):Promise.resolve(),cleanTx.length>0?bulkCreate(base44.asServiceRole.entities.SquareTransaction,cleanTx):Promise.resolve()]);
  return{success:true,paused:false,catalogCount:cleanCatalog.length,transactionCount:cleanTx.length};
}

async function handleReconcile(base44, payload) {
  // payload: { deliveries, transactions, catalogItems, patients, stores, locationConfigs }
  // All data is passed from the frontend so we don't need extra DB calls for the matching phase.
  const deliveries = Array.isArray(payload?.deliveries) ? payload.deliveries : [];
  const transactions = Array.isArray(payload?.transactions) ? payload.transactions : [];
  const catalogItems = Array.isArray(payload?.catalogItems) ? payload.catalogItems : [];
  const patients = Array.isArray(payload?.patients) ? payload.patients : [];
  const stores = Array.isArray(payload?.stores) ? payload.stores : [];
  const locationConfigs = Array.isArray(payload?.locationConfigs) ? payload.locationConfigs : [];

  const patientById = new Map(patients.map((p) => [p.id, p]));
  const storeById = new Map(stores.map((s) => [s.id, s]));
  const configById = new Map(locationConfigs.map((c) => [c.id, c]));

  // ── STEP 1: Identify "No Match" deliveries (in date range, with COD amount) ──
  const noMatchDeliveries = deliveries.filter((d) => {
    if (!d || Number(d.cod_total_amount_required || 0) <= 0) return false;
    if (d.status === 'failed' || d.status === 'cancelled') return false;
    return true;
  });

  // ── STEP 2: Identify "No Match" transactions (collection type, pending) ──
  const noMatchTransactions = transactions.filter((t) => {
    if (!t) return false;
    if (t.type !== 'collection') return false;
    if (!['completed', 'pending'].includes(t.status)) return false;
    return true;
  });

  // ── STEP 3: Match transactions → deliveries by patient name + amount ──
  // Location/store mismatch is acceptable per spec.
  const matchResults = []; // { transactionId, deliveryId, matchedBy }
  const usedDeliveryIds = new Set();

  const normalizeN = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const tokenize = (v) => normalizeN(v).split(' ').filter((t) => t.length >= 2);
  const namesMatch = (a, b) => {
    const na = normalizeN(a); const nb = normalizeN(b);
    if (!na || !nb) return false;
    if (na.includes(nb) || nb.includes(na)) return true;
    const ta = tokenize(na); const tb = tokenize(nb);
    if (!ta.length || !tb.length) return false;
    return ta.every((t) => tb.some((u) => u.includes(t) || t.includes(u) || (Math.max(t.length, u.length) >= 4 && levenshteinDistance(t, u) <= 1)));
  };

  for (const tx of noMatchTransactions) {
    const txAmountCents = toAmountCents(tx.amount || (tx.amount_cents / 100));
    const parsedName = (() => {
      const n = String(tx.item_name || '');
      const m = n.match(/\d{1,2}[\/-]\d{1,2}\([^)]+\)-(.+)$/);
      return m ? m[1].trim() : n.replace(/^\d{1,2}[\/-]\d{1,2}/, '').replace(/\([^)]+\)/, '').replace(/^[-\s]+/, '').trim();
    })();

    let bestMatch = null;
    for (const d of noMatchDeliveries) {
      if (usedDeliveryIds.has(d.id)) continue;
      const dAmountCents = toAmountCents(d.cod_total_amount_required);
      if (dAmountCents !== txAmountCents) continue;
      const patient = patientById.get(d.patient_id);
      if (!patient?.full_name) continue;
      if (!namesMatch(patient.full_name, parsedName)) continue;
      bestMatch = d;
      break;
    }

    if (bestMatch) {
      usedDeliveryIds.add(bestMatch.id);
      matchResults.push({ transactionId: tx.id, deliveryId: bestMatch.id, matchedBy: 'name_and_amount' });
    }
  }

  // ── STEP 4: Re-collect deliveries that are STILL unmatched after step 3 ──
  const nowMatchedDeliveryIds = new Set(matchResults.map((m) => m.deliveryId));
  // Also consider deliveries that already had a matching transaction (passed in as matched)
  const stillUnmatched = noMatchDeliveries.filter((d) => !nowMatchedDeliveryIds.has(d.id));

  // ── STEP 5: Filter out deliveries that already have a catalog item ──
  const catalogDeliveryIds = new Set(catalogItems.map((c) => c.delivery_id).filter(Boolean));
  const needsCatalogItem = stillUnmatched.filter((d) => !catalogDeliveryIds.has(d.id));

  // ── Create Square catalog items for remaining unmatched deliveries ──
  const createResults = [];
  for (const delivery of needsCatalogItem) {
    try {
      const r = await handleCreateCodItem(base44, {
        deliveryId: delivery.id,
        codAmount: delivery.cod_total_amount_required,
        deliveryDate: delivery.delivery_date,
        storeId: delivery.store_id,
        patientName: delivery.patient_name || null,
      });
      createResults.push({ deliveryId: delivery.id, action: 'upsert', status: r?.skipped ? 'skipped' : 'ok', result: r });
    } catch (err) {
      createResults.push({ deliveryId: delivery.id, action: 'upsert', status: 'error', error: err?.message || 'Failed' });
    }
  }

  return {
    success: true,
    matched: matchResults.length,
    matchResults,
    stillUnmatched: stillUnmatched.length,
    needsCatalogItem: needsCatalogItem.length,
    createResults,
  };
}

// Deletes all Square catalog items that have a matching completed/paid Square order.
// This is the cleanup step after getCodData — it compares the live catalog against live orders
// and removes any catalog items where the COD has already been collected via Square POS.
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

  // Build lookup sets for paid items — by catalog_object_id AND by name+amount signature
  const paidCatalogObjectIds = new Set(paidOrderItems.map((x) => x.catalog_object_id).filter(Boolean));
  const paidItemSignatures = new Set(paidOrderItems.map((x) => buildItemSignature(x.item_name, x.amount_cents)));

  // Find catalog items that have been paid
  const toDelete = (liveCatalogItems||[]).filter((item) => {
    if (!item?.id) return false;
    const n = normalizeText(item?.item_data?.name);
    const ac = getCatalogItemAmountCents(item);
    const varIds = (item?.item_data?.variations||[]).map((v)=>v?.id).filter(Boolean);
    if (paidCatalogObjectIds.has(item.id)) return true;
    if (varIds.some((v) => paidCatalogObjectIds.has(v))) return true;
    if (paidItemSignatures.has(buildItemSignature(n, ac))) return true;
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

async function handleSyncSquareCods(base44, payload) {
  const event=payload?.event;
  if(event?.entity_name==='Delivery'){
    const delivery=payload?.data||await base44.asServiceRole.entities.Delivery.get(event.entity_id).catch(()=>null);
    if(!delivery||Number(delivery?.cod_total_amount_required||0)<=0)return{success:true,processed:0,results:[{deliveryId:event?.entity_id,action:'noop',status:'skipped'}]};
    const oldStatus=normalizeText(payload?.old_data?.status);const newStatus=normalizeText(delivery.status);
    try{
      const hasOffline=hasCollectedOfflinePayment(delivery);const hasCard=hasCollectedCardPayment(delivery);
      // Always delete on failed or cancelled
      if(newStatus==='failed'||newStatus==='cancelled'){const r=await handleDeleteCodItem(base44,{deliveryId:delivery.id,reason:newStatus});return{success:true,processed:1,results:[{deliveryId:delivery.id,action:'delete',status:'ok',result:r}]};}
      // Delete on completed with any payment (offline or card/debit/credit)
      if(newStatus==='completed'&&(hasOffline||hasCard)){const r=await handleDeleteCodItem(base44,{deliveryId:delivery.id,reason:hasOffline?'offline_payment_collected':'card_payment_collected'});return{success:true,processed:1,results:[{deliveryId:delivery.id,action:'delete',status:'ok',result:r}]};}
      // Transitioning from in_transit/en_route back to pending → delete catalog item
      const wasActive=oldStatus==='in_transit'||oldStatus==='en_route';
      if(newStatus==='pending'&&wasActive){const r=await handleDeleteCodItem(base44,{deliveryId:delivery.id,reason:'reverted_to_pending'});return{success:true,processed:1,results:[{deliveryId:delivery.id,action:'delete',status:'ok',result:r}]};}
      // Transitioning to in_transit/en_route → create/update catalog item
      const isNowActive=newStatus==='in_transit'||newStatus==='en_route';
      if(isNowActive){const r=await handleCreateCodItem(base44,{deliveryId:delivery.id,codAmount:delivery.cod_total_amount_required,deliveryDate:delivery.delivery_date,storeId:delivery.store_id,patientName:delivery.patient_name});return{success:true,processed:1,results:[{deliveryId:delivery.id,action:'upsert',status:r?.skipped?'skipped':'ok',result:r}]};}
      // No action needed
      return{success:true,processed:1,results:[{deliveryId:delivery.id,action:'noop',status:'skipped',reason:`no_action_for_transition_${oldStatus}_to_${newStatus}`}]};
    }catch(error){return{success:false,processed:1,results:[{deliveryId:delivery.id,action:'sync',status:'error',error:error?.message||'Square COD sync failed'}]};}
  }
  const items=Array.isArray(payload?.items)?payload.items:[];const deletions=Array.isArray(payload?.deletions)?payload.deletions:[];const purgeCatalogFirst=payload?.purgeCatalogFirst===true;
  if(!items.length&&!deletions.length&&!purgeCatalogFirst)return{success:true,processed:0,results:[]};
  const results=[];
  if(purgeCatalogFirst){const accessToken=ensureSquareToken();const all=await listActiveCatalogItems(accessToken);const ids=Array.from(new Set((all||[]).map((x)=>x?.id).filter(Boolean)));const purgeResult=ids.length?await deleteCatalogObjects(ids,accessToken):{deleted:[],failed:[]};await paginatedDeleteAll(base44.asServiceRole.entities.SquareCatalogItems);const exTx=await base44.asServiceRole.entities.SquareTransaction.list('-updated_date',2000).catch(()=>[]);const pending=(exTx||[]).filter((t)=>t?.status==='pending');for(let i=0;i<pending.length;i+=10){const chunk=pending.slice(i,i+10);await Promise.all(chunk.map((t)=>base44.asServiceRole.entities.SquareTransaction.update(t.id,{status:'cancelled',raw_square_data:{...(t.raw_square_data||{}),deleted_at:new Date().toISOString(),deleted_reason:'purge_catalog_before_sync'}}).catch(()=>null)));if(i+10<pending.length)await sleep(50);}results.push({action:'purge',status:'ok',result:{deletedCatalogItems:purgeResult.deleted.length}});}
  for(const deletion of deletions){try{const r=await handleDeleteCodItem(base44,{deliveryId:deletion?.deliveryId,catalogObjectId:deletion?.catalogObjectId,transactionId:deletion?.transactionId,reason:deletion?.status==='failed'?'failed':deletion?.reason});results.push({deliveryId:deletion?.deliveryId,action:'delete',status:'ok',result:r});}catch(error){results.push({deliveryId:deletion?.deliveryId,action:'delete',status:'error',error:error?.message||'Delete failed'});}}
  for(const item of items){try{const r=await handleCreateCodItem(base44,{deliveryId:item?.deliveryId,patientName:item?.patientName,storeAbbreviation:item?.storeAbbreviation,codAmount:item?.codAmount,deliveryDate:item?.deliveryDate,storeId:item?.storeId});results.push({deliveryId:item?.deliveryId,action:'upsert',status:r?.skipped?'skipped':'ok',result:r});}catch(error){results.push({deliveryId:item?.deliveryId,action:'upsert',status:'error',error:error?.message||'Upsert failed'});}}
  return{success:!results.some((e)=>e.status==='error'),processed:results.length,results};
}

Deno.serve(async (req) => {
  try {
    const base44=createClientFromRequest(req);const payload=await req.json().catch(()=>({}));const action=payload?.action;
    if(action==='createCodItem'){await requireUser(base44);return Response.json(await handleCreateCodItem(base44,payload));}
    if(action==='deleteCodItem'){await requireUser(base44);return Response.json(await handleDeleteCodItem(base44,payload));}
    if(action==='markCollectedDebit'){await requireUser(base44);return Response.json(await handleMarkCollectedDebit(base44,payload));}
    if(action==='fetchPayments'){await requireUser(base44);return Response.json(await handleFetchPayments(base44,payload));}
    if(action==='getCodData')return Response.json(await handleGetCodData(base44,payload));
    if(action==='recordPayment')return Response.json(await handleRecordPayment(base44,payload));
    if(action==='syncCatalogItems'){await requireAdminIfAuthenticated(base44);return Response.json(await handleSyncCatalogItems(base44,payload));}
    if(action==='syncOnlineSquareEntities'){await requireAdminIfAuthenticated(base44);return Response.json(await handleSyncOnlineSquareEntities(base44,payload));}
    if(action==='syncSquareCods'){await requireUser(base44);return Response.json(await handleSyncSquareCods(base44,payload));}
    if(action==='deleteCodItemsByNameAmount'){await requireUser(base44);return Response.json(await handleDeleteCodItemsByNameAmount(base44,payload));}
    if(action==='cleanupCollectedCatalogItems'){await requireAdminIfAuthenticated(base44);return Response.json(await handleCleanupCollectedCatalogItems(base44,payload));}
    if(action==='reconcile'){await requireUser(base44);return Response.json(await handleReconcile(base44,payload));}
    throw new HttpError(400,'Missing or invalid action');
  } catch(error){const status=error?.status||500;return Response.json({error:error?.message||'Internal Server Error'},{status});}
});