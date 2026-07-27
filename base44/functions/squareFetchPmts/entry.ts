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
const MATCH_DATE_STRICT_DAYS = 7; // max days between transaction date and catalog item date for a "collected" match
const MAX_TRANSACTION_ORDERS = 2000;
const shouldIgnoreManualOrderLabel = (v) => ['top ups','top up','topup','tip','top'].includes(String(v||'').replace(/\s+/g,' ').trim().toLowerCase());
const formatLocalDate = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const getTransactionRetentionStartMs = () => { const t = new Date(); t.setHours(0,0,0,0); t.setDate(t.getDate()-TRANSACTION_RETENTION_DAYS); return t.getTime(); };
const normalizeMatchName = (v) => normalizeText(v).replace(/\s+/g,' ').replace(/\s-\s\$\d+(?:\.\d{2})?$/,'').replace(/^(\d{2})-(\d{2})/,'$1/$2').toLowerCase();
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
  // Transaction date must be ON OR AFTER the delivery date — a payment can't precede the delivery.
  // If payIso is unknown, allow the match (we can't rule it out).
  const txIsOnOrAfterDelivery=(payIso,deliveryDate)=>{if(!payIso||!deliveryDate)return true;return payIso>=deliveryDate;};
  // Sort candidates by date proximity to the transaction payment date (ascending = closest first)
  const sortByDateProximity=(candidates,payIso)=>{if(!payIso||candidates.length<=1)return candidates;const payMs=new Date(payIso+'T00:00:00').getTime();if(!Number.isFinite(payMs))return candidates;return [...candidates].sort((a,b)=>{const da=Math.abs(new Date((a.delivery_date||'')+'T00:00:00').getTime()-payMs);const db=Math.abs(new Date((b.delivery_date||'')+'T00:00:00').getTime()-payMs);return da-db;});};
  const getDeliveryCandidatesForItem=(item,resolvedStore)=>{const payIso=(item?.payment_date||item?.order_created_at||'').slice(0,10);const combined=`${normalizeText(item?.note||'')} ${normalizeText(item?.item_name||'')}`.trim();const locationStores=storesByLocationId.get(item?.location_id)||[];const raw=deliveriesWithAmounts.filter((d)=>{const storeMatch=locationStores.some((s)=>s?.id===d?.store_id);if(!storeMatch)return false;const matchingStore=locationStores.find((s)=>s?.id===d?.store_id)||resolvedStore;if(matchingStore&&!itemNameContainsStore(item?.item_name,matchingStore)&&!itemNameContainsStore(item?.note,matchingStore)){const anyStoreMatch=locationStores.some((s)=>itemNameContainsStore(item?.item_name,s)||itemNameContainsStore(item?.note,s));if(!anyStoreMatch)return false;}const da=Math.round(Number(d?.cod_total_amount_required||0)*100);if(da!==toAmountCents(item?.amount_cents))return false;// Hard rule: transaction date must be on or after the delivery date
  if(!txIsOnOrAfterDelivery(payIso,d?.delivery_date))return false;const pt=patientsById.get(d?.patient_id);return pt&&notesContainPatientName(combined,pt.full_name);});return sortByDateProximity(raw,payIso);};
  const matchDeliveryForItem=(item,resolvedStore)=>{const note=normalizeText(item?.note||'');const payIso=(item?.payment_date||item?.order_created_at||'').slice(0,10);const cands=getDeliveryCandidatesForItem(item,resolvedStore);if(!cands.length)return null;const ssc=resolvedStore?.id?cands.filter((d)=>d?.store_id===resolvedStore.id):[];const pri=ssc.length?[...ssc,...cands.filter((d)=>d?.store_id!==resolvedStore?.id)]:cands;const dm=note.match(/delivery\s*(id|#)?\s*[:=-]?\s*([a-f0-9]{24})/i);if(dm){const m=pri.find((d)=>d?.id===dm[2]);if(m)return m;}const sm=note.match(/\b(?:sid|stop\s*id)\s*[:=-]?\s*([a-z0-9-]+)/i);if(sm){const m=pri.find((d)=>normalizeText(d?.stop_id).toLowerCase()===normalizeText(sm[1]).toLowerCase());if(m)return m;}// Prefer candidate whose delivery date is within MATCH_DATE_STRICT_DAYS of the transaction date (txIsOnOrAfterDelivery already enforced in candidates)
  const withinWindow=(d)=>{if(!payIso||!d?.delivery_date)return false;const diffMs=new Date(payIso+'T00:00:00').getTime()-new Date(d.delivery_date+'T00:00:00').getTime();return diffMs>=0&&diffMs<=MATCH_DATE_STRICT_DAYS*86400000;};const closeByNote=pri.find((d)=>withinWindow(d)&&notesContainPatientName(note,patientsById.get(d?.patient_id)?.full_name||''));if(closeByNote)return closeByNote;const closeByName=pri.find((d)=>withinWindow(d)&&notesContainPatientName(item?.item_name,patientsById.get(d?.patient_id)?.full_name||''));if(closeByName)return closeByName;// Fall back to name match (no date window) — still sorted closest-first
  return pri.find((d)=>{const p=patientsById.get(d?.patient_id);return p&&notesContainPatientName(note,p.full_name);})||pri.find((d)=>{const p=patientsById.get(d?.patient_id);return p&&notesContainPatientName(item?.item_name,p.full_name);})||pri[0];};
  const transactionRecords=[];const seenKeys=new Set();
  for(const item of paidOrderItems){const ukey=`${item?.order_id}::${item?.line_item_uid}`;if(seenKeys.has(ukey))continue;seenKeys.add(ukey);const store=resolveStoreForItem(item?.item_name,item?.location_id,storesByLocationId);const md=matchDeliveryForItem(item,store);const mp=md?patientsById.get(md?.patient_id):null;const mdr=md?getDriverFromDelivery(md):null;// Use the matched delivery's actual store for the item name (it's the authoritative store)
  const ms=md?(stores||[]).find((s)=>s?.id===md.store_id)||store:store;const isCustom=!normalizeText(item?.catalog_object_id);const fmtName=md?formatItemName(md.delivery_date,getPreferredStoreAbbreviation(ms),mp?.full_name||md?.patient_name):'';const dn=isCustom&&fmtName?fmtName:(item?.item_name||'');const existing=(existingTransactions||[]).find((t)=>normalizeText(t?.square_transaction_id)===normalizeText(item?.order_id)&&normalizeText(t?.raw_square_data?.line_item_uid)===normalizeText(item?.line_item_uid));const pr={square_transaction_id:item?.order_id||null,square_payment_id:`${item?.order_id||'order'}:${item?.line_item_uid||'line'}`,square_catalog_object_id:item?.catalog_object_id||null,item_name:dn,amount:toAmountCents(item?.amount_cents)/100,amount_cents:toAmountCents(item?.amount_cents),type:'collection',status:item?.transaction_status||'pending',delivery_id:md?.id||null,patient_id:mp?.id||md?.patient_id||null,store_id:md?.store_id||store?.id||null,location_id:item?.location_id||null,driver_id:md?.driver_id||mdr?.id||mdr?.user_id||null,dispatcher_id:md?.created_by_app_user_id||null,payment_method:'card',raw_square_data:{...(existing?.raw_square_data||{}),line_item_uid:item?.line_item_uid||null,payment_date:item?.payment_date||null,order_created_at:item?.order_created_at||null,order_state:item?.order_state||null,notes:item?.note||'',original_item_name:item?.item_name||'',is_custom_amount:isCustom,matched_by:md?'delivery_match':'unmatched'}};
  if(existing){await base44.asServiceRole.entities.SquareTransaction.update(existing.id,pr);transactionRecords.push({id:existing.id,...pr});}else{const c=await base44.asServiceRole.entities.SquareTransaction.create(pr);transactionRecords.push(c);}}
  return{success:true,paused:false,paymentsCount:transactionRecords.length,transactions:transactionRecords,soldItems:transactionRecords,soldCatalogItems:transactionRecords.filter((t)=>t?.square_catalog_object_id),catalogItems:[],catalogItemCount:0,dateRange:{start_at:lookbackStartAt,end_at:new Date().toISOString(),days_back:daysBack}};
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const payload = await req.json().catch(() => ({}));
    await requireUser(base44);
    return Response.json(await handleFetchPayments(base44, payload));
  } catch(error){const status=error?.status||500;return Response.json({error:error?.message||'Internal Server Error'},{status});}
});
