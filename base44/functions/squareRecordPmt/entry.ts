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

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const payload = await req.json().catch(() => ({}));
    return Response.json(await handleRecordPayment(base44, payload));
  } catch(error){const status=error?.status||500;return Response.json({error:error?.message||'Internal Server Error'},{status});}
});
