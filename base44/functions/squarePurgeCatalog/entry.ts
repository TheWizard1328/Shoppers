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

const requireAdminIfAuthenticated = async (b44) => { const ok = await b44.auth.isAuthenticated().catch(() => false); if (!ok) return null; const u = await b44.auth.me().catch(() => null); if (u?.role !== 'admin') throw new HttpError(403, 'Forbidden: Admin access required'); return u; };
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
async function paginatedDeleteAll(entityApi, pageSize=200) {
  while(true){const records=await entityApi.list('-updated_date',pageSize).catch(()=>[]);if(!records?.length)break;await Promise.all(records.map((r)=>entityApi.delete(r.id).catch(()=>null)));if(records.length<pageSize)break;}
}
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
const toIsoDate = (v) => { const p=parseDateValue(v); return (p&&!Number.isNaN(p.getTime()))?p.toISOString().slice(0,10):null; };
const unwrapEntityRecord = (r) => { if (!r || typeof r !== 'object') return null; if (r.data && typeof r.data === 'object') return { ...r.data, id: r.data.id || r.id, created_date: r.data.created_date || r.created_date, updated_date: r.data.updated_date || r.updated_date }; return r; };
const getCatalogItemAmountCents = (item) => { const vs=item?.item_data?.variations||[]; const v=vs.find((e)=>e?.item_variation_data?.price_money?.amount!=null)||vs[0]; return toAmountCents(v?.item_variation_data?.price_money?.amount); };
const getCatalogItemLocationIds = (item) => Array.from(new Set([...(item?.present_at_location_ids||[]),...(item?.item_data?.variations||[]).flatMap((v)=>v?.present_at_location_ids||[])].filter(Boolean)));
function extractItemNameAbbr(itemName) { const m = String(itemName||'').match(/\(([^)]+)\)/); return m ? normalizeText(m[1]).toUpperCase() : ''; }
function getStoreAbbreviationVariants(store) {
  const vs=new Set();const push=(v)=>{const n=normalizeText(v);if(!n)return;vs.add(n.toLowerCase());n.split(/[^a-zA-Z0-9]+/).map((p)=>p.trim().toLowerCase()).filter(Boolean).forEach((p)=>vs.add(p));};
  push(store?.abbreviation);push(store?.name);return Array.from(vs);
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

async function handlePurgeAndRebuildCatalog(base44) {
  const accessToken = ensureSquareToken();
  const [allLocationConfigs, stores] = await Promise.all([
    base44.asServiceRole.entities.SquareLocationConfig.list('-updated_date', 500).catch(() => []),
    base44.asServiceRole.entities.Store.list('-updated_date', 500).catch(() => []),
  ]);
  const safeConfigs = (Array.isArray(allLocationConfigs) ? allLocationConfigs : []).map(unwrapEntityRecord).filter(Boolean);
  const safeStores = (Array.isArray(stores) ? stores : []).map(unwrapEntityRecord).filter(Boolean);
  const activeConfigById = new Map(safeConfigs.filter((c) => c?.status === 'active').map((c) => [c.id, c]));
  const storesByLocationId = buildStoresByLocationId(safeStores, activeConfigById);

  // Step 1: Fetch existing DB records and live catalog in parallel
  const [liveCatalogItems, existingCatalogDb] = await Promise.all([
    listActiveCatalogItems(accessToken),
    base44.asServiceRole.entities.SquareCatalogItems.list('-updated_date', 2000).catch(() => []),
  ]);

  // Step 2: Build canonical records from live Square data
  const liveRecords = (liveCatalogItems || []).reduce((acc, item) => {
    const ac = getCatalogItemAmountCents(item);
    const itemName = item?.item_data?.name || '';
    if (!itemName) return acc;
    const lids = getCatalogItemLocationIds(item);
    if (!lids.length) return acc;
    const rl = lids.find((l) => storesByLocationId.has(l)) || lids[0];
    const store = resolveStoreForItem(itemName, rl, storesByLocationId);
    acc.push({
      square_catalog_object_id: item.id,
      square_catalog_version: item.version || null,
      item_name: itemName,
      description: item?.item_data?.description || '',
      amount: ac / 100,
      amount_cents: ac,
      delivery_id: null,
      delivery_date: toIsoDate(itemName),
      patient_id: null,
      store_id: store?.id || null,
      location_id: rl,
      status: 'active',
    });
    return acc;
  }, []);

  // Smart upsert: diff live records against existing DB records, only delete stale, upsert changed
  const existingByObjId=new Map();
  for(const r of (existingCatalogDb||[])){const oid=r?.square_catalog_object_id||r?.data?.square_catalog_object_id;if(oid)existingByObjId.set(oid,r);}
  const liveObjIds=new Set(liveRecords.map((r)=>r.square_catalog_object_id));
  // Delete stale records (in DB but not in live Square catalog) in parallel
  const staleIds=(existingCatalogDb||[]).filter((r)=>{const oid=r?.square_catalog_object_id||r?.data?.square_catalog_object_id;return oid&&!liveObjIds.has(oid);}).map((r)=>r.id).filter(Boolean);
  if(staleIds.length>0){await Promise.all(staleIds.map((id)=>base44.asServiceRole.entities.SquareCatalogItems.delete(id).catch(()=>null)));}
  // Upsert live records in parallel batches (no artificial delays)
  const insertedRecords=[];
  const upsertCs=50;
  for(let i=0;i<liveRecords.length;i+=upsertCs){const chunk=liveRecords.slice(i,i+upsertCs);const results=await Promise.all(chunk.map((r)=>{const existing=existingByObjId.get(r.square_catalog_object_id);if(existing?.id){return base44.asServiceRole.entities.SquareCatalogItems.update(existing.id,r).catch(()=>null);}return base44.asServiceRole.entities.SquareCatalogItems.create(r).catch(()=>null);}));insertedRecords.push(...results.filter(Boolean));}

  return {
    success: true,
    live_catalog_count: liveRecords.length,
    inserted: insertedRecords.length,
    // Return the records so the frontend can replace the offline DB too
    catalogRecords: liveRecords,
  };
}

// Fetches the live Square catalog and replaces SquareCatalogItems DB to exactly mirror it.
// Any DB records not present in the live Square catalog are purged.
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    await requireAdminIfAuthenticated(base44);
    return Response.json(await handlePurgeAndRebuildCatalog(base44));
  } catch(error){const status=error?.status||500;return Response.json({error:error?.message||'Internal Server Error'},{status});}
});
