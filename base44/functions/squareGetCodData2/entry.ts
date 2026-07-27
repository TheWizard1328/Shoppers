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
const DELIVERY_BULK_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const formatLocalDate = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const unwrapEntityRecord = (r) => { if (!r || typeof r !== 'object') return null; if (r.data && typeof r.data === 'object') return { ...r.data, id: r.data.id || r.id }; return r; };
const shouldRefreshDeliveries = (at, force=false) => { if (force) return true; const ms = new Date(at||0).getTime(); return !Number.isFinite(ms)||ms<=0||Date.now()-ms>=DELIVERY_BULK_REFRESH_INTERVAL_MS; };
const getCatalogItemLocationIds = (item) => Array.from(new Set([...(item?.present_at_location_ids||[]),...(item?.item_data?.variations||[]).flatMap((v)=>v?.present_at_location_ids||[])].filter(Boolean)));
const getCatalogItemAmountCents = (item) => { const vs=item?.item_data?.variations||[]; const v=vs.find((e)=>e?.item_variation_data?.price_money?.amount!=null)||vs[0]; return toAmountCents(v?.item_variation_data?.price_money?.amount); };
const buildItemSignature = (n, c) => `${normalizeText(n)}::${toAmountCents(c)}`;
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

async function handleGetCodData(base44, payload={}) {
  const accessToken=ensureSquareToken();
  const daysBack=Math.max(1,Number(payload?.daysBack||TRANSACTION_RETENTION_DAYS)||TRANSACTION_RETENTION_DAYS);
  const refreshDeliveries=shouldRefreshDeliveries(payload?.lastDeliverySyncAt,payload?.forceDeliveryRefresh===true);

  // Delegate transaction fetching to squareFetchPmts
  const pmtsResult=await base44.functions.invoke('squareFetchPmts',{daysBack}).catch((e)=>{console.error('squareFetchPmts failed:',e?.message);return{success:false,error:e?.message,transactions:[],soldItems:[],soldCatalogItems:[]};});
  const recentTxRecords=pmtsResult?.transactions||pmtsResult?.soldItems||[];

  // Fetch catalog items and store context
  const[allLocationConfigs,stores,existingTransactionsRaw]=await Promise.all([
    base44.asServiceRole.entities.SquareLocationConfig.list('-updated_date',500).catch(()=>[]),
    base44.asServiceRole.entities.Store.list('-updated_date',500).catch(()=>[]),
    base44.asServiceRole.entities.SquareTransaction.list('-updated_date',5000).catch(()=>[])
  ]);
  const existingTransactions=(Array.isArray(existingTransactionsRaw)?existingTransactionsRaw:[]).map(unwrapEntityRecord).filter(Boolean);
  const safeAllConfigs=(Array.isArray(allLocationConfigs)?allLocationConfigs:[]).map(unwrapEntityRecord).filter(Boolean);
  const safeConfigs=safeAllConfigs.filter((c)=>c?.status==='active');
  const safeStores=(Array.isArray(stores)?stores:[]).map(unwrapEntityRecord).filter(Boolean);
  const activeConfigById=new Map(safeConfigs.map((c)=>[c.id,c]));
  const storesByLocationIdGCD=buildStoresByLocationId(safeStores,activeConfigById);
  const locationIds=Array.from(new Set(safeAllConfigs.map((c)=>c?.square_location_id).filter(Boolean)));

  // Fetch live catalog
  const liveCatalogItems=await listActiveCatalogItems(accessToken).catch(()=>[]);

  // Build catalog records
  const catalogRecords=(liveCatalogItems||[]).reduce((acc,item)=>{
    const ac=getCatalogItemAmountCents(item);const itemName=item?.item_data?.name||'';
    const lids=getCatalogItemLocationIds(item);if(!lids.length)return acc;
    const mt=(existingTransactions||[]).find((t)=>normalizeText(t.square_catalog_object_id)===normalizeText(item?.id)||buildItemSignature(t?.item_name,t?.amount_cents??Math.round(Number(t?.amount||0)*100))===buildItemSignature(itemName,ac));
    const rl=mt?.location_id&&lids.includes(mt.location_id)?mt.location_id:lids.find((l)=>storesByLocationIdGCD.has(l))||lids[0];
    const store=resolveStoreForItem(itemName,rl,storesByLocationIdGCD);
    acc.push({id:item?.id,square_catalog_object_id:item?.id,square_catalog_version:item?.version||null,item_name:itemName,description:item?.item_data?.description||'',amount:ac/100,amount_cents:ac,delivery_id:mt?.delivery_id||null,delivery_date:toIsoDate(itemName),patient_id:mt?.patient_id||null,store_id:mt?.store_id||store?.id||null,location_id:rl,status:'active'});
    return acc;
  },[]);

  // Fetch deliveries if refresh needed
  const endDate=new Date();const startDate=new Date();startDate.setDate(startDate.getDate()-daysBack);
  const startDateStr=formatLocalDate(startDate);const endDateStr=formatLocalDate(endDate);
  let safeDeliveries=[];
  if(refreshDeliveries){
    const storeSquareEligibility=new Map();
    for(const store of safeStores){const c=activeConfigById.get(store?.square_location_config_id);if(!c?.square_location_id)continue;const fh=Array.isArray(store.app_fee_history)?store.app_fee_history:[];const ae=fh.filter((e)=>e?.pays_app_fees===true&&e?.effective_date).sort((a,b)=>String(a.effective_date).localeCompare(String(b.effective_date)));storeSquareEligibility.set(store.id,ae.length>0?ae[0].effective_date:null);}
    const rawDeliveries=await base44.asServiceRole.entities.Delivery.filter({delivery_date:{$gte:startDateStr,$lte:endDateStr}},'-updated_date',5000).catch(()=>[]);
    const all=(Array.isArray(rawDeliveries)?rawDeliveries:[]).map(unwrapEntityRecord).filter(Boolean);
    safeDeliveries=all.filter((d)=>{if(!storeSquareEligibility.has(d?.store_id))return false;const ef=storeSquareEligibility.get(d.store_id);return!(ef&&d.delivery_date<ef);});
  }
  const strippedDeliveries=safeDeliveries.map((d)=>({id:d?.id,delivery_id:d?.delivery_id,delivery_date:d?.delivery_date,status:d?.status,cod_total_amount_required:d?.cod_total_amount_required,cod_payments:d?.cod_payments,store_id:d?.store_id,patient_id:d?.patient_id,driver_id:d?.driver_id,driver_name:d?.driver_name}));

  return{success:true,deliveries:strippedDeliveries,shouldRefreshDeliveries:refreshDeliveries,deliverySyncWindow:{startDate:startDateStr,endDate:endDateStr,daysBack,refreshedAt:refreshDeliveries?new Date().toISOString():null},catalogRecords,transactionRecords:recentTxRecords,locationConfigs:safeConfigs,locationIds};
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const payload = await req.json().catch(() => ({}));
    return Response.json(await handleGetCodData(base44, payload));
  } catch(error){const status=error?.status||500;return Response.json({error:error?.message||'Internal Server Error'},{status});}
});