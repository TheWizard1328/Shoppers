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

async function handleMarkCollectedDebit(base44, payload) {
  const{deliveryId,transactionId,catalogObjectId,note}=payload||{};
  if(!deliveryId)throw new HttpError(400,'Missing required field: deliveryId');
  const delivery=await base44.asServiceRole.entities.Delivery.get(deliveryId).catch(()=>null);
  if(!delivery)throw new HttpError(404,'Delivery not found');
  const updatePayload={cod_payments:[{type:'Debit',amount:Number(delivery.cod_total_amount_required||0)}]};
  // Append the explanation note to delivery_notes in the SAME update — avoids a
  // race condition where the realtime event from the cod_payments change would
  // overwrite a separately-saved delivery_notes with the stale (pre-note) value.
  if(note&&String(note).trim()){
    const existingNotes=String(delivery.delivery_notes||'').trim();
    const ts=new Date().toLocaleString('en-US',{timeZone:'America/Edmonton'});
    const dateStr=new Date().toLocaleDateString('en-US',{timeZone:'America/Edmonton',month:'2-digit',day:'2-digit',year:'numeric'})+' '+new Date().toLocaleTimeString('en-US',{timeZone:'America/Edmonton',hour:'numeric',minute:'2-digit',hour12:true});
    const noteLine=`[COD Collected ${dateStr}]: ${String(note).trim()}`;
    updatePayload.delivery_notes=existingNotes?`${existingNotes}\n${noteLine}`:noteLine;
  }
  const updatedDelivery=await base44.asServiceRole.entities.Delivery.update(deliveryId,updatePayload);
  const deleteResult=await base44.functions.invoke('squareDeleteCodItem', {deliveryId,transactionId,catalogObjectId,reason:'collected_debit'});
  return{success:true,deliveryId,paymentType:'Debit',delivery_notes:updatedDelivery?.delivery_notes,...deleteResult};
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const payload = await req.json().catch(() => ({}));
    await requireUser(base44);
    return Response.json(await handleMarkCollectedDebit(base44, payload));
  } catch(error){const status=error?.status||500;return Response.json({error:error?.message||'Internal Server Error'},{status});}
});