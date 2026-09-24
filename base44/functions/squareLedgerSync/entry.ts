// Square finance-audit ledger sync.
// Backfills and refreshes SquareLedgerEntry records from the live Square account:
//   - /v2/payments      -> card sales (incl. business Square Card spends) + declines (FAILED)
//   - /v2/orders/search -> cash tenders + COD delivery links (catalog item matching)
//   - /v2/refunds       -> refunds, linked back to their originating payment
//   - /v2/payouts       -> bank transfers (best effort; requires PAYOUTS_READ scope)
// Idempotent: upserts keyed on square_id, safe to re-run for the same window.
// Self-contained by design — no cross-function base44.functions.invoke calls
// (the platform gateway 403s those without forwarding auth context).

import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

class HttpError extends Error { status: number; constructor(s: number, m: string) { super(m); this.status = s; } }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const toCents = (v: any) => Math.max(0, Math.round(Number(v || 0)));
const normalizeText = (v: any) => String(v || '').trim();

const SQUARE_BASE_URL = 'https://connect.squareup.com';
const SQUARE_VERSION = '2025-01-23';
const SQUARE_API_MAX_RETRIES = 3;
const SQUARE_RETRY_BASE_DELAY_MS = 400;
const isRetryableSquareStatus = (s: number) => [408, 409, 429, 500, 502, 503, 504].includes(Number(s));

const UPSERT_CHUNK = 100;
const DEFAULT_MONTHS_BACK = 24;
const MAX_MONTHS_BACK = 60;
const MAX_PAGES_PER_ENDPOINT = 100; // 500 records/page -> hard cap 50k per location

