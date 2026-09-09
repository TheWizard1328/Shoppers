// squarePruneCatalogDb — one job: keep SquareCatalogItems DB mirroring the LIVE
// Square catalog. Deletes DB records whose square_catalog_object_id no longer
// exists in the Square API catalog (deleted via reconciler, dashboard cleanup,
// or manual deletion). NEVER upserts or modifies surviving records — the
// delivery_id / patient_id links created by the COD sync path are preserved,
// which the driver COD briefing depends on.
// Safe to run as a scheduled job daily.
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

class HttpError extends Error { constructor(s, m) { super(m); this.status = s; } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const requireAdminIfAuthenticated = async (b44) => {
  const ok = await b44.auth.isAuthenticated().catch(() => false);
  if (!ok) return null; // unauthenticated service context (scheduled workflow) proceeds
  const u = await b44.auth.me().catch(() => null);
  if (u?.role !== 'admin') throw new HttpError(403, 'Forbidden: Admin access required');
  return u;
};

const ensureSquareToken = () => {
  const t = Deno.env.get('SQUARE_ACCESS_TOKEN');
  if (!t) throw new HttpError(500, 'Square credentials not configured');
  return t;
};

const SQUARE_BASE_URL = 'https://connect.squareup.com';
const SQUARE_VERSION = '2025-01-23';
const SQUARE_API_MAX_RETRIES = 3;
const SQUARE_RETRY_BASE_DELAY_MS = 400;
const isRetryableSquareStatus = (s) => [408, 409, 429, 500, 502, 503, 504].includes(Number(s));

async function squareFetch(path, method, accessToken, body) {
  let lastError = null;
  for (let attempt = 1; attempt <= SQUARE_API_MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(`${SQUARE_BASE_URL}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Square-Version': SQUARE_VERSION,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await response.text();
      const json = text ? JSON.parse(text) : {};
      if (!response.ok) {
        const msg = json?.errors?.map((e) => e.detail).join(', ') || `Square API error ${response.status}`;
        lastError = new HttpError(response.status, msg);
        if (attempt < SQUARE_API_MAX_RETRIES && isRetryableSquareStatus(response.status)) {
          await sleep(SQUARE_RETRY_BASE_DELAY_MS * attempt);
          continue;
        }
        throw lastError;
      }
      return json;
    } catch (error) {
      lastError = error;
      if (attempt < SQUARE_API_MAX_RETRIES) {
        await sleep(SQUARE_RETRY_BASE_DELAY_MS * attempt);
        continue;
      }
      throw lastError;
    }
  }
  throw lastError || new Error('Square API request failed');
}

async function listActiveCatalogItems(accessToken) {
  const objects = [];
  let cursor;
  do {
    const json = await squareFetch('/v2/catalog/search', 'POST', accessToken, {
      object_types: ['ITEM'],
      include_deleted_objects: false,
      archived_state: 'ARCHIVED_STATE_NOT_ARCHIVED',
      limit: 1000,
      cursor,
    });
    objects.push(...(json.objects || []));
    cursor = json.cursor;
    if (cursor) await sleep(200);
  } while (cursor);
  return objects;
}

const unwrapEntityRecord = (r) => {
  if (!r || typeof r !== 'object') return null;
  if (r.data && typeof r.data === 'object') {
    return { ...r.data, id: r.data.id || r.id, created_date: r.data.created_date || r.created_date, updated_date: r.data.updated_date || r.updated_date };
  }
  return r;
};

async function handlePruneCatalogDb(base44) {
  const accessToken = ensureSquareToken();
  const startedAt = Date.now();

  const [liveCatalogItems, existingCatalogDb] = await Promise.all([
    listActiveCatalogItems(accessToken),
    base44.asServiceRole.entities.SquareCatalogItems.list('-updated_date', 2000).catch(() => []),
  ]);

  const safeRecords = (Array.isArray(existingCatalogDb) ? existingCatalogDb : []).map(unwrapEntityRecord).filter(Boolean);
  const liveObjectIds = new Set((liveCatalogItems || []).map((item) => item?.id).filter(Boolean));

  // Stale = has a Square object id that is no longer in the live catalog.
  // Records WITHOUT a square_catalog_object_id are also stale (they reference
  // nothing on Square) — created by older paths before the id was captured.
  const stale = safeRecords.filter((r) => {
    const oid = r?.square_catalog_object_id;
    return !oid || !liveObjectIds.has(oid);
  });
  const kept = safeRecords.length - stale.length;

  let deleted = 0;
  const failed = [];
  for (let i = 0; i < stale.length; i += 50) {
    const chunk = stale.slice(i, i + 50);
    const results = await Promise.all(chunk.map((r) =>
      base44.asServiceRole.entities.SquareCatalogItems.delete(r.id).then(() => null).catch((e) => e?.message || 'delete failed')
    ));
    results.forEach((err, idx) => { if (err) { failed.push({ id: chunk[idx]?.id, error: err }); } else { deleted++; } });
  }

  return {
    success: true,
    live_catalog_count: liveObjectIds.size,
    db_records_before: safeRecords.length,
    pruned: deleted,
    kept,
    failed: failed.length,
    failed_details: failed.slice(0, 10),
    duration_ms: Date.now() - startedAt,
  };
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    await requireAdminIfAuthenticated(base44);
    return Response.json(await handlePruneCatalogDb(base44));
  } catch (error) {
    const status = error?.status || 500;
    return Response.json({ error: error?.message || 'Internal Server Error' }, { status });
  }
});
