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

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const payload = await req.json().catch(() => ({}));
    await requireUser(base44);
    return Response.json(await handlePeekDriverTransaction(base44, payload));
  } catch(error){const status=error?.status||500;return Response.json({error:error?.message||'Internal Server Error'},{status});}
});
