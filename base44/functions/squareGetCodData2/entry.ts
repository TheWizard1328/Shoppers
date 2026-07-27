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
const MATCH_DATE_OFFSET_DAYS = 2;
const MATCH_DATE_STRICT_DAYS = 7; // max days between transaction date and catalog item date for a "collected" match
const DELIVERY_BULK_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const MAX_TRANSACTION_ORDERS = 2000;
const isValidEntityId = (v) => /^[a-f0-9]{24}$/i.test(String(v || ''));
const isOfflineCollectedPaymentMethod = (m) => ['cash', 'check', 'other'].includes(String(m || '').toLowerCase());
const shouldIgnoreManualOrderLabel = (v) => ['top ups','top up','topup','tip','top'].includes(String(v||'').replace(/\s+/g,' ').trim().toLowerCase());
const formatLocalDate = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const unwrapEntityRecord = (r) => { if (!r || typeof r !== 'object') return null; if (r.data && typeof r.data === 'object') return { ...r.data, id: r.data.id || r.id, created_date: r.data.created_date || r.created_date, updated_date: r.data.updated_date || r.updated_date }; return r; };
const hasCollectedCardPayment = (d) => (Array.isArray(d?.cod_payments)?d.cod_payments:[]).some((p)=>['Debit','Credit'].includes(p?.type)&&Number(p?.amount||0)>0);
const hasCollectedOfflinePayment = (d) => (Array.isArray(d?.cod_payments)?d.cod_payments:[]).some((p)=>isOfflineCollectedPaymentMethod(p?.type)&&Number(p?.amount||0)>0);
const shouldRefreshDeliveries = (at, force=false) => { if (force) return true; const ms = new Date(at||0).getTime(); return !Number.isFinite(ms)||ms<=0||Date.now()-ms>=DELIVERY_BULK_REFRESH_INTERVAL_MS; };
const getTransactionRetentionStartMs = () => { const t = new Date(); t.setHours(0,0,0,0); t.setDate(t.getDate()-TRANSACTION_RETENTION_DAYS); return t.getTime(); };
const buildItemSignature = (n, c) => `${normalizeText(n)}::${toAmountCents(c)}`;
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
const isCatalogItemAtLocation = (item, lid) => { if (!item||!lid) return false; if (item?.present_at_all_locations) return true; return getCatalogItemLocationIds(item).includes(lid); };
const getCatalogItemAmountCents = (item) => { const vs=item?.item_data?.variations||[]; const v=vs.find((e)=>e?.item_variation_data?.price_money?.amount!=null)||vs[0]; return toAmountCents(v?.item_variation_data?.price_money?.amount); };
const toIsoDate = (v) => { const p=parseDateValue(v); return (p&&!Number.isNaN(p.getTime()))?p.toISOString().slice(0,10):null; };
const getPreferredStoreAbbreviation = (store) => { const n=normalizeText(store?.abbreviation); if (n) return n.toUpperCase(); const ts=normalizeText(store?.name).split(/[^a-zA-Z0-9]+/).map((p)=>p.trim()).filter(Boolean); if (!ts.length) return 'NA'; if (ts.length===1) return ts[0].slice(0,2).toUpperCase(); return ts.map((t)=>t[0]).join('').slice(0,2).toUpperCase(); };
function extractItemNameAbbr(itemName) { const m = String(itemName||'').match(/\(([^)]+)\)/); return m ? normalizeText(m[1]).toUpperCase() : ''; }
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
async function buildPatientMaps(base44, deliveries) {
  const refs=Array.from(new Set((deliveries||[]).map((d)=>normalizeText(d?.patient_id)).filter(Boolean)));
  const eids=refs.filter((id)=>isValidEntityId(id));const pids=refs.filter((id)=>!isValidEntityId(id));
  const [byEid,byPid]=await Promise.all([eids.length?base44.asServiceRole.entities.Patient.filter({id:{$in:eids}}):[], pids.length?base44.asServiceRole.entities.Patient.filter({patient_id:{$in:pids}}):[]]);
  const patients=[...(byEid||[]),...((byPid||[]).filter((p)=>!(byEid||[]).some((e)=>e.id===p.id)))];
  return{patientById:new Map(patients.map((p)=>[p.id,p])),patientByPid:new Map(patients.map((p)=>[normalizeText(p?.patient_id),p]).filter(([id])=>id))};
}
function createSquareRequestQueue(monitor) {
  let counter=0;
  return{async run(step,task){const idx=counter++;if(idx>0)await sleep(SQUARE_REQUEST_SPACING_MS);if(idx>0&&idx%SQUARE_BATCH_SIZE===0)await sleep(SQUARE_BATCH_PAUSE_MS);monitor.state.requestCount++;return task();}};
}
function createSquareSyncMonitor(base44, syncName='square_sync') {
  const state={runId:null,requestCount:0,retryCount:0,rateLimitHits:0,errorCount:0};
  const writeLog=async(level,step,message,details={})=>{console.log(`[SquareSync][${level}] ${step}: ${message}`,JSON.stringify(details));await base44.asServiceRole.entities.SquareSyncLog.create({sync_run_id:state.runId,level,step,message,details,logged_at:new Date().toISOString()}).catch(()=>null);};
  return{state,async start(meta={}){const run=await base44.asServiceRole.entities.SquareSyncHealth.create({sync_name:syncName,status:'running',started_at:new Date().toISOString(),request_count:0,retry_count:0,rate_limit_hits:0,error_count:0,summary:'Sync started',meta}).catch(()=>null);state.runId=run?.id||null;await writeLog('info','start','Square sync started',meta);},async finish(status,summary,meta={}){if(state.runId)await base44.asServiceRole.entities.SquareSyncHealth.update(state.runId,{status,finished_at:new Date().toISOString(),request_count:state.requestCount,retry_count:state.retryCount,rate_limit_hits:state.rateLimitHits,error_count:state.errorCount,summary,meta}).catch(()=>null);await writeLog(status==='error'?'error':status==='warning'?'warn':'info','finish',summary,meta);},async log(level,step,message,details={}){await writeLog(level,step,message,details);}};
}
const getLookbackStartAt = (days) => new Date(Date.now() - days * 86400000).toISOString();
const SQUARE_BATCH_SIZE = 8;
const SQUARE_BATCH_PAUSE_MS = 400;
const SQUARE_REQUEST_SPACING_MS = 100;
const BASE44_SYNC_CHUNK_DELAY_MS = 0; // Eliminated artificial delay — was 300ms per chunk
async function getStoreSquareContext(base44, effectiveStoreId) {
  if(!effectiveStoreId)throw new HttpError(400,'Store ID is required for Square COD item creation');
  const store=await base44.asServiceRole.entities.Store.get(effectiveStoreId).catch(()=>null);if(!store)throw new HttpError(400,`Store not found with ID: ${effectiveStoreId}`);
  if(!store.square_location_config_id)throw new HttpError(400,`Store "${store.name}" is not configured for Square COD payments.`);
  const config=await base44.asServiceRole.entities.SquareLocationConfig.get(store.square_location_config_id).catch(()=>null);if(!config)throw new HttpError(400,`Square location config not found for store "${store.name}"`);
  if(config.status!=='active')throw new HttpError(400,`Square location "${config.name}" is inactive for store "${store.name}"`);
  return{store,config,locationId:config.square_location_id};
}
const buildComparableLocationSignature = (n, c, lid) => `${normalizeText(lid)}::${normalizeMatchName(n)}::${toAmountCents(c)}`;
const requireAdminIfAuthenticated = async (b44) => { const ok = await b44.auth.isAuthenticated().catch(() => false); if (!ok) return null; const u = await b44.auth.me().catch(() => null); if (u?.role !== 'admin') throw new HttpError(403, 'Forbidden: Admin access required'); return u; };
async function paginatedDeleteAll(entityApi, pageSize=200) {
  while(true){const records=await entityApi.list('-updated_date',pageSize).catch(()=>[]);if(!records?.length)break;await Promise.all(records.map((r)=>entityApi.delete(r.id).catch(()=>null)));if(records.length<pageSize)break;}
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

async function handleGetCodData(base44, payload={}) {
  const accessToken=ensureSquareToken();const monitor=createSquareSyncMonitor(base44,'square_get_cod_data');const queue=createSquareRequestQueue(monitor);await monitor.start({action:'getCodData'});
  const daysBack=Math.max(1,Number(payload?.daysBack||TRANSACTION_RETENTION_DAYS)||TRANSACTION_RETENTION_DAYS);
  const transactionRetentionStartMs=Date.now()-daysBack*86400000;const refreshDeliveries=shouldRefreshDeliveries(payload?.lastDeliverySyncAt,payload?.forceDeliveryRefresh===true);
  // quickSync: only query Square API for the daysBack window — caller merges with existing offline data
  // Fetch existing transactions BEFORE the purge so we can preserve matched delivery_id/patient_id
  // during the rebuild. The old code deleted everything first (losing all match data).
  const[allLocationConfigs,stores,existingTransactionsRaw]=await Promise.all([
    base44.asServiceRole.entities.SquareLocationConfig.list('-updated_date',500).catch(()=>[]),
    base44.asServiceRole.entities.Store.list('-updated_date',500).catch(()=>[]),
    base44.asServiceRole.entities.SquareTransaction.list('-updated_date',5000).catch(()=>[])
  ]);
  const existingTransactions=(Array.isArray(existingTransactionsRaw)?existingTransactionsRaw:[]).map(unwrapEntityRecord).filter(Boolean);
  // Build a quick lookup map for matching: orderId::lineItemUid → existing record
  const existingTxByKey=new Map();
  for(const t of existingTransactions){const k=`${normalizeText(t?.square_transaction_id)}::${normalizeText(t?.raw_square_data?.line_item_uid)}`;if(k&&k!=='::')existingTxByKey.set(k,t);}
  // Build a quick lookup by catalog_object_id for catalog matching
  const existingTxByCatalogId=new Map();
  for(const t of existingTransactions){if(t?.square_catalog_object_id)existingTxByCatalogId.set(normalizeText(t.square_catalog_object_id),t);}
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
  // Smart upsert: only delete transactions that are NOT in the new set, then bulk insert new ones.
  // This preserves the DB during the sync instead of nuking everything first.
  const newTxKeys=new Set(recentTxRecords.map((r)=>`${normalizeText(r?.square_transaction_id)}::${normalizeText(r?.raw_square_data?.line_item_uid)}`));
  const staleTxIds=existingTransactions.filter((t)=>{const k=`${normalizeText(t?.square_transaction_id)}::${normalizeText(t?.raw_square_data?.line_item_uid)}`;return k&&!newTxKeys.has(k);}).map((t)=>t.id).filter(Boolean);
  // Delete stale records in parallel (no artificial delays)
  if(staleTxIds.length>0){await Promise.all(staleTxIds.map((id)=>base44.asServiceRole.entities.SquareTransaction.delete(id).catch(()=>null)));}
  // Upsert new/updated transactions in parallel batches (no artificial delays)
  if(recentTxRecords.length>0){const upsertBatch=async(records)=>{const cs=50;for(let i=0;i<records.length;i+=cs){const chunk=records.slice(i,i+cs);await Promise.all(chunk.map((r)=>{const existing=existingTxByKey.get(`${normalizeText(r?.square_transaction_id)}::${normalizeText(r?.raw_square_data?.line_item_uid)}`);if(existing?.id){return base44.asServiceRole.entities.SquareTransaction.update(existing.id,r).catch(()=>null);}return base44.asServiceRole.entities.SquareTransaction.create(r).catch(()=>null);}));}};await upsertBatch(recentTxRecords);}
  await monitor.finish(monitor.state.rateLimitHits>0?'warning':'success','Square COD data sync completed',{catalogCount:catalogRecords.length,transactionCount:recentTxRecords.length,deliveriesLoaded:strippedDeliveries.length,locationCount:locationIds.length});
  return{success:true,deliveries:strippedDeliveries,shouldRefreshDeliveries:refreshDeliveries,deliverySyncWindow:{startDate:startDateStr,endDate:endDateStr,daysBack,refreshedAt:refreshDeliveries?new Date().toISOString():null},catalogRecords,transactionRecords:recentTxRecords,locationConfigs:safeConfigs,locationIds};
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const payload = await req.json().catch(() => ({}));
    return Response.json(await handleGetCodData(base44, payload));
  } catch(error){const status=error?.status||500;return Response.json({error:error?.message||'Internal Server Error'},{status});}
});
