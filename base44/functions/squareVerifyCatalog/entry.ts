// SQUARE VERIFY CATALOG (owner spec Oct 27 2026) — focused pre-balances
// verification. When the Square Balances sync/refresh runs (auto or manual),
// this rechecks the CURRENT active Square Catalog items for COLLECTED
// transactions and clears the collected ones — checking each item across its
// OWN full age window (oldest active item drives the Square order fetch), NOT
// a fixed 2-week/90-day lookback, because some past catalog items can be older
// than any fixed window.
//
// Deletion rules mirror squareGetCodData2's sanctioned cleanup paths exactly:
//   1. real POS SquareTransaction row linked by catalog object id (rung with
//      the item selected) — pending or completed both mean "used in the POS".
//   2. real POS SquareTransaction row matching by item name+amount signature
//      (custom-line-item path — only OUR OWN retained tx rows, never raw
//      order-name guessing).
//   3. completed real SquareTransaction linked to the item's description
//      delivery_id.
//   4. Square order line items (COMPLETED + OPEN, fetched back to the oldest
//      active item's date) whose catalog_object_id is the item / variation id.
//   5. delivery-side authority: the item's linked delivery is
//      cod_confirmed_collected, OR completed with a recorded card/cheque/
//      archived tender (cash completions KEEP the item until the store rings
//      it through).
//   6. cash-collected delivery whose structured name+amount signature matches
//      a COMPLETED Square order line item (the wide-scan confirm rule) — the
//      delivery is also stamped cod_confirmed_collected so the evidence
//      persists after this run.
// Uncollected items are NEVER touched, however old. Idempotent: re-running
// simply re-verifies. Self-contained by design (no cross-function invokes).
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

class HttpError extends Error { constructor(s, m) { super(m); this.status = s; } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const normalizeText = (v) => String(v || '').trim();
const toAmountCents = (v) => Math.max(0, Math.round(Number(v || 0)));
const unwrapEntityRecord = (r) => { if (!r || typeof r !== 'object') return null; if (r.data && typeof r.data === 'object') return { ...r.data, id: r.data.id || r.id }; return r; };
const requireUser = async (b44) => {
  const u = await b44.auth.me().catch(() => null);
  if (!u) throw new HttpError(401, 'Unauthorized');
  if (!['admin', 'App Owner'].includes(u?.role)) throw new HttpError(403, 'Forbidden: Admin access required');
  return u;
};
const ensureSquareToken = () => { const t = Deno.env.get('SQUARE_ACCESS_TOKEN'); if (!t) throw new HttpError(500, 'Square credentials not configured'); return t; };
const SQUARE_BASE_URL = 'https://connect.squareup.com';
const SQUARE_VERSION = '2025-01-23';
const SQUARE_API_MAX_RETRIES = 3;
const SQUARE_RETRY_BASE_DELAY_MS = 400;
const isRetryableSquareStatus = (s) => [408, 409, 429, 500, 502, 503, 504].includes(Number(s));

async function squareFetch(path, method, accessToken, body) {
  let lastError = null;
  for (let attempt = 1; attempt <= SQUARE_API_MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(`${SQUARE_BASE_URL}${path}`, { method, headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'Square-Version': SQUARE_VERSION }, body: body ? JSON.stringify(body) : undefined });
      const text = await response.text(); const json = text ? JSON.parse(text) : {};
      if (!response.ok) {
        const msg = json?.errors?.map((e) => e.detail).join(', ') || `Square API error ${response.status}`;
        lastError = new HttpError(response.status, msg);
        if (attempt < SQUARE_API_MAX_RETRIES && isRetryableSquareStatus(response.status)) { await sleep(SQUARE_RETRY_BASE_DELAY_MS * attempt); continue; }
        throw lastError;
      }
      return json;
    } catch (error) {
      lastError = error;
      if (attempt < SQUARE_API_MAX_RETRIES) { await sleep(SQUARE_RETRY_BASE_DELAY_MS * attempt); continue; }
      throw lastError;
    }
  }
  throw lastError || new Error('Square API request failed');
}

