// Redeployed on 2026-05-21 - Via Superagent The Boss
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const SQUARE_BASE_URL = 'https://connect.squareup.com';
const SQUARE_VERSION = '2025-01-23';
const TRANSACTION_RETENTION_DAYS = 90;
const MATCH_DATE_STRICT_DAYS = 7; // max days between transaction date and catalog item date for a "collected" match
const SQUARE_API_MAX_RETRIES = 3;
const SQUARE_RETRY_BASE_DELAY_MS = 400;
const MAX_TRANSACTION_ORDERS = 2000;
class HttpError extends Error { constructor(s, m) { super(m); this.status = s; } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const normalizeText = (v) => String(v || '').trim();
const toAmountCents = (v) => Math.max(0, Math.round(Number(v || 0)));
const isRetryableSquareStatus = (s) => [408, 409, 429, 500, 502, 503, 504].includes(Number(s));
const shouldIgnoreManualOrderLabel = (v) => ['top ups','top up','topup','tip','top'].includes(String(v||'').replace(/\s+/g,' ').trim().toLowerCase());
const formatLocalDate = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const ensureSquareToken = () => { const t = Deno.env.get('SQUARE_ACCESS_TOKEN'); if (!t) throw new HttpError(500, 'Square credentials not configured'); return t; };
const requireUser = async (b44) => { const u = await b44.auth.me().catch(() => null); if (!u) throw new HttpError(401, 'Unauthorized'); return u; };
const getTransactionRetentionStartMs = () => { const t = new Date(); t.setHours(0,0,0,0); t.setDate(t.getDate()-TRANSACTION_RETENTION_DAYS); return t.getTime(); };
const normalizeMatchName = (v) => normalizeText(v).replace(/\s+/g,' ').replace(/\s-\s\$\d+(?:\.\d{2})?$/,'').replace(/^(\d{2})-(\d{2})/,'$1/$2').toLowerCase();
// Returns true if a string is in the structured COD format: MM/DD(STORE)-PatientName
const isStructuredCodName = (v) => /^\d{2}[\/-]\d{2}\([^)]+\)-.+/.test(String(v||'').trim());
// For structured names, extract the date portion as YYYY-MM-DD (best-guess year via parseDateValue).
// Returns null if not structured or date can't be parsed.
const getStructuredCodDate = (v) => { if (!isStructuredCodName(v)) return null; return toIsoDate(v); };
// Primary match rule: if BOTH strings are structured COD names, they must be an EXACT
// string match (trim only). The chronology guard uses ONLY the date embedded in the
// item name strings themselves — never the external txDateIso fallback — so that
// "06/02(LD)-Angela Dottor" can never match "06/30(LD)-Angela Dottor" regardless of
// what the Square payment date says.
// Returns true=match, false=no-match, null=not both structured (fall through to other logic).
const toIsoDate = (v) => { const p=parseDateValue(v); return (p&&!Number.isNaN(p.getTime()))?p.toISOString().slice(0,10):null; };
const getPreferredStoreAbbreviation = (store) => { const n=normalizeText(store?.abbreviation); if (n) return n.toUpperCase(); const ts=normalizeText(store?.name).split(/[^a-zA-Z0-9]+/).map((p)=>p.trim()).filter(Boolean); if (!ts.length) return 'NA'; if (ts.length===1) return ts[0].slice(0,2).toUpperCase(); return ts.map((t)=>t[0]).join('').slice(0,2).toUpperCase(); };

// Extract the store abbreviation from an item name like "06/20(KW)-Patient Name"
function extractItemNameAbbr(itemName) { const m = String(itemName||'').match(/\(([^)]+)\)/); return m ? normalizeText(m[1]).toUpperCase() : ''; }

// Build a multi-store map: locationId → [store, store, ...] (preserves all stores sharing a location)
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

// Resolve the best-matching store for a Square order item.
// When multiple stores share a location ID, use the abbreviation in the item name to disambiguate.
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

// Update an existing Square catalog item's name/price in-place via batch-upsert
async function listOrders(locationIds, startAt, accessToken, maxOrders=2000, states=['COMPLETED','OPEN'], options={}) {
  if(!locationIds.length)return[];const orders=[];let cursor=null;
  do{const json=await squareFetch('/v2/orders/search','POST',accessToken,{location_ids:locationIds,cursor,limit:500,query:{filter:{state_filter:{states},date_time_filter:{created_at:{start_at:startAt}}},sort:{sort_field:'CREATED_AT',sort_order:'DESC'}}},options);orders.push(...(json.orders||[]));cursor=json.cursor||null;if(cursor&&orders.length<maxOrders)await sleep(200);}while(cursor&&orders.length<maxOrders);
  return orders.slice(0,maxOrders);
}

