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

const normalizeText = (v) => String(v || '').trim();
const toAmountCents = (v) => Math.max(0, Math.round(Number(v || 0)));
const requireAdminIfAuthenticated = async (b44) => { const ok = await b44.auth.isAuthenticated().catch(() => false); if (!ok) return null; const u = await b44.auth.me().catch(() => null); if (u?.role !== 'admin') throw new HttpError(403, 'Forbidden: Admin access required'); return u; };
const getCatalogItemLocationIds = (item) => Array.from(new Set([...(item?.present_at_location_ids||[]),...(item?.item_data?.variations||[]).flatMap((v)=>v?.present_at_location_ids||[])].filter(Boolean)));
const getCatalogItemAmountCents = (item) => { const vs=item?.item_data?.variations||[]; const v=vs.find((e)=>e?.item_variation_data?.price_money?.amount!=null)||vs[0]; return toAmountCents(v?.item_variation_data?.price_money?.amount); };
async function listActiveCatalogItems(accessToken, options={}) {
  const objects=[];let cursor;
  do{const json=await squareFetch('/v2/catalog/search','POST',accessToken,{object_types:['ITEM'],include_deleted_objects:false,archived_state:'ARCHIVED_STATE_NOT_ARCHIVED',limit:1000,cursor},options);objects.push(...(json.objects||[]));cursor=json.cursor;if(cursor)await sleep(200);}while(cursor);
  return objects;
}
async function handleMirrorCatalogFromSquare(base44) {
  const accessToken = ensureSquareToken();
  const [allLocationConfigs, stores] = await Promise.all([
    base44.asServiceRole.entities.SquareLocationConfig.list('-updated_date', 500).catch(() => []),
    base44.asServiceRole.entities.Store.list('-updated_date', 500).catch(() => []),
  ]);
  const safeConfigs = (Array.isArray(allLocationConfigs) ? allLocationConfigs : []).map(unwrapEntityRecord).filter(Boolean);
  const safeStores = (Array.isArray(stores) ? stores : []).map(unwrapEntityRecord).filter(Boolean);
  const activeConfigById = new Map(safeConfigs.filter((c) => c?.status === 'active').map((c) => [c.id, c]));
  const storesByLocationId = buildStoresByLocationId(safeStores, activeConfigById);

  // Fetch live catalog from Square
  const liveCatalogItems = await listActiveCatalogItems(accessToken);

  // Build canonical DB records from live Square data
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

  // Get all existing DB records
  const existingDbRecords = await base44.asServiceRole.entities.SquareCatalogItems.list('-updated_date', 2000).catch(() => []);
  const liveObjectIds = new Set(liveRecords.map((r) => r.square_catalog_object_id));

  // Purge DB records not in live Square catalog
  const toDelete = (existingDbRecords || []).filter((r) => {
    const id = r?.square_catalog_object_id || r?.data?.square_catalog_object_id;
    return id && !liveObjectIds.has(id);
  });
  for (let i = 0; i < toDelete.length; i += 50) {
    const chunk = toDelete.slice(i, i + 50);
    await Promise.all(chunk.map((r) => base44.asServiceRole.entities.SquareCatalogItems.delete(r.id).catch(() => null)));
  }

  // Upsert all live records into DB
  const existingByObjectId = new Map((existingDbRecords || []).map((r) => {
    const id = r?.square_catalog_object_id || r?.data?.square_catalog_object_id;
    return [id, r];
  }));
  let upserted = 0;
  for (const record of liveRecords) {
    const existing = existingByObjectId.get(record.square_catalog_object_id);
    if (existing) {
      await base44.asServiceRole.entities.SquareCatalogItems.update(existing.id, record).catch(() => null);
    } else {
      await base44.asServiceRole.entities.SquareCatalogItems.create(record).catch(() => null);
    }
    upserted++;
  }

  return { success: true, live_catalog_count: liveRecords.length, purged: toDelete.length, upserted };
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    await requireAdminIfAuthenticated(base44);
    return Response.json(await handleMirrorCatalogFromSquare(base44));
  } catch(error){const status=error?.status||500;return Response.json({error:error?.message||'Internal Server Error'},{status});}
});