const buildItemSignature = (n, c) => `${normalizeText(n)}::${toAmountCents(c)}`;
const shouldIgnoreManualOrderLabel = (v) => ['top ups', 'top up', 'topup', 'tip', 'top'].includes(String(v || '').replace(/\s+/g, ' ').trim().toLowerCase());

function extractCatalogMonthDay(v) {
  const n = normalizeText(v); const iso = n.match(/^\d{4}-(\d{2})-(\d{2})$/); if (iso) return `${iso[1]}-${iso[2]}`;
  const pre = n.slice(0, 5); const m = pre.match(/^(\d{2})\/(\d{2})$/); return m ? `${m[1]}-${m[2]}` : '';
}
function parseDateValue(value, ref = new Date()) {
  const n = normalizeText(value); const iso = n.match(/^(\d{4})-(\d{2})-(\d{2})$/); if (iso) return new Date(+iso[1], +iso[2] - 1, +iso[3]);
  const mdk = extractCatalogMonthDay(n); if (!mdk) return null;
  const [mo, da] = mdk.split('-').map(Number); const rl = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate());
  return [rl.getFullYear() - 1, rl.getFullYear(), rl.getFullYear() + 1].map((y) => new Date(y, mo - 1, da)).sort((a, b) => Math.abs(a - rl) - Math.abs(b - rl))[0] || null;
}
const toIsoDate = (v) => { const p = parseDateValue(v); return (p && !Number.isNaN(p.getTime())) ? p.toISOString().slice(0, 10) : null; };

function extractDeliveryIdFromCatalog(item) {
  const desc = String(item?.item_data?.description || '').toLowerCase();
  const m = desc.match(/delivery\s+([a-f0-9]{24})/i);
  return m ? m[1] : null;
}
const getCatalogItemAmountCents = (item) => { const vs = item?.item_data?.variations || []; const v = vs.find((e) => e?.item_variation_data?.price_money?.amount != null) || vs[0]; return toAmountCents(v?.item_variation_data?.price_money?.amount); };

async function listActiveCatalogItems(accessToken) {
  const objects = []; let cursor;
  do { const json = await squareFetch('/v2/catalog/search', 'POST', accessToken, { object_types: ['ITEM'], include_deleted_objects: false, archived_state: 'ARCHIVED_STATE_NOT_ARCHIVED', limit: 1000, cursor }); objects.push(...(json.objects || [])); cursor = json.cursor; if (cursor) await sleep(200); } while (cursor);
  return objects;
}
async function listOrders(locationIds, startAt, accessToken, maxOrders = 4000, states = ['COMPLETED', 'OPEN'], sortOrder = 'DESC', endAt = null) {
  if (!locationIds.length) return [];
  const orders = []; let cursor = null;
  do {
    const json = await squareFetch('/v2/orders/search', 'POST', accessToken, { location_ids: locationIds, cursor, limit: 500, query: { filter: { state_filter: { states }, date_time_filter: { created_at: { start_at: startAt, end_at: endAt || undefined } } }, sort: { sort_field: 'CREATED_AT', sort_order: sortOrder } } });
    orders.push(...(json.orders || [])); cursor = json.cursor || null;
    if (cursor && orders.length < maxOrders) await sleep(200);
  } while (cursor && orders.length < maxOrders);
  return orders.slice(0, maxOrders);
}
// (line-item flattening is inlined in pass 3 — refund-aware, same rules as the reconcile)
function safeDeleteSquareCatalogObject(catalogObjectId, accessToken) {
  return squareFetch(`/v2/catalog/object/${catalogObjectId}`, 'DELETE', accessToken);
}
async function deleteCatalogObjects(objectIds, accessToken) {
  const deleted = []; const failed = [];
  for (let i = 0; i < objectIds.length; i += 50) {
    const chunk = objectIds.slice(i, i + 50);
    try {
      await squareFetch('/v2/catalog/batch-delete', 'POST', accessToken, { object_ids: chunk });
      deleted.push(...chunk);
    } catch (e) {
      for (const id of chunk) { try { await safeDeleteSquareCatalogObject(id, accessToken); deleted.push(id); } catch { failed.push(id); } }
    }
    if (i + 50 < objectIds.length) await sleep(300);
  }
  return { deleted, failed };
}