// Returns true if a Square order has been fully refunded.
// Square includes net_amounts and return_amounts on orders when refunds exist.
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

// Build a Set of order IDs that are fully refunded, for fast lookup
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

// Peek at the most recent completed Square order for a given locationId.
// Returns { locationId, found: bool, orderCreatedAt } — used by the UI to verify
// that the driver's Bluetooth reader is currently active on the expected location.
async function handlePeekDriverTransaction(base44, payload) {
  const accessToken = ensureSquareToken();
  const { locationId, driverName } = payload || {};
  if (!locationId) throw new HttpError(400, 'locationId is required');

  // Fetch ALL active SquareLocationConfig entities so we can search across every
  // configured location — not just the expected one. This is critical: if we only
  // search the expected location, the result is a tautology (lastLocationId always
  // equals locationId) and we can never detect a mismatch.
  const allConfigs = await base44.asServiceRole.entities.SquareLocationConfig.list('-updated_date', 500).catch(() => []);
  const allLocationIds = [...new Set((allConfigs || []).map((c) => c?.square_location_id).filter(Boolean))];

  // Always include the expected locationId even if not in configs (defensive)
  if (!allLocationIds.includes(locationId)) allLocationIds.push(locationId);

  // Square /v2/orders/search accepts up to 10 location_ids per request.
  // Batch if we have more than 10 (unlikely for RxDeliver, but safe).
  const BATCH_SIZE = 10;
  let allOrders = [];

  for (let i = 0; i < allLocationIds.length; i += BATCH_SIZE) {
    const batchIds = allLocationIds.slice(i, i + BATCH_SIZE);
    const json = await squareFetch('/v2/orders/search', 'POST', accessToken, {
      location_ids: batchIds,
      limit: 50,
      query: {
        filter: { state_filter: { states: ['COMPLETED', 'OPEN'] } },
        sort: { sort_field: 'CREATED_AT', sort_order: 'DESC' },
      },
    });
    if (json?.orders?.length) allOrders = allOrders.concat(json.orders);
  }

  // Sort all collected orders by created_at DESC (since batches may interleave)
  allOrders.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));

  if (!allOrders.length) {
    return { found: false, locationId, lastLocationId: null, orderCreatedAt: null };
  }

  // If no driverName provided, fall back to returning the most recent order (legacy behaviour)
  if (!driverName || !driverName.trim()) {
    const order = allOrders[0];
    return { found: true, locationId, lastLocationId: order.location_id || null, orderCreatedAt: order.created_at || null };
  }

  // Collect unique team member IDs across the fetched orders
  const teamMemberIds = [...new Set(allOrders.map((o) => o.created_by_team_member_id).filter(Boolean))];

  // Fetch all team member profiles in parallel (one request per ID — typically ≤ 5 unique drivers)
  const teamMemberMap = new Map(); // id → "Given Family"
  await Promise.all(teamMemberIds.map(async (tmId) => {
    try {
      const tmJson = await squareFetch(`/v2/team-members/${tmId}`, 'GET', accessToken, null);
      const tm = tmJson?.team_member;
      if (tm) {
        const fullName = [tm.given_name, tm.family_name].filter(Boolean).join(' ');
        teamMemberMap.set(tmId, fullName);
      }
    } catch (_) { /* skip unresolvable IDs */ }
  }));

  // Fuzzy name match: normalize both sides, check if given name or significant family name token
  // appears in the driver's app username (or vice versa). With a small distinct crew this is unambiguous.
  const normStr = (v) => String(v || '').toLowerCase().trim().replace(/\s+/g, ' ');
  const nameMatchesDriver = (squareName) => {
    if (!squareName) return false;
    const sq = normStr(squareName);
    const dr = normStr(driverName);
    const [sqGiven = '', sqFamily = ''] = sq.split(' ');
    // Match if driver name contains the Square given name (≥3 chars) or vice versa
    if (sqGiven.length >= 3 && (dr.includes(sqGiven) || sqGiven.includes(dr.split(' ')[0]))) return true;
    // Also check family name initial match (e.g. "Robert T" vs "Tauber")
    if (sqFamily.length >= 1 && dr.includes(sqFamily[0]) && sqGiven.length >= 3 && dr.includes(sqGiven)) return true;
    // Fallback: either name fully contains the other
    return dr.includes(sq) || sq.includes(dr);
  };

  // Walk ALL orders (newest-first across all locations), find the first one
  // attributed to this driver. That order's location_id is where the driver's
  // Square reader is currently active — which may differ from the expected store.
  for (const order of allOrders) {
    const tmId = order.created_by_team_member_id;
    if (!tmId) continue;
    const squareName = teamMemberMap.get(tmId);
    if (nameMatchesDriver(squareName)) {
      return {
        found: true,
        locationId,
        lastLocationId: order.location_id || null,
        orderCreatedAt: order.created_at || null,
        matchedTeamMember: squareName || null,
      };
    }
  }

  // No order matched this driver — treat as first COD of day
  return { found: false, locationId, lastLocationId: null, orderCreatedAt: null };
}

