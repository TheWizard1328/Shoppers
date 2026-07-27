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

const MATCH_DATE_OFFSET_DAYS = 2;
const buildItemSignature = (n, c) => `${normalizeText(n)}::${toAmountCents(c)}`;
const normalizeMatchName = (v) => normalizeText(v).replace(/\s+/g,' ').replace(/\s-\s\$\d+(?:\.\d{2})?$/,'').replace(/^(\d{2})-(\d{2})/,'$1/$2').toLowerCase();
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
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const payload = await req.json().catch(() => ({}));
    await requireUser(base44);
    return Response.json(await handleReconcile(base44, payload));
  } catch(error){const status=error?.status||500;return Response.json({error:error?.message||'Internal Server Error'},{status});}
});