async function squareFetch(path: string, method: string, accessToken: string, body?: any) {
  let lastError: any = null;
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
        const msg = json?.errors?.map((e: any) => e.detail).join(', ') || `Square API error ${response.status}`;
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

async function paginatedSquareGet(path: string, accessToken: string, maxPages = MAX_PAGES_PER_ENDPOINT) {
  const items: any[] = [];
  let cursor: string | null = null;
  let page = 0;
  do {
    const url = cursor ? `${path}${path.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(cursor)}` : path;
    const json = await squareFetch(url, 'GET', accessToken);
    // Response key is derived from the endpoint (payments, refunds, payouts)
    const key = Object.keys(json).find((k) => Array.isArray(json[k]));
    items.push(...(key ? json[key] : []));
    cursor = json.cursor || null;
    page++;
    if (cursor && page < maxPages) await sleep(150);
  } while (cursor && page < maxPages);
  return items;
}

async function listOrdersForLocation(locationId: string, startAt: string, accessToken: string) {
  const orders: any[] = [];
  let cursor: string | null = null;
  let page = 0;
  do {
    const json = await squareFetch('/v2/orders/search', 'POST', accessToken, {
      location_ids: [locationId],
      cursor,
      limit: 500,
      query: {
        filter: {
          state_filter: { states: ['COMPLETED', 'CANCELED'] },
          date_time_filter: { created_at: { start_at: startAt } },
        },
        sort: { sort_field: 'CREATED_AT', sort_order: 'ASC' },
      },
    });
    orders.push(...(json.orders || []));
    cursor = json.cursor || null;
    page++;
    if (cursor && page < MAX_PAGES_PER_ENDPOINT) await sleep(150);
  } while (cursor && page < MAX_PAGES_PER_ENDPOINT);
  return orders;
}

function sumProcessingFees(payment: any) {
  const fees = payment?.processing_fee || [];
  let total = 0;
  for (const f of fees) total += Math.abs(Number(f?.amount_money?.amount || 0));
  return Math.round(total);
}

function resolveCodLink(order: any, catalogByObjectId: Map<string, any>) {
  for (const li of order?.line_items || []) {
    const link = li?.catalog_object_id ? catalogByObjectId.get(li.catalog_object_id) : null;
    if (link) return link;
  }
  return null;
}

function buildEntry(base: Record<string, any>) {
  const entry: Record<string, any> = {
    square_id: base.square_id,
    entry_kind: base.entry_kind,
    tender_type: base.tender_type ?? null,
    sale_class: base.sale_class ?? null,
    amount_cents: toCents(base.amount_cents),
    fee_cents: toCents(base.fee_cents),
    status: base.status || null,
    occurred_at: base.occurred_at || null,
    location_id: base.location_id || null,
    location_name: base.location_name || null,
    order_id: base.order_id || null,
    delivery_id: base.delivery_id || null,
    patient_id: base.patient_id || null,
    cod_item_name: base.cod_item_name || null,
    refund_of_payment_id: base.refund_of_payment_id || null,
    refund_of_square_id: base.refund_of_square_id || null,
    reason: base.reason || null,
    card_fingerprint: base.card_fingerprint || null,
    card_last4: base.card_last4 || null,
    card_brand: base.card_brand || null,
    entry_method: base.entry_method || null,
    synced_at: new Date().toISOString(),
  };
  return entry;
}

Deno.serve(async (req) => {
  const startedAt = Date.now();
  try {
    const base44 = createClientFromRequest(req);

    // Softened auth gate (same posture as other Square functions): validate the
    // caller when an auth context is present; proceed without one otherwise.
    const isAuthenticated = await base44.auth.isAuthenticated().catch(() => false);
    if (isAuthenticated) {
      const user = await base44.auth.me().catch(() => null);
      if (user && !['admin', 'app_owner'].includes(String(user.role || '').toLowerCase())) {
        throw new HttpError(403, 'Forbidden: Admin access required');
      }
    }

    const payload = await req.json().catch(() => ({}));
    const accessToken = Deno.env.get('SQUARE_ACCESS_TOKEN');
    if (!accessToken) throw new HttpError(500, 'Square credentials not configured');

    const monthsBack = Math.min(MAX_MONTHS_BACK, Math.max(1, Math.round(Number(payload?.monthsBack || DEFAULT_MONTHS_BACK)) || DEFAULT_MONTHS_BACK));
    const windowStart = payload?.startDate || new Date(Date.now() - monthsBack * 30.44 * 86400000).toISOString().slice(0, 10) + 'T00:00:00Z';
    const windowEnd = payload?.endDate || new Date().toISOString();

    // Active Square locations
    const configsRaw = await base44.asServiceRole.entities.SquareLocationConfig.list('-updated_date', 500).catch(() => []);
    const configs = (configsRaw || []).filter((c: any) => c?.square_location_id && (!c?.status || c.status === 'active'));
    if (!configs.length) throw new HttpError(400, 'No active Square location configurations found');

    // COD link map: catalog object id -> { delivery_id, patient_id, item_name }
    const catalogByObjectId = new Map<string, any>();
    let catalogSkip = 0;
    for (let round = 0; round < 30; round++) {
      const page = await base44.asServiceRole.entities.SquareCatalogItems.list('-updated_date', 2000, catalogSkip).catch(() => []);
      const rows = page || [];
      for (const item of rows) {
        if (item?.square_catalog_object_id) {
          catalogByObjectId.set(item.square_catalog_object_id, {
            delivery_id: item.delivery_id || null,
            patient_id: item.patient_id || null,
            item_name: item.item_name || null,
          });
        }
      }
      if (rows.length < 2000) break;
      catalogSkip += 2000;
    }

    const entries: Map<string, any> = new Map();
    const locationStats: any[] = [];
    let payoutsAvailable = true;
    const syncErrors: string[] = [];

    // Fetch all locations' data in parallel (keeps each sync call fast enough
    // for the platform's client-side invoke timeout)
    const fetchLocationData = async (config: any) => {
      const locationId = config.square_location_id;
      const locationName = config.name || config.store_name || locationId;
      const out: any = { config, locationName, payments: [], orders: [], refunds: [], payouts: [], errors: [] };

      const tasks: Promise<any>[] = [
        (async () => {
          try {
            const paymentsPath = `/v2/payments?location_id=${encodeURIComponent(locationId)}&begin_time=${encodeURIComponent(windowStart)}&end_time=${encodeURIComponent(windowEnd)}&sort_order=ASC`;
            out.payments = await paginatedSquareGet(paymentsPath, accessToken);
          } catch (e: any) { out.errors.push(`payments(${locationName}): ${e?.message || e}`); }
        })(),
        (async () => {
          try {
            out.orders = await listOrdersForLocation(locationId, windowStart, accessToken);
          } catch (e: any) { out.errors.push(`orders(${locationName}): ${e?.message || e}`); }
        })(),
        (async () => {
          try {
            const refundsPath = `/v2/refunds?location_id=${encodeURIComponent(locationId)}&begin_time=${encodeURIComponent(windowStart)}&end_time=${encodeURIComponent(windowEnd)}&sort_order=ASC`;
            out.refunds = await paginatedSquareGet(refundsPath, accessToken);
          } catch (e: any) { out.errors.push(`refunds(${locationName}): ${e?.message || e}`); }
        })(),
        (async () => {
          try {
            const payoutsPath = `/v2/payouts?location_id=${encodeURIComponent(locationId)}&begin_time=${encodeURIComponent(windowStart)}&end_time=${encodeURIComponent(windowEnd)}&sort_order=ASC`;
            out.payouts = await paginatedSquareGet(payoutsPath, accessToken);
          } catch (e: any) {
            const msg = String(e?.message || e);
            if (!/scope|401|403/i.test(msg)) out.errors.push(`payouts(${locationName}): ${msg}`);
            out.payoutsScopeMissing = true;
          }
        })(),
      ];
      await Promise.all(tasks);
      return out;
    };

    const locationData = await Promise.all((configs as any[]).map(fetchLocationData));
    for (const ld of locationData) {
      if (ld.payoutsScopeMissing) payoutsAvailable = false;
      for (const e of ld.errors || []) syncErrors.push(e);
    }

    for (const ld of locationData) {
      const locationId = ld.config.square_location_id;
      const locationName = ld.locationName;
      const { payments, orders, refunds, payouts } = ld;

      const orderById = new Map<string, any>(orders.map((o: any) => [o.id, o]));
      const paymentById = new Map<string, any>(payments.map((p: any) => [p.id, p]));

      // Card payments -> sale or decline entries
      for (const payment of payments) {
        const order = payment?.order_id ? orderById.get(payment.order_id) : null;
        const codLink = order ? resolveCodLink(order, catalogByObjectId) : null;
        const card = payment?.card_details?.card;
        const status = String(payment?.status || '').toUpperCase();

        if (status === 'FAILED') {
          const declineReason = payment?.card_details?.errors?.map((e: any) => e.detail).join(', ')
            || payment?.card_details?.status
            || payment?.risk_evaluation?.risk_level
            || 'DECLINED';
          entries.set(payment.id, buildEntry({
            square_id: payment.id,
            entry_kind: 'decline',
            amount_cents: payment?.amount_money?.amount,
            status: payment.status,
            occurred_at: payment.created_at,
            location_id: locationId,
            location_name: locationName,
            order_id: payment.order_id || null,
            reason: declineReason,
            card_fingerprint: card?.fingerprint || null,
            card_last4: card?.last_4 || null,
            card_brand: card?.card_brand || null,
            entry_method: payment?.card_details?.entry_method || null,
          }));
          continue;
        }

        if (status !== 'COMPLETED') continue; // PENDING/APPROVED/CANCELED handled on later syncs

        entries.set(payment.id, buildEntry({
          square_id: payment.id,
          entry_kind: 'sale',
          tender_type: 'CARD',
          sale_class: codLink ? 'cod_collection' : null,
          amount_cents: payment?.amount_money?.amount,
          fee_cents: sumProcessingFees(payment),
          status: payment.status,
          occurred_at: payment.created_at,
          location_id: locationId,
          location_name: locationName,
          order_id: payment.order_id || null,
          delivery_id: codLink?.delivery_id || null,
          patient_id: codLink?.patient_id || null,
          cod_item_name: codLink?.item_name || null,
          card_fingerprint: card?.fingerprint || null,
          card_last4: card?.last_4 || null,
          card_brand: card?.card_brand || null,
          entry_method: payment?.card_details?.entry_method || null,
        }));
      }

      // Cash / non-card tenders from orders -> sale entries (card tenders are covered above)
      for (const order of orders) {
        for (const tender of order?.tenders || []) {
          if (!tender?.id) continue;
          if (tender.type === 'CARD' || tender.payment_id) continue; // already in payments pass
          const codLink = resolveCodLink(order, catalogByObjectId);
          entries.set(`tender-${tender.id}`, buildEntry({
            square_id: `tender-${tender.id}`,
            entry_kind: 'sale',
            tender_type: tender.type || 'OTHER',
            sale_class: codLink ? 'cod_collection' : null,
            amount_cents: tender?.amount_money?.amount,
            status: order.state === 'COMPLETED' ? 'COMPLETED' : order.state,
            occurred_at: tender.created_at || order.created_at,
            location_id: locationId,
            location_name: locationName,
            order_id: order.id,
            delivery_id: codLink?.delivery_id || null,
            patient_id: codLink?.patient_id || null,
            cod_item_name: codLink?.item_name || null,
          }));
        }
      }

      // Refunds -> linked back to their payment (and through it, to the delivery)
      for (const refund of refunds) {
        const refPayment = refund?.payment_id ? paymentById.get(refund.payment_id) : null;
        const order = refPayment?.order_id ? orderById.get(refPayment.order_id) : null;
        const codLink = order ? resolveCodLink(order, catalogByObjectId) : null;
        const refTender = (order?.tenders || []).find((t: any) => t.payment_id === refund.payment_id);
        const refundOfSquareId = refPayment ? refPayment.id : (refTender ? `tender-${refTender.id}` : null);
        entries.set(refund.id, buildEntry({
          square_id: refund.id,
          entry_kind: 'refund',
          amount_cents: refund?.amount_money?.amount,
          status: refund.status,
          occurred_at: refund.created_at,
          location_id: refund.location_id || locationId,
          location_name: locationName,
          order_id: refPayment?.order_id || null,
          delivery_id: codLink?.delivery_id || null,
          patient_id: codLink?.patient_id || null,
          cod_item_name: codLink?.item_name || null,
          refund_of_payment_id: refund.payment_id || null,
          refund_of_square_id: refundOfSquareId,
          reason: refund.reason || null,
        }));
      }

      // Payouts -> bank transfer entries (best effort)
      for (const payout of payouts) {
        if (!payout?.id) continue;
        entries.set(payout.id, buildEntry({
          square_id: payout.id,
          entry_kind: 'payout',
          amount_cents: payout?.amount_money?.amount,
          status: payout.status,
          occurred_at: payout.created_at,
          location_id: payout.location_id || locationId,
          location_name: locationName,
          reason: [payout.destination_type, payout.type].filter(Boolean).join(' ') || null,
        }));
      }

      locationStats.push({
        location_id: locationId,
        name: locationName,
        payments: payments.length,
        orders: orders.length,
        refunds: refunds.length,
        payouts: payouts.length,
      });
    }

    // Persist — upsert keyed on square_id, chunked
    const allEntries = Array.from(entries.values());
    let upserted = 0;
    let failedUpserts = 0;
    for (let i = 0; i < allEntries.length; i += UPSERT_CHUNK) {
      const chunk = allEntries.slice(i, i + UPSERT_CHUNK);
      try {
        await base44.asServiceRole.entities.SquareLedgerEntry.upsert(chunk, { key: 'square_id' });
        upserted += chunk.length;
      } catch (e: any) {
        // Fall back to per-record upsert so one bad record can't drop a whole chunk
        for (const record of chunk) {
          try {
            await base44.asServiceRole.entities.SquareLedgerEntry.upsert([record], { key: 'square_id' });
            upserted++;
          } catch (e2: any) {
            failedUpserts++;
            if (syncErrors.length < 10) syncErrors.push(`upsert(${record.square_id}): ${e2?.message || e2}`);
          }
        }
      }
      if (i % (UPSERT_CHUNK * 10) === 0) await sleep(100);
    }

    const result = {
      success: true,
      windowStart,
      windowEnd,
      locations: locationStats.length,
      locationStats,
      entriesFetched: allEntries.length,
      entriesUpserted: upserted,
      entriesFailed: failedUpserts,
      payoutsAvailable,
      codLinks: allEntries.filter((e) => e.delivery_id).length,
      durationMs: Date.now() - startedAt,
      errors: syncErrors.slice(0, 10),
    };

    console.log('[squareLedgerSync] complete:', JSON.stringify(result));
    return Response.json(result);
  } catch (error: any) {
    const status = Number(error?.status) || 500;
    console.error('[squareLedgerSync] failed:', error?.message || error);
    return Response.json({ success: false, error: error?.message || String(error) }, { status });
  }
});