// ─── HANDLERS ────────────────────────────────────────────────────────────────


async function handleReconcile(base44, payload) {
  // payload: { deliveries, transactions, catalogItems, patients, stores, locationConfigs }
  // All data is passed from the frontend so we don't need extra DB calls for the matching phase.
  const deliveries = Array.isArray(payload?.deliveries) ? payload.deliveries : [];
  const transactions = Array.isArray(payload?.transactions) ? payload.transactions : [];
  const catalogItems = Array.isArray(payload?.catalogItems) ? payload.catalogItems : [];
  const patients = Array.isArray(payload?.patients) ? payload.patients : [];
  const stores = Array.isArray(payload?.stores) ? payload.stores : [];
  const locationConfigs = Array.isArray(payload?.locationConfigs) ? payload.locationConfigs : [];

  const patientById = new Map(patients.map((p) => [p.id, p]));
  const storeById = new Map(stores.map((s) => [s.id, s]));
  const configById = new Map(locationConfigs.map((c) => [c.id, c]));

  // ── STEP 1: Identify "No Match" deliveries (in date range, with COD amount) ──
  const noMatchDeliveries = deliveries.filter((d) => {
    if (!d || Number(d.cod_total_amount_required || 0) <= 0) return false;
    if (d.status === 'failed' || d.status === 'cancelled') return false;
    return true;
  });

  // ── STEP 2: Identify "No Match" transactions (collection type, pending) ──
  const noMatchTransactions = transactions.filter((t) => {
    if (!t) return false;
    if (t.type !== 'collection') return false;
    if (!['completed', 'pending'].includes(t.status)) return false;
    return true;
  });

  // ── STEP 3: Match transactions → deliveries by patient name + amount ──
  // Location/store mismatch is acceptable per spec.
  const matchResults = []; // { transactionId, deliveryId, matchedBy }
  const usedDeliveryIds = new Set();

  const normalizeN = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const tokenize = (v) => normalizeN(v).split(' ').filter((t) => t.length >= 2);
  const namesMatch = (a, b) => {
    const na = normalizeN(a); const nb = normalizeN(b);
    if (!na || !nb) return false;
    if (na.includes(nb) || nb.includes(na)) return true;
    const ta = tokenize(na); const tb = tokenize(nb);
    if (!ta.length || !tb.length) return false;
    return ta.every((t) => tb.some((u) => u.includes(t) || t.includes(u) || (Math.max(t.length, u.length) >= 4 && levenshteinDistance(t, u) <= 1)));
  };

  for (const tx of noMatchTransactions) {
    const txAmountCents = toAmountCents(tx.amount_cents ?? Math.round(Number(tx.amount || 0) * 100));
    const txItemName = normalizeText(tx.item_name || '');
    const txIsStructured = isStructuredCodName(txItemName);

    // Parse the transaction date from the item name string itself (most reliable source).
    // Fall back to raw_square_data payment date only for non-structured names.
    const txNameDateIso = txIsStructured ? getStructuredCodDate(txItemName) : null;
    const txDateIso = txNameDateIso || (tx.raw_square_data?.payment_date || tx.created_date || '').slice(0, 10);
    const txDateMs = txDateIso ? new Date(txDateIso + 'T00:00:00').getTime() : 0;

    let bestMatch = null;
    let bestMatchDiffMs = Infinity;

    for (const d of noMatchDeliveries) {
      if (usedDeliveryIds.has(d.id)) continue;
      const dAmountCents = toAmountCents(d.cod_total_amount_required);
      if (dAmountCents !== txAmountCents) continue;

      if (txIsStructured) {
        // For structured names: build the expected item name from delivery data and require exact match.
        const store = storeById.get(d.store_id);
        const config = store ? configById.get(store.square_location_config_id) : null;
        const patient = patientById.get(d.patient_id);
        if (!patient?.full_name || !store?.abbreviation) continue;
        const expectedName = formatItemName(d.delivery_date, store.abbreviation, patient.full_name);
        if (normalizeText(expectedName) !== txItemName) continue;
        // Hard chronology rule: the date embedded in the name IS the delivery date,
        // so this is automatically satisfied by the exact name match above.
        // Still enforce: tx name date >= delivery_date as a final safety check.
        if (d.delivery_date && txNameDateIso && txNameDateIso < d.delivery_date) continue;
      } else {
        // Non-structured: fuzzy patient name match + chronology guard
        const parsedName = (() => {
          const m = txItemName.match(/\d{1,2}[\/-]\d{1,2}\([^)]+\)-(.+)$/);
          return m ? m[1].trim() : txItemName.replace(/^\d{1,2}[\/-]\d{1,2}/, '').replace(/\([^)]+\)/, '').replace(/^[-\s]+/, '').trim();
        })();
        const patient = patientById.get(d.patient_id);
        if (!patient?.full_name) continue;
        if (!namesMatch(patient.full_name, parsedName)) continue;
        if (txDateIso && d.delivery_date && txDateIso < d.delivery_date) continue;
      }

      // Prefer delivery whose date is closest to the transaction date
      const dDateMs = d.delivery_date ? new Date(d.delivery_date + 'T00:00:00').getTime() : 0;
      const diffMs = (txDateMs && dDateMs) ? Math.abs(dDateMs - txDateMs) : Infinity;
      if (diffMs < bestMatchDiffMs) {
        bestMatch = d;
        bestMatchDiffMs = diffMs;
      }
    }

    if (bestMatch) {
      usedDeliveryIds.add(bestMatch.id);
      matchResults.push({ transactionId: tx.id, deliveryId: bestMatch.id, matchedBy: txIsStructured ? 'exact_name_match' : 'name_and_amount' });
    }
  }

  // ── STEP 4: Re-collect deliveries that are STILL unmatched after step 3 ──
  const nowMatchedDeliveryIds = new Set(matchResults.map((m) => m.deliveryId));
  // Also consider deliveries that already had a matching transaction (passed in as matched)
  const stillUnmatched = noMatchDeliveries.filter((d) => !nowMatchedDeliveryIds.has(d.id));

  // ── STEP 5: Filter out deliveries that already have a catalog item ──
  const catalogDeliveryIds = new Set(catalogItems.map((c) => c.delivery_id).filter(Boolean));
  const needsCatalogItem = stillUnmatched.filter((d) => !catalogDeliveryIds.has(d.id));

  // ── Create Square catalog items for remaining unmatched deliveries ──
  const createResults = [];
  for (const delivery of needsCatalogItem) {
    try {
      const r = await base44.functions.invoke('squareCreateCodItem', {
        deliveryId: delivery.id,
        codAmount: delivery.cod_total_amount_required,
        deliveryDate: delivery.delivery_date,
        storeId: delivery.store_id,
        patientName: delivery.patient_name || null,
      });
      createResults.push({ deliveryId: delivery.id, action: 'upsert', status: r?.skipped ? 'skipped' : 'ok', result: r });
    } catch (err) {
      createResults.push({ deliveryId: delivery.id, action: 'upsert', status: 'error', error: err?.message || 'Failed' });
    }
  }

  return {
    success: true,
    matched: matchResults.length,
    matchResults,
    stillUnmatched: stillUnmatched.length,
    needsCatalogItem: needsCatalogItem.length,
    createResults,
  };
}

