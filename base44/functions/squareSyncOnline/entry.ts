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
async function paginatedDeleteAll(entityApi, pageSize=200) {
  while(true){const records=await entityApi.list('-updated_date',pageSize).catch(()=>[]);if(!records?.length)break;await Promise.all(records.map((r)=>entityApi.delete(r.id).catch(()=>null)));if(records.length<pageSize)break;}
}

async function handleSyncOnlineSquareEntities(base44, payload) {
  const catalogRecords=Array.isArray(payload?.catalogRecords)?payload.catalogRecords.filter(Boolean):[];
  const transactionRecords=Array.isArray(payload?.transactionRecords)?payload.transactionRecords.filter(Boolean):[];
  const stripMeta=(r)=>{const{id,created_date,updated_date,created_by,created_by_id,is_sample,...rest}=r||{};return rest;};
  const normCatalog=(r)=>{const c=stripMeta(r);if(!c)return null;return{square_catalog_object_id:c.square_catalog_object_id||c.catalog_object_id||null,square_catalog_version:c.square_catalog_version||c.version||null,item_name:c.item_name||c.name||null,description:c.description||'',amount:c.amount??c.price_dollars??(c.price_cents!=null?Number(c.price_cents)/100:null),amount_cents:c.amount_cents??c.price_cents??null,delivery_id:c.delivery_id||null,delivery_date:c.delivery_date||null,patient_id:c.patient_id||null,store_id:c.store_id||null,location_id:c.location_id||null,status:c.status||'active'};};
  const cleanCatalog=catalogRecords.map(normCatalog).filter((r)=>r?.square_catalog_object_id&&r?.item_name&&r?.amount!=null&&r?.location_id);const cleanTx=transactionRecords.map(stripMeta).filter(Boolean);
  const bulkCreate=async(api,records)=>{if(!records.length)return;const cs=50;for(let i=0;i<records.length;i+=cs){await api.bulkCreate(records.slice(i,i+cs));}};
  await Promise.all([paginatedDeleteAll(base44.asServiceRole.entities.SquareCatalogItems,100),paginatedDeleteAll(base44.asServiceRole.entities.SquareTransaction,100)]);
  await Promise.all([cleanCatalog.length>0?bulkCreate(base44.asServiceRole.entities.SquareCatalogItems,cleanCatalog):Promise.resolve(),cleanTx.length>0?bulkCreate(base44.asServiceRole.entities.SquareTransaction,cleanTx):Promise.resolve()]);
  return{success:true,paused:false,catalogCount:cleanCatalog.length,transactionCount:cleanTx.length};
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const payload = await req.json().catch(() => ({}));
    await requireAdminIfAuthenticated(base44);
    return Response.json(await handleSyncOnlineSquareEntities(base44, payload));
  } catch(error){const status=error?.status||500;return Response.json({error:error?.message||'Internal Server Error'},{status});}
});
