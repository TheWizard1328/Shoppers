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
const SQUARE_REQUEST_SPACING_MS = 100;
const SQUARE_BATCH_PAUSE_MS = 400;
const SQUARE_BATCH_SIZE = 8;
const DELIVERY_BULK_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const MAX_TRANSACTION_ORDERS = 2000;
const BASE44_SYNC_CHUNK_DELAY_MS = 0; // Eliminated artificial delay — was 300ms per chunk
const isValidEntityId = (v) => /^[a-f0-9]{24}$/i.test(String(v || ''));
const isOfflineCollectedPaymentMethod = (m) => ['cash', 'check', 'other'].includes(String(m || '').toLowerCase());
const shouldIgnoreManualOrderLabel = (v) => ['top ups','top up','topup','tip','top'].includes(String(v||'').replace(/\s+/g,' ').trim().toLowerCase());
const formatLocalDate = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const unwrapEntityRecord = (r) => { if (!r || typeof r !== 'object') return null; if (r.data && typeof r.data === 'object') return { ...r.data, id: r.data.id || r.id, created_date: r.data.created_date || r.created_date, updated_date: r.data.updated_date || r.updated_date }; return r; };
const requireAdminIfAuthenticated = async (b44) => { const ok = await b44.auth.isAuthenticated().catch(() => false); if (!ok) return null; const u = await b44.auth.me().catch(() => null); if (u?.role !== 'admin') throw new HttpError(403, 'Forbidden: Admin access required'); return u; };
const hasCollectedCardPayment = (d) => (Array.isArray(d?.cod_payments)?d.cod_payments:[]).some((p)=>['Debit','Credit'].includes(p?.type)&&Number(p?.amount||0)>0);
const hasCollectedOfflinePayment = (d) => (Array.isArray(d?.cod_payments)?d.cod_payments:[]).some((p)=>isOfflineCollectedPaymentMethod(p?.type)&&Number(p?.amount||0)>0);
const shouldRefreshDeliveries = (at, force=false) => { if (force) return true; const ms = new Date(at||0).getTime(); return !Number.isFinite(ms)||ms<=0||Date.now()-ms>=DELIVERY_BULK_REFRESH_INTERVAL_MS; };
const getTransactionRetentionStartMs = () => { const t = new Date(); t.setHours(0,0,0,0); t.setDate(t.getDate()-TRANSACTION_RETENTION_DAYS); return t.getTime(); };
const buildItemSignature = (n, c) => `${normalizeText(n)}::${toAmountCents(c)}`;
const normalizeMatchName = (v) => normalizeText(v).replace(/\s+/g,' ').replace(/\s-\s\$\d+(?:\.\d{2})?$/,'').replace(/^(\d{2})-(\d{2})/,'$1/$2').toLowerCase();
const buildComparableLocationSignature = (n, c, lid) => `${normalizeText(lid)}::${normalizeMatchName(n)}::${toAmountCents(c)}`;
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
async function paginatedDeleteAll(entityApi, pageSize=200) {
  while(true){const records=await entityApi.list('-updated_date',pageSize).catch(()=>[]);if(!records?.length)break;await Promise.all(records.map((r)=>entityApi.delete(r.id).catch(()=>null)));if(records.length<pageSize)break;}
}
const getLookbackStartAt = (days) => new Date(Date.now() - days * 86400000).toISOString();
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