// Deletes all Square catalog items that have a matching completed/paid Square order.
// This is the cleanup step after getCodData — it compares the live catalog against live orders
// and removes any catalog items where the COD has already been collected via Square POS.

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


async function handleMarkCollectedDebit(base44, payload) {
  const{deliveryId,transactionId,catalogObjectId}=payload||{};
  if(!deliveryId)throw new HttpError(400,'Missing required field: deliveryId');
  const delivery=await base44.asServiceRole.entities.Delivery.get(deliveryId).catch(()=>null);
  if(!delivery)throw new HttpError(404,'Delivery not found');
  await base44.asServiceRole.entities.Delivery.update(deliveryId,{cod_payments:[{type:'Debit',amount:Number(delivery.cod_total_amount_required||0)}]});
  const deleteResult=await base44.functions.invoke('squareDeleteCodItem', {deliveryId,transactionId,catalogObjectId,reason:'collected_debit'});
  return{success:true,deliveryId,paymentType:'Debit',...deleteResult};
}



Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const payload = await req.json().catch(() => ({}));
    const action = payload?.action;
    if(action==='peekDriverTransaction'){await requireUser(base44);return Response.json(await handlePeekDriverTransaction(base44,payload));}
    if(action==='markCollectedDebit'){await requireUser(base44);return Response.json(await handleMarkCollectedDebit(base44,payload));}
    if(action==='fetchPayments'){await requireUser(base44);return Response.json(await handleFetchPayments(base44,payload));}
    if(action==='recordPayment')return Response.json(await handleRecordPayment(base44,payload));
    if(action==='reconcile'){await requireUser(base44);return Response.json(await handleReconcile(base44,payload));}
    throw new HttpError(400,'Missing or invalid action');
  } catch(error){const status=error?.status||500;return Response.json({error:error?.message||'Internal Server Error'},{status});}
});
