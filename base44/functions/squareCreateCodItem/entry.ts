// Self-contained Square COD item creation — no dependency on squareCodCore
// Updated 2026-07-27 — inlined all helpers to fix deployment gap
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

const SQUARE_BASE_URL = 'https://connect.squareup.com';
const SQUARE_VERSION = '2025-01-23';
const SQUARE_API_MAX_RETRIES = 3;
const SQUARE_RETRY_BASE_DELAY_MS = 400;

class HttpError extends Error { constructor(s, m) { super(m); this.status = s; } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const normalizeText = (v) => String(v || '').trim();
const toAmountCents = (v) => Math.max(0, Math.round(Number(v || 0)));
const isValidEntityId = (v) => /^[a-f0-9]{24}$/i.test(String(v || ''));
const isRetryableSquareStatus = (s) => [408, 409, 429, 500, 502, 503, 504].includes(Number(s));
const ensureSquareToken = () => { const t = Deno.env.get('SQUARE_ACCESS_TOKEN'); if (!t) throw new HttpError(500, 'Square credentials not configured'); return t; };
const requireUser = async (b44) => { const u = await b44.auth.me().catch(() => null); if (!u) throw new HttpError(401, 'Unauthorized'); return u; };

function formatItemName(deliveryDate, storeAbbreviation, patientName) {
  const [,month,day] = String(deliveryDate||'').split('-');
  return `${(month||'00').padStart(2,'0')}/${(day||'00').padStart(2,'0')}(${normalizeText(storeAbbreviation)||'NA'})-${normalizeText(patientName)||'Unknown Patient'}`;
}

async function squareFetch(path, method, accessToken, body) {
  let lastError=null;
  for (let attempt=1;attempt<=SQUARE_API_MAX_RETRIES;attempt++) {
    try {
      const response=await fetch(`${SQUARE_BASE_URL}${path}`,{method,headers:{Authorization:`Bearer ${accessToken}`,'Content-Type':'application/json','Square-Version':SQUARE_VERSION},body:body?JSON.stringify(body):undefined});
      const text=await response.text();const json=text?JSON.parse(text):{};
      if(!response.ok){const msg=json?.errors?.map((e)=>e.detail).join(', ')||`Square API error ${response.status}`;lastError=new HttpError(response.status,msg);if(attempt<SQUARE_API_MAX_RETRIES&&isRetryableSquareStatus(response.status)){await sleep(SQUARE_RETRY_BASE_DELAY_MS*attempt);continue;}throw lastError;}
      return json;
    } catch(error){lastError=error;if(attempt<SQUARE_API_MAX_RETRIES&&isRetryableSquareStatus(error?.status)){await sleep(SQUARE_RETRY_BASE_DELAY_MS*attempt);continue;}throw lastError;}
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
  catch{const deleted=[];const failed=[];for(const id of objectIds){const r=await safeDeleteSquareCatalogObject(id,accessToken);if(r?.ok)deleted.push(id);else failed.push({objectId:id,result:r});}if(failed.length)throw new Error(`Failed to delete: ${failed.map((e)=>e.objectId).join(', ')}`);return{deleted,failed:[]};}
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

async function listActiveCatalogItems(accessToken) {
  const objects=[];let cursor;
  do{const json=await squareFetch('/v2/catalog/search','POST',accessToken,{object_types:['ITEM'],include_deleted_objects:false,archived_state:'ARCHIVED_STATE_NOT_ARCHIVED',limit:1000,cursor});objects.push(...(json.objects||[]));cursor=json.cursor;if(cursor)await sleep(200);}while(cursor);
  return objects;
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
  if(existingPending?.length&&existingPending[0]?.square_catalog_object_id&&existingPending[0]?.item_name===itemName&&existingPending[0]?.amount_cents===amountCents){const tx=existingPending[0];return{success:true,catalogObjectId:tx.square_catalog_object_id,catalogVersion:tx.square_catalog_version,itemName:tx.item_name,transactionId:tx.id,note:'Skipped: existing pending item'};}
  let catalogObjectId,catalogVersion;
  if(existingPending?.length&&existingPending[0]?.square_catalog_object_id&&(existingPending[0]?.item_name!==itemName||existingPending[0]?.amount_cents!==amountCents)){const updated=await updateCatalogItem({catalogObjectId:existingPending[0].square_catalog_object_id,catalogVersion:existingPending[0].square_catalog_version,itemName,amountCents,locationId,deliveryId,patientName:resolvedPatientName,accessToken});catalogObjectId=updated?.id||existingPending[0].square_catalog_object_id;catalogVersion=updated?.version||existingPending[0].square_catalog_version;}
  else{
    const liveItems=await listActiveCatalogItems(accessToken);
    const existingLive=liveItems.find((item)=>{const desc=normalizeText(item?.item_data?.description||'').toLowerCase();return desc.includes(`delivery ${deliveryId}`)||desc.includes(deliveryId);});
    if(existingLive){const updated=await updateCatalogItem({catalogObjectId:existingLive.id,catalogVersion:existingLive.version,itemName,amountCents,locationId,deliveryId,patientName:resolvedPatientName,accessToken});catalogObjectId=updated?.id||existingLive.id;catalogVersion=updated?.version||existingLive.version;}
    else{const ci=await createCatalogItem({itemName,amountCents,locationId,deliveryId,patientName:resolvedPatientName,accessToken});catalogObjectId=ci?.id||null;catalogVersion=ci?.version||null;if(!catalogObjectId)throw new Error(`Square did not return a catalog item for delivery ${deliveryId}`);}
  }
  const existingTx=await base44.asServiceRole.entities.SquareTransaction.filter({delivery_id:deliveryId,status:'pending'}).catch(()=>[]);
  const txPayload={square_catalog_object_id:catalogObjectId,square_catalog_version:catalogVersion,item_name:itemName,amount:Number(codAmount),amount_cents:amountCents,patient_id:resolvedPatientId,store_id:effectiveStoreId,location_id:locationId};
  const transaction=existingTx.length>0?await base44.asServiceRole.entities.SquareTransaction.update(existingTx[0].id,txPayload):await base44.asServiceRole.entities.SquareTransaction.create({...txPayload,type:'collection',status:'pending',delivery_id:deliveryId});
  const existingCatalogItems=await base44.asServiceRole.entities.SquareCatalogItems.filter({delivery_id:deliveryId}).catch(()=>[]);
  const catalogPayload={square_catalog_object_id:catalogObjectId,square_catalog_version:catalogVersion,item_name:itemName,description:'',amount:Number(codAmount||0),amount_cents:amountCents,delivery_id:deliveryId,delivery_date:resolvedDeliveryDate||null,patient_id:resolvedPatientId,store_id:effectiveStoreId||null,location_id:locationId,status:'active'};
  if(existingCatalogItems.length>0)await base44.asServiceRole.entities.SquareCatalogItems.update(existingCatalogItems[0].id,catalogPayload);
  else await base44.asServiceRole.entities.SquareCatalogItems.create(catalogPayload);
  return{success:true,catalogObjectId,catalogVersion,itemName,transactionId:transaction?.id||existingTx[0]?.id};
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    await requireUser(base44);
    const payload = await req.json().catch(() => ({}));
    const result = await handleCreateCodItem(base44, payload);
    return Response.json(result);
  } catch (error) {
    return Response.json({ error: error?.message || 'Internal Server Error' }, { status: error?.status || 500 });
  }
});