async function handleSyncCatalogItems(base44, payload={}) {
  const accessToken=ensureSquareToken();
  const daysBack=Math.max(1,Number(payload?.daysBack||TRANSACTION_RETENTION_DAYS)||TRANSACTION_RETENTION_DAYS);
  const lookbackStartStr=formatLocalDate(new Date(Date.now()-daysBack*86400000));
  const todayStr=formatLocalDate(new Date());

  // Fetch existing first — we'll do a smart diff instead of nuke-and-rebuild
  const[deliveries,stores,squareConfigs,squareTransactions,existingCatalogDb]=await Promise.all([base44.asServiceRole.entities.Delivery.filter({delivery_date:{$gte:lookbackStartStr,$lte:todayStr}},'-updated_date',5000),base44.asServiceRole.entities.Store.list('-updated_date',200),base44.asServiceRole.entities.SquareLocationConfig.list('-updated_date',200),base44.asServiceRole.entities.SquareTransaction.list('-updated_date',5000),base44.asServiceRole.entities.SquareCatalogItems.list('-updated_date',5000).catch(()=>[])]);
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
  const paidOrderItemSignatures=new Set();const paidOrderItemsByDLA=new Map();
  // paidOrderComparableSignatures intentionally removed — strips date, causes cross-date false matches.
  for(const item of paidOrderItems){
    const sig=buildLocationDateAmountSignature(item.location_id,item.item_name,item.amount_cents);
    paidOrderItemSignatures.add(buildItemSignature(item.item_name,item.amount_cents));
    if(!paidOrderItemsByDLA.has(sig))paidOrderItemsByDLA.set(sig,[]);
    paidOrderItemsByDLA.get(sig).push(item);
  }
  const txByDeliveryId=new Map();const settledCatIds=new Set();const settledItemSigs=new Set();const settledComparableSigs=new Set();const settledDLASigs=new Set();
  // Helper: transaction date must be on or after the item date AND within the strict window.
  // This prevents a June 4th transaction for "06/02-Angela Dottor" from marking a new
  // "06/30-Angela Dottor" catalog item as settled (settledItemSigs strips the date prefix,
  // so name+amount alone would falsely match if we don't guard by date here).
  const txOnOrAfterAndClose=(txD,itemD)=>{if(!txD||!itemD)return true;const diffMs=new Date(txD+'T00:00:00').getTime()-new Date(itemD+'T00:00:00').getTime();return diffMs>=0&&diffMs<=MATCH_DATE_STRICT_DAYS*86400000;};
  for(const t of recentSquareTx){const ac=t?.amount_cents??Math.round(Number(t?.amount||0)*100);if(t?.delivery_id){if(!txByDeliveryId.has(t.delivery_id))txByDeliveryId.set(t.delivery_id,[]);txByDeliveryId.get(t.delivery_id).push(t);}if(t?.status&&t.status!=='pending'){const txDateIso=(t?.raw_square_data?.payment_date||t?.created_date||'').slice(0,10);const itemDateIso=toIsoDate(t?.item_name);const dateOk=txOnOrAfterAndClose(txDateIso,itemDateIso);
  // Only add name/comparable/DLA signatures when the date guard passes.
  // settledCatIds is keyed by Square object ID (exact match) so it's always safe to add.
  if(t?.square_catalog_object_id)settledCatIds.add(t.square_catalog_object_id);
  if(dateOk){settledItemSigs.add(buildItemSignature(t?.item_name,ac));settledComparableSigs.add(buildComparableLocationSignature(t?.item_name,ac,t?.location_id));for(const sig of buildLocationDateAmountSignatureCandidates(t?.location_id,t?.item_name,ac))settledDLASigs.add(sig);}}}
  const itemsToDelete=[];const txToCancel=[];const txToComplete=[];const deliveriesToSync=[];const matchedCatIds=new Set();const matchedDLASigs=new Set();
  for(const item of recentCatalogItems){const n=normalizeText(item?.item_data?.name);if(!n)continue;const ac=getCatalogItemAmountCents(item);const isig=buildItemSignature(n,ac);const lids=getCatalogItemLocationIds(item);const varIds=(item?.item_data?.variations||[]).map((v)=>v?.id).filter(Boolean);const dateSigs=lids.map((l)=>buildLocationDateAmountSignature(l,n,ac));
  // PRIMARY RULE: structured COD names (MM/DD(STORE)-Patient) must match EXACTLY.
  // No fuzzy/DLA/signature fallbacks — the full string including date is the key.
  // Non-structured items fall back to catalog object ID or DLA signature matching.
  const catalogIsStructured=isStructuredCodName(n);
  const byPaidExactId=paidCatalogObjectIds.has(item.id)||varIds.some((v)=>paidCatalogObjectIds.has(v));
  const byPaidStructured=catalogIsStructured&&paidOrderItems.some((pi)=>structuredCodNamesMatch(pi.item_name,n,null)===true);
  const byPaidFallback=!catalogIsStructured&&(byPaidExactId||paidOrderItemSignatures.has(isig)||dateSigs.some((s)=>paidOrderItemsByDLA.has(s)));
  const byPaid=byPaidExactId||(catalogIsStructured?byPaidStructured:byPaidFallback);
  // Settled tx match: structured names require exact string equality; non-structured use signatures.
  const bySettledExact=settledCatIds.has(item.id)||varIds.some((v)=>settledCatIds.has(v));
  const bySettledSig=catalogIsStructured
    ?recentSquareTx.some((t)=>{if(!t?.status||t.status==='pending')return false;return structuredCodNamesMatch(t?.item_name,n,null)===true;})
    :settledItemSigs.has(isig)||dateSigs.some((s)=>settledDLASigs.has(s));
  const bySettled=bySettledExact||bySettledSig;
  if(byPaid||bySettled){matchedCatIds.add(item.id);dateSigs.forEach((s)=>matchedDLASigs.add(s));itemsToDelete.push(item.id);}}
  for(const t of recentSquareTx){if(t?.status!=='pending')continue;const cs=buildLocationDateAmountSignatureCandidates(t?.location_id,deliveryById.get(t?.delivery_id)?.delivery_date||t?.item_name,t?.amount_cents??Math.round(Number(t?.amount||0)*100));if(matchedCatIds.has(t?.square_catalog_object_id)||cs.some((s)=>matchedDLASigs.has(s)))txToComplete.push(t.id);}
  for(const delivery of allCodDeliveries){const store=storeById.get(delivery.store_id);const ac=activeConfigById.get(store?.square_location_config_id);
  // Use pre-loaded patient maps — no async lookup needed
  const rp=patientById.get(delivery.patient_id)||patientByPid.get(normalizeText(delivery.patient_id))||null;
  const rpn=normalizeText(rp?.full_name||delivery?.patient_name)||'Unknown Patient';const itemName=formatItemName(delivery.delivery_date,store?.abbreviation,rpn);const amountCents=Math.round(Number(delivery.cod_total_amount_required||0)*100);const sig=buildItemSignature(itemName,amountCents);const dSigs=buildLocationDateAmountSignatureCandidates(ac?.square_location_id,delivery.delivery_date,amountCents);let catalogItem=catalogBySignature.get(sig)||dSigs.map((s)=>catalogByDateLocationAmount.get(s)).find(Boolean)||null;const exTx=txByDeliveryId.get(delivery.id)||[];const settledTx=exTx.filter((t)=>t?.status&&t.status!=='pending');const phNames=new Set(buildPlaceholderItemNames(delivery.delivery_date,store?.abbreviation));if(rpn!=='Unknown Patient'&&ac?.square_location_id)for(const pi of recentCatalogItems){const pn=normalizeText(pi?.item_data?.name);if(!phNames.has(pn))continue;if(getCatalogItemAmountCents(pi)!==amountCents)continue;if(isCatalogItemAtLocation(pi,ac.square_location_id))itemsToDelete.push(pi.id);}
  const exPending=exTx.find((t)=>t.status==='pending');if(exPending?.square_catalog_object_id&&(exPending.item_name!==itemName||toAmountCents(exPending.amount_cents)!==amountCents)){itemsToDelete.push(exPending.square_catalog_object_id);if(catalogItem?.id===exPending.square_catalog_object_id)catalogItem=null;}
  const hasCard=hasCollectedCardPayment(delivery);const hasOffline=hasCollectedOfflinePayment(delivery);
  // PRIMARY RULE: structured COD name — only match if paid/settled tx item name matches exactly (same date+store+patient).
  const hasSquarePaid=settledTx.length>0||
    paidOrderItems.some((pi)=>structuredCodNamesMatch(pi.item_name,itemName,(pi.payment_date||pi.order_created_at||'').slice(0,10))===true)||
    recentSquareTx.some((t)=>{if(!t?.status||t.status==='pending')return false;const txDateIso=(t?.raw_square_data?.payment_date||t?.created_date||'').slice(0,10);return structuredCodNamesMatch(t?.item_name,itemName,txDateIso)===true;})||
    paidCatalogObjectIds.has(exTx[0]?.square_catalog_object_id||'');
  const delForInvalid=!ac||!store?.square_location_config_id||!ac?.square_location_id||delivery?.status==='failed';const shouldDel=delForInvalid||hasSquarePaid;
  if(catalogItem&&!isCatalogItemAtLocation(catalogItem,ac?.square_location_id)){itemsToDelete.push(catalogItem.id);catalogItem=null;}
  if(shouldDel){if(catalogItem?.id)itemsToDelete.push(catalogItem.id);for(const t of exTx){if(t.status!=='pending')continue;if(delForInvalid)txToCancel.push(t.id);else if(hasSquarePaid)txToComplete.push(t.id);}continue;}
  deliveriesToSync.push({delivery,itemName,patientName:rpn,patientId:rp?.id||(isValidEntityId(delivery.patient_id)?delivery.patient_id:null),amountCents,locationId:ac.square_location_id,existingCatalogItem:catalogItem});}
  const uniqueDel=Array.from(new Set(itemsToDelete.filter(Boolean)));const deleteResult=uniqueDel.length?await deleteCatalogObjects(uniqueDel,accessToken):{deleted:[],failed:[]};
  for(const tid of Array.from(new Set(txToCancel.filter(Boolean))))await base44.asServiceRole.entities.SquareTransaction.update(tid,{status:'cancelled'});
  for(const tid of Array.from(new Set(txToComplete.filter(Boolean))))await base44.asServiceRole.entities.SquareTransaction.update(tid,{status:'completed'});
  let createdCount=0;let updatedCount=0;
  for(const entry of deliveriesToSync){const{delivery,itemName,patientName,patientId,amountCents,locationId,existingCatalogItem}=entry;const sig=buildItemSignature(itemName,amountCents);let ci=existingCatalogItem||catalogBySignature.get(sig)||null;if(!ci?.id){ci=await createCatalogItem({itemName,amountCents,locationId,deliveryId:delivery.id,patientName,accessToken});if(!ci?.id)throw new Error(`Square did not return a catalog item for delivery ${delivery.id}`);catalogBySignature.set(sig,ci);catalogByDateLocationAmount.set(buildLocationDateAmountSignature(locationId,delivery.delivery_date,amountCents),ci);createdCount++;}const exPending=(txByDeliveryId.get(delivery.id)||[]).find((t)=>t.status==='pending');const txPayload={item_name:itemName,amount:Number(delivery.cod_total_amount_required||0),amount_cents:amountCents,type:'collection',status:'pending',delivery_id:delivery.id,patient_id:patientId,store_id:delivery.store_id,location_id:locationId,driver_id:delivery.driver_id||null,dispatcher_id:delivery.dispatcher_id||null,square_catalog_object_id:ci.id,square_catalog_version:ci.version||null};if(exPending){await base44.asServiceRole.entities.SquareTransaction.update(exPending.id,txPayload);updatedCount++;}else await base44.asServiceRole.entities.SquareTransaction.create(txPayload);}
  // Post-sync cleanup: remove Square catalog items for transactions that are already completed/settled.
  // CRITICAL: only delete the catalog item if the SquareTransaction's item_name structurally matches
  // a non-pending tx — never use just catalog_object_id because the same object_id may be reused
  // across different delivery dates for the same patient+amount, causing false deletions.
  const allTxAfter=await base44.asServiceRole.entities.SquareTransaction.list('-updated_date',2000);
  const toRemove=(allTxAfter||[]).filter((t)=>{
    if(!t?.square_catalog_object_id||!t?.status||t.status==='pending')return false;
    // Only sweep catalog items where the settled tx name EXACTLY matches the live catalog item name
    const liveItem=recentCatalogItems.find((ci)=>ci?.id===t.square_catalog_object_id);
    if(!liveItem)return false; // catalog item already gone — nothing to delete
    const liveName=normalizeText(liveItem?.item_data?.name);
    const txName=normalizeText(t?.item_name);
    if(isStructuredCodName(liveName)&&isStructuredCodName(txName)){
      const txDateIso=(t?.raw_square_data?.payment_date||t?.created_date||'').slice(0,10);
      return structuredCodNamesMatch(txName,liveName,txDateIso)===true;
    }
    return liveName===txName; // non-structured: require exact normalized text match
  });
  const extraIds=Array.from(new Set(toRemove.map((t)=>t.square_catalog_object_id).filter(Boolean))).filter((id)=>!deleteResult.deleted.includes(id));const extraDel=extraIds.length?await deleteCatalogObjects(extraIds,accessToken):{deleted:[],failed:[]};
  const stale=(allTxAfter||[]).filter((t)=>{const tm=new Date(t?.created_date||t?.updated_date||0).getTime();return Number.isFinite(tm)&&tm<txRetentionMs;});for(const t of stale)await base44.asServiceRole.entities.SquareTransaction.delete(t.id);
  return{success:true,scanned_deliveries:allCodDeliveries.length,catalog_items_seen:recentCatalogItems.length,paid_order_items_seen:paidOrderItems.length,deleted_catalog_items:deleteResult.deleted.length+extraDel.deleted.length,cancelled_transactions:Array.from(new Set(txToCancel.filter(Boolean))).length,completed_transactions:Array.from(new Set(txToComplete.filter(Boolean))).length,created_catalog_items:createdCount,updated_pending_transactions:updatedCount,pruned_transactions:stale.length,synced_square_catalog_items:0};
}

// Wipes the entire SquareCatalogItems DB then repopulates it fresh from the live Square catalog.
// Returns the full list of inserted records so the caller can sync them to the offline DB too.
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const payload = await req.json().catch(() => ({}));
    await requireAdminIfAuthenticated(base44);
    return Response.json(await handleSyncCatalogItems(base44, payload));
  } catch(error){const status=error?.status||500;return Response.json({error:error?.message||'Internal Server Error'},{status});}
});