const COLLECTED_PAYMENT_TYPES = new Set(['Debit', 'Credit', 'Cheque', 'Check', 'debit', 'credit', 'cheque', 'check', 'card', 'Card', 'Archived', 'archived']);
const deliveryHasRecordedCollectedPayment = (d) => (Array.isArray(d?.cod_payments) ? d.cod_payments : []).some((p) => Number(p?.amount || 0) > 0 && COLLECTED_PAYMENT_TYPES.has(String(p?.type || '')));
const isCompletedCashCod = (d) => d?.status === 'completed' && Number(d?.cod_total_amount_required || 0) > 0 &&
  (Array.isArray(d?.cod_payments) ? d.cod_payments : []).some((p) => String(p?.type || '').toLowerCase() === 'cash' && Number(p?.amount || 0) > 0);

Deno.serve(async (req) => {
  const t0 = Date.now();
  try {
    const b44 = createClientFromRequest(req);
    await requireUser(b44);
    const accessToken = ensureSquareToken();

    // ── 1) Entity context (parallel) ──────────────────────────────────
    const [allLocationConfigs, transactionsRaw, catalogDbRaw] = await Promise.all([
      b44.asServiceRole.entities.SquareLocationConfig.list('-updated_date', 500).catch(() => []),
      b44.asServiceRole.entities.SquareTransaction.list('-updated_date', 5000).catch(() => []),
      b44.asServiceRole.entities.SquareCatalogItems.list('-updated_date', 2000).catch(() => []),
    ]);
    const locationIds = Array.from(new Set((allLocationConfigs || []).map((c) => c?.square_location_id).filter(Boolean)));
    const transactions = (transactionsRaw || []).map(unwrapEntityRecord).filter(Boolean);
    const catalogDb = (catalogDbRaw || []).map(unwrapEntityRecord).filter(Boolean);
    const catalogDbByObjectId = new Map(catalogDb.filter((c) => c?.square_catalog_object_id).map((c) => [c.square_catalog_object_id, c]));

    // ── 2) Live active catalog items from Square ──────────────────────
    const liveCatalogItems = await listActiveCatalogItems(accessToken);
    console.log(`[squareVerifyCatalog] active catalog items: ${liveCatalogItems.length}`);

    // ── 3) Our own retained POS evidence sets ─────────────────────────
    const realPosTransactions = transactions.filter((t) => normalizeText(t?.square_transaction_id) !== '');
    const txCatalogObjectIds = new Set();
    const txSignatureSet = new Set();
    const txDeliveryIds = new Set();         // any real tx (pending or completed) — item was used in the POS
    const completedTxDeliveryIds = new Set(); // completed real tx — collection proven
    for (const t of realPosTransactions) {
      const cid = normalizeText(t?.square_catalog_object_id);
      if (cid && cid !== '') txCatalogObjectIds.add(cid);
      const sig = buildItemSignature(t?.item_name, t?.amount_cents ?? Math.round(Number(t?.amount || 0) * 100));
      if (sig && sig !== '::0') txSignatureSet.add(sig);
      const did = normalizeText(t?.delivery_id);
      if (did) { txDeliveryIds.add(did); if (String(t?.status || '') === 'completed') completedTxDeliveryIds.add(did); }
    }

    // ── 4) Pass 1: transaction-evidence deletions (no delivery fetch) ─
    const toDelete = new Map(); // objectId -> { name, amount_cents, reason }
    const descDeliveryIds = new Map(); // objectId -> delivery_id
    const itemDates = [];
    for (const item of liveCatalogItems) {
      if (!item?.id) continue;
      const dbRec = catalogDbByObjectId.get(item.id);
      const descDeliveryId = normalizeText(dbRec?.delivery_id) || extractDeliveryIdFromCatalog(item) || null;
      if (descDeliveryId) descDeliveryIds.set(item.id, descDeliveryId);
      const name = normalizeText(item?.item_data?.name);
      const dIso = toIsoDate(name);
      if (dIso) itemDates.push(dIso);

      const varIds = (item?.item_data?.variations || []).map((v) => v?.id).filter(Boolean);
      const amountCents = getCatalogItemAmountCents(item);
      let reason = null;
      if (txCatalogObjectIds.has(item.id) || varIds.some((v) => txCatalogObjectIds.has(v))) reason = 'pos_transaction_link';
      else {
        const sig = buildItemSignature(name, amountCents);
        if (sig && sig !== '::0' && txSignatureSet.has(sig)) reason = 'pos_transaction_signature';
      }
      if (!reason && descDeliveryId && (txDeliveryIds.has(descDeliveryId) || completedTxDeliveryIds.has(descDeliveryId))) reason = 'delivery_transaction';
      if (reason) toDelete.set(item.id, { name, amount_cents: amountCents, reason });
    }

    // ── 5) Pass 2: delivery-side authority for the remaining items ────
    // Per-id gets (batched, capped) — items can reference deliveries far
    // outside any window. Cash completions KEEP their items; card/cheque/
    // archived and confirmed-collected ones clear.
    const remaining = liveCatalogItems.filter((i) => i?.id && !toDelete.has(i.id) && descDeliveryIds.has(i.id));
    const idsToFetch = Array.from(new Set(remaining.map((i) => descDeliveryIds.get(i.id)))).slice(0, 120); // rate safety cap
    const deliveryRows = new Map();
    for (let i = 0; i < idsToFetch.length; i += 10) {
      const chunk = idsToFetch.slice(i, i + 10);
      const rows = await Promise.all(chunk.map((id) => b44.asServiceRole.entities.Delivery.get(id).then(unwrapEntityRecord).catch(() => null)));
      rows.forEach((d) => { if (d?.id) deliveryRows.set(d.id, d); });
      if (i + 10 < idsToFetch.length) await sleep(100);
    }
    for (const item of remaining) {
      const did = descDeliveryIds.get(item.id);
      const d = deliveryRows.get(did);
      if (!d) continue;
      if (d.cod_confirmed_collected === true || (d.status === 'completed' && deliveryHasRecordedCollectedPayment(d))) {
        toDelete.set(item.id, { name: normalizeText(item?.item_data?.name), amount_cents: getCatalogItemAmountCents(item), reason: 'delivery_collected' });
      }
    }

    // ── 6) Pass 3: Square order verification across the ITEMS' window ─
    // Window = oldest active item's date − 3 days → now (NOT a fixed
    // 2-week/90-day lookback — owner spec Oct 27 2026: past items can be
    // older than any fixed window). Fallback 90 days when no date parses.
    const unjudged = liveCatalogItems.filter((i) => i?.id && !toDelete.has(i.id));
    let windowStart = null;
    if (unjudged.length > 0 && locationIds.length > 0) {
      const oldest = itemDates.length ? itemDates.sort()[0] : null;
      const fallback = new Date(Date.now() - 90 * 86400000).toISOString();
      windowStart = oldest ? new Date(new Date(`${oldest}T00:00:00Z`).getTime() - 3 * 86400000).toISOString() : fallback;
      console.log(`[squareVerifyCatalog] order verification window: ${windowStart}`);
      const orders = await listOrders(locationIds, windowStart, accessToken, 4000, ['COMPLETED', 'OPEN']).catch((e) => { console.warn('[squareVerifyCatalog] order fetch failed:', e?.message || e); return []; });
      // Flatten line items (same refund-aware rules as the reconcile).
      const paidCatalogObjectIds = new Set();
      const completedSigSet = new Set();
      for (const order of orders || []) {
        const refundedQtyByUid = new Map();
        for (const rli of order?.return_line_items || []) { const uid = rli?.source_line_item_uid; if (!uid) continue; const rq = Math.round(Number(rli?.quantity || 1)) || 1; refundedQtyByUid.set(uid, (refundedQtyByUid.get(uid) || 0) + rq); }
        const completed = String(order?.state || '') === 'COMPLETED';
        for (const li of order?.line_items || []) {
          const itemName = normalizeText(li?.name || li?.note);
          if (!itemName || shouldIgnoreManualOrderLabel(itemName)) continue;
          const totalQty = Math.round(Number(li?.quantity || 1)) || 1;
          const netQty = Math.max(0, totalQty - (refundedQtyByUid.get(li?.uid) || 0));
          if (netQty <= 0) continue;
          const eu = toAmountCents(li?.base_price_money?.amount);
          const gr = toAmountCents(li?.gross_sales_money?.amount || li?.total_money?.amount);
          const ac = eu || (totalQty > 0 ? Math.round(gr / totalQty) : gr);
          if (li?.catalog_object_id) paidCatalogObjectIds.add(li.catalog_object_id);
          if (completed) completedSigSet.add(buildItemSignature(itemName, ac));
        }
      }
      for (const item of unjudged) {
        const varIds = (item?.item_data?.variations || []).map((v) => v?.id).filter(Boolean);
        const name = normalizeText(item?.item_data?.name);
        const amountCents = getCatalogItemAmountCents(item);
        if (paidCatalogObjectIds.has(item.id) || varIds.some((v) => paidCatalogObjectIds.has(v))) {
          toDelete.set(item.id, { name, amount_cents: amountCents, reason: 'order_rung_up' });
          continue;
        }
        // Cash-COD wide-scan confirm (owner's collected-verification): the
        // linked delivery is a completed cash COD and a COMPLETED order line
        // item matches its structured name+amount exactly — the store rang
        // it through. Card-paid or active deliveries are never name-matched
        // (the aggressive match the reconcile deliberately removed).
        const did = descDeliveryIds.get(item.id);
        const d = did ? deliveryRows.get(did) : null;
        if (d && isCompletedCashCod(d) && !d.cod_confirmed_collected) {
          const sig = buildItemSignature(name, amountCents);
          if (sig && sig !== '::0' && completedSigSet.has(sig)) {
            toDelete.set(item.id, { name, amount_cents: amountCents, reason: 'order_signature_cash_confirmed' });
            // Persist the confirmation on the delivery — durable evidence
            // survives this run (same stamp the wide scan writes).
            await b44.asServiceRole.entities.Delivery.update(d.id, { cod_confirmed_collected: true }).catch(() => null);
          }
        }
      }
    }

    // ── 7) Delete collected items ─────────────────────────────────────
    const objectIds = Array.from(toDelete.keys());
    const deletedInfo = Array.from(toDelete.values());
    const { deleted, failed } = objectIds.length ? await deleteCatalogObjects(objectIds, accessToken) : { deleted: [], failed: [] };
    // Keep the DB mirror in step: drop rows for the items Square no longer has.
    for (const oid of deleted) {
      const dbRec = catalogDbByObjectId.get(oid);
      if (dbRec?.id) b44.asServiceRole.entities.SquareCatalogItems.delete(dbRec.id).catch(() => {});
    }

    console.log(`[squareVerifyCatalog] done in ${Date.now() - t0}ms — checked ${liveCatalogItems.length}, deleted ${deleted.length}, failed ${failed.length}`);
    return Response.json({
      success: true,
      checked: liveCatalogItems.length,
      catalogDeleted: deletedInfo,           // [{ name, amount_cents }] — same shape the balances page status text reads
      catalogCreated: [],                    // compatibility with the old reconcile response
      deletedCount: deleted.length,
      failedCount: failed.length,
      windowStart,
      elapsedMs: Date.now() - t0,
    });
  } catch (e) {
    console.error('[squareVerifyCatalog] error:', e?.message || e);
    return Response.json({ error: e?.message || 'Unknown error' }, { status: e?.status || 500 });
  }
});
