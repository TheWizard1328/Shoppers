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

const UPSERT_CHUNK = 50;
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

// ── Fee rules (owner, Oct 3 2026) ─────────────────────────────────────────────
// Interac/debit: $0.07 + 0.75%. Any credit card: 2.5% flat. KEYED credit
// (card number typed in, not tapped): 3.3% + $0.15 (owner rule added after the
// Oct 1 Callingwood $23.43 KEYED VISA sale carrying a $0.92 fee). Verified
// live against every Oct 1-3 sale in the ledger: all exact to the cent.
function expectedFeeCents(cardBrand: any, entryMethod: any, amountCents: number): number | null {
  const a = Math.round(Number(amountCents) || 0);
  if (a <= 0) return null;
  const brand = String(cardBrand || '').toUpperCase();
  const method = String(entryMethod || '').toUpperCase();
  if (brand === 'INTERAC') return 7 + Math.round(a * 0.0075);
  if (method === 'KEYED') return 15 + Math.round(a * 0.033);
  if (brand) return Math.round(a * 0.025);
  return null;
}

// ── Card settlement columns (owner revamp, Oct 3 2026) ─────────────────────────
// Every CARD sale now carries its full payout story in ONE row:
//   folder_cents  = round(amount x folder_rate)  (savings contribution)
//   loan_cents    = round(amount x loan_rate)    (loan repayment, per location)
//   settled_cents = amount - fee - folder - loan (net returned to the card)
// Owner-verified example (Oct 3, Callingwood, loan_rate 0.1825, folder 2%):
//   $8.62 sale, $0.13 fee -> folder $0.17, loan $1.57, settled $6.75.
// Rates come from AppSettings 'square_balances' (folder_rate + locations[].loan_rate).
async function loadBalanceRates(base44: any): Promise<{ folderRate: number; loanRateByLoc: Map<string, number> }> {
  const rates = { folderRate: 0.02, loanRateByLoc: new Map<string, number>() };
  try {
    const rows: any[] = (await base44.asServiceRole.entities.AppSettings.filter({ setting_key: 'square_balances' })) as any[];
    const cfg = rows?.[0]?.setting_value;
    if (Number.isFinite(Number(cfg?.folder_rate))) rates.folderRate = Number(cfg.folder_rate);
    for (const loc of (cfg?.locations || [])) {
      if (loc?.location_id && Number.isFinite(Number(loc?.loan_rate))) rates.loanRateByLoc.set(String(loc.location_id), Number(loc.loan_rate));
    }
  } catch { /* defaults hold */ }
  return rates;
}
function cardSettlementCents(rates: any, locId: any, amountCents: number, feeCents: number): { folder_cents: number; loan_cents: number; settled_cents: number } {
  const amount = Math.round(Number(amountCents) || 0);
  const fee = Math.round(Number(feeCents) || 0);
  const folder = Math.round(amount * rates.folderRate);
  const loan = Math.round(amount * (rates.loanRateByLoc.get(String(locId || '')) || 0));
  return { folder_cents: folder, loan_cents: loan, settled_cents: amount - fee - folder - loan };
}

function ledgerNormalizeText(v: any): string {
  return String(v || '').replace(/\s+/g, ' ').trim();
}
// Same format as the catalog items (formatItemName in squareAdminCore) so
// backfilled cod_item_name values match the names drivers see in Square.
function ledgerFormatItemName(deliveryDate: any, storeAbbreviation: any, patientName: any): string {
  const [, month, day] = String(deliveryDate || '').split('-');
  return `${(month || '00').padStart(2, '0')}/${(day || '00').padStart(2, '0')}(${ledgerNormalizeText(storeAbbreviation) || 'NA'})-${ledgerNormalizeText(patientName) || 'Unknown Patient'}`;
}

function buildEntry(base: Record<string, any>) {
  const entry: Record<string, any> = {
    square_id: base.square_id,
    entry_kind: base.entry_kind,
    tender_type: base.tender_type ?? null,
    sale_class: base.sale_class ?? null,
    amount_cents: toCents(base.amount_cents),
    fee_cents: toCents(base.fee_cents),
    folder_cents: base.folder_cents != null ? toCents(base.folder_cents) : null,
    loan_cents: base.loan_cents != null ? toCents(base.loan_cents) : null,
    settled_cents: base.settled_cents != null ? toCents(base.settled_cents) : null,
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

    const rates = await loadBalanceRates(base44);

    // ── LEDGER BACKFILL (owner revamp, Oct 3 2026) ─────────────────────────
    // One-time migration for the entry_kind rename + settlement columns.
    // Does NOT touch Square — it walks the existing SquareLedgerEntry table:
    //   sale     -> collected  (+ stamp folder/loan/settled on CARD sales)
    //   payout   -> card_spend
    //   decline/refund unchanged.
    // Rate-limited rows retry with 30s pauses (same posture as the persist
    // loop). Safe to re-run: renamed rows and already-stamped CARD sales are
    // skipped.
    // ── DATE STATS MODE (diagnostic, Oct 3 2026) ──────────────────────────────
    // Day-by-day counts per entry_kind (+ per-location payout coverage) so
    // gaps in the ledger are visible without pulling every row.
    if (payload?.dateStats) {
      const scanned: any[] = [];
      let skip = 0;
      for (let page = 0; page < 100; page++) {
        const rows: any[] = (await base44.asServiceRole.entities.SquareLedgerEntry.list('-occurred_at', 2000, skip)) as any[];
        const list = rows || [];
        scanned.push(...list);
        if (list.length < 2000) break;
        skip += 2000;
      }
      const dayKind = new Map<string, Map<string, number>>();
      const byLoc = Boolean(payload?.dateStatsByLocation);
      const kindRange = new Map<string, { min: string; max: string; n: number }>();
      const locKindRange = new Map<string, { min: string; max: string; n: number }>();
      const payoutLocRange = new Map<string, { min: string; max: string; n: number }>();
      for (const r of scanned) {
        const day = String(r?.occurred_at || '').slice(0, 10);
        if (!day) continue;
        const kind = byLoc
          ? `${String(r?.location_name || r?.location_id || '?')}|${String(r?.entry_kind || '?')}`
          : String(r?.entry_kind || '?');
        const m = dayKind.get(day) || new Map<string, number>();
        m.set(kind, (m.get(kind) || 0) + 1);
        dayKind.set(day, m);
        const kr = kindRange.get(kind) || { min: day, max: day, n: 0 };
        if (day < kr.min) kr.min = day;
        if (day > kr.max) kr.max = day;
        kr.n += 1;
        kindRange.set(kind, kr);
        const lk = `${String(r?.location_name || r?.location_id || '?')}|${kind}`;
        const lr = locKindRange.get(lk) || { min: day, max: day, n: 0 };
        if (day < lr.min) lr.min = day;
        if (day > lr.max) lr.max = day;
        lr.n += 1;
        locKindRange.set(lk, lr);
        if (kind === 'card_spend' || kind === 'payout') {
          const loc = String(r?.location_name || r?.location_id || '?');
          const lr = payoutLocRange.get(loc) || { min: day, max: day, n: 0 };
          if (day < lr.min) lr.min = day;
          if (day > lr.max) lr.max = day;
          lr.n += 1;
          payoutLocRange.set(loc, lr);
        }
      }
      const from = payload?.dateStatsFrom ? String(payload.dateStatsFrom) : null;
      const to = payload?.dateStatsTo ? String(payload.dateStatsTo) : null;
      const days = Array.from(dayKind.entries()).sort((a: any, b: any) => (a[0] < b[0] ? -1 : 1))
        .filter(([day]: any) => (!from || day >= from) && (!to || day <= to))
        .map(([day, m]: any) => ({ day, kinds: Object.fromEntries(m) }));
      return Response.json({
        success: true,
        total: scanned.length,
        kindRanges: Object.fromEntries(kindRange),
        locKindRanges: Object.fromEntries(locKindRange),
        payoutCoverageByLocation: Object.fromEntries(payoutLocRange),
        days,
      });
    }

    if (payload?.ledgerBackfill) {
      const scanned: any[] = [];
      let skip = 0;
      for (let page = 0; page < 100; page++) {
        const rows: any[] = (await base44.asServiceRole.entities.SquareLedgerEntry.list('-occurred_at', 2000, skip)) as any[];
        const list = rows || [];
        scanned.push(...list);
        if (list.length < 2000) break;
        skip += 2000;
      }
      const patches: { id: string; patch: any }[] = [];
      let renameSales = 0, renamePayouts = 0, stampSettlement = 0, stampClasses = 0;
      // sale_class evidence: business-card labels (owner-managed, AppSettings
      // 'square_card_labels') + the >=5-swipes-never-COD store-card heuristic
      // (same rule as SquareBalancesView). Everything else is other_sale.
      const businessFps = new Set<string>();
      try {
        const labelRows: any[] = (await base44.asServiceRole.entities.AppSettings.filter({ setting_key: 'square_card_labels' })) as any[];
        for (const l of (labelRows?.[0]?.setting_value?.labels || [])) {
          if (l?.fingerprint && l?.is_business_card) businessFps.add(String(l.fingerprint));
        }
      } catch { /* optional */ }
      // card_spend class comes ONLY from owner-managed business-card labels —
      // the 5-swipe heuristic proved unreliable for stamping (unlinked COD
      // sales look like store-card spends when the catalog link chain broke).
      for (const row of scanned) {
        if (!row?.id) continue;
        const kind = String(row.entry_kind || '');
        const patch: any = {};
        if (kind === 'sale') { patch.entry_kind = 'collected'; renameSales += 1; }
        else if (kind === 'payout') { patch.entry_kind = 'card_spend'; renamePayouts += 1; }
        const isSale = kind === 'sale' || kind === 'collected';
        const isCardSale = isSale
          && String(row.tender_type || '').toUpperCase() === 'CARD'
          && String(row.status || '').toUpperCase() === 'COMPLETED';
        if (isCardSale && row.settled_cents == null) {
          Object.assign(patch, cardSettlementCents(rates, row.location_id, row.amount_cents, row.fee_cents));
          stampSettlement += 1;
        }
        if (isSale) {
          const desired = row?.delivery_id ? 'cod_collection'
            : (row?.card_fingerprint && businessFps.has(String(row.card_fingerprint))) ? 'card_spend'
            : 'other_sale';
          // Self-correcting: re-stamp anything that doesn't match the desired
          // class EXCEPT an existing cod_collection stamp (authoritative).
          // This also reverts heuristic-era card_spend stamps.
          if (row.sale_class !== desired && row.sale_class !== 'cod_collection') {
            patch.sale_class = desired;
            stampClasses += 1;
          }
        }
        if (Object.keys(patch).length) patches.push({ id: row.id, patch });
      }
      let applied = 0, pending = patches.slice();
      for (let pass = 0; pass <= 3 && pending.length; pass++) {
        const nextPending: any[] = [];
        for (let i = 0; i < pending.length; i += 50) {
          const chunk = pending.slice(i, i + 50);
          const results = await Promise.allSettled(chunk.map((r: any) => base44.asServiceRole.entities.SquareLedgerEntry.update(r.id, r.patch)));
          results.forEach((res: any, idx: number) => {
            if (res.status === 'fulfilled') { applied += 1; return; }
            const msg = String(res.reason?.message || res.reason || '');
            if (/rate limit/i.test(msg) || res.reason?.status === 429) nextPending.push(chunk[idx]);
          });
          await sleep(150);
        }
        pending = nextPending;
        if (pending.length && pass < 3) await sleep(30000);
      }
      return Response.json({
        success: pending.length === 0,
        scanned: scanned.length,
        patchesNeeded: patches.length,
        patched: applied,
        failed: pending.length,
        renamedSales: renameSales,
        renamedPayouts: renamePayouts,
        settlementStamps: stampSettlement,
        saleClassStamps: stampClasses,
      });
    }

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
          // delivery_id is often null on catalog rows — recover it from the
          // description ("COD for <patient> | Delivery <id>")
          let deliveryId = item.delivery_id || null;
          if (!deliveryId) {
            const m = String(item.description || '').match(/Delivery\s+([A-Za-z0-9]{16,})/i);
            if (m) deliveryId = m[1];
          }
          catalogByObjectId.set(item.square_catalog_object_id, {
            delivery_id: deliveryId,
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
          entry_kind: 'collected',
          tender_type: 'CARD',
          sale_class: codLink ? 'cod_collection' : 'other_sale',
          amount_cents: payment?.amount_money?.amount,
          fee_cents: sumProcessingFees(payment),
          ...cardSettlementCents(rates, locationId, payment?.amount_money?.amount, sumProcessingFees(payment)),
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
            entry_kind: 'collected',
            tender_type: tender.type || 'OTHER',
            sale_class: codLink ? 'cod_collection' : 'other_sale',
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
          entry_kind: 'card_spend',
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

    // Persist — keyed on square_id: create new records, update existing ones.
    // (The functions runtime SDK has no .upsert(); use the proven list+create/update pattern.)
    //
    // DUPLICATE-SAFE SCAN (Oct 2 2026 owner report: "fee charged multiple
    // times per transaction"). A previous run's scan failed mid-rate-limit-
    // storm; its .catch(() => []) swallowed the error, the map stayed EMPTY,
    // and every entry in the window was re-CREATED as a duplicate — the SAME
    // swipe then counted TWICE in the card-balance math (amount once and its
    // fee once, per copy). Three changes:
    //   1. The scan now RETRIES and — if it still fails — ABORTS the persist
    //      phase with an error instead of blindly creating duplicates.
    //   2. Every run DEDUPES the table: square_ids with multiple rows lose
    //      their older copies (self-heals the existing duplicates).
    //   3. Same square_id can never be double-written by this run (Map keys).
    const allEntries = Array.from(entries.values());
    const existingIdBySquareId = new Map<string, string>();
    const existingRowsBySquareId = new Map<string, any[]>();
    let scanOk = false;
    let lastScanError: any = null;
    for (let attempt = 0; attempt < 3 && !scanOk; attempt++) {
      existingIdBySquareId.clear();
      existingRowsBySquareId.clear();
      try {
        let skip = 0;
        for (let page = 0; page < 50; page++) {
          const rows: any[] = (await base44.asServiceRole.entities.SquareLedgerEntry.list('-occurred_at', 2000, skip)) as any[];
          const list = rows || [];
          for (const r of list) {
            if (!r?.square_id) continue;
            if (!existingRowsBySquareId.has(r.square_id)) existingRowsBySquareId.set(r.square_id, []);
            existingRowsBySquareId.get(r.square_id)!.push(r);
          }
          if (list.length < 2000) break;
          skip += 2000;
        }
        scanOk = true;
      } catch (e: any) {
        lastScanError = e;
        syncErrors.push(`existingScan(attempt ${attempt + 1}): ${e?.message || e}`);
        await sleep(2000);
      }
    }
    if (!scanOk) {
      return Response.json({
        success: false,
        error: `existingScan failed after 3 attempts (${lastScanError?.message || lastScanError}) — persist phase aborted to avoid creating duplicate ledger rows. No entries were written.`,
        entriesFetched: allEntries.length,
        errors: syncErrors.slice(0, 10),
      }, { status: 503 });
    }
    // Dedupe existing rows per square_id (keep newest updated_date) and
    // register the survivor for the update path below.
    let duplicateRowsDeleted = 0;
    for (const [sqid, rows] of existingRowsBySquareId) {
      if (rows.length <= 1) {
        if (rows[0]?.id) existingIdBySquareId.set(sqid, rows[0].id);
        continue;
      }
      rows.sort((a: any, b: any) =>
        new Date(b?.updated_date || b?.created_date || 0).getTime() -
        new Date(a?.updated_date || a?.created_date || 0).getTime());
      if (rows[0]?.id) existingIdBySquareId.set(sqid, rows[0].id);
      for (let i = 1; i < rows.length; i++) {
        await base44.asServiceRole.entities.SquareLedgerEntry.delete(rows[i].id)
          .then(() => { duplicateRowsDeleted += 1; })
          .catch((e: any) => { if (syncErrors.length < 10) syncErrors.push(`dedupeDelete(${rows[i].id}): ${e?.message || e}`); });
      }
    }

    // ── COD LINK BACKFILL (Oct 3 2026 owner plan) ────────────────────────────
    // resolveCodLink only works when the order's line items carry the delivery's
    // catalog_object_id — manual/un-itemized rings and multi-COD swipes were
    // landing with delivery_id/patient_id/cod_item_name ALL null (owner report:
    // "they have been getting skipped lately"). This pass matches unlinked
    // completed CARD sales to completed delivery CODs by EXACT cents (single
    // swipe first, then subset-sum of 2-3 swipes for split payments — the
    // decline-then-partial pattern), scoped to the COD's store location and a
    // [completion−90min, completion+6h] ring window. Matched sales get
    // sale_class/delivery_id/patient_id/cod_item_name stamped; the delivery's
    // collection type syncs to the swiped card (INTERAC → Debit, else Credit);
    // and existing ledger rows missing links are repaired too, not just new
    // window entries.
    let backfillLinks = 0;
    let backfillRepairs = 0;
    let backfillTypeSyncs = 0;
    let backfillFeeChecks = 0;
    let backfillFeeMismatches = 0;
    const storeFingerprintCounts: any = {};
    try {
      // Reference data: stores (loc + abbreviation), catalog rows keyed by
      // delivery_id (item_name + patient_id), completed COD deliveries.
      const [storesRaw, cfgsRaw] = await Promise.all([
        base44.asServiceRole.entities.Store.list('-created_date', 2000).catch(() => []),
        base44.asServiceRole.entities.SquareLocationConfig.list('-updated_date', 500).catch(() => []),
      ]);
      const cfgLocById = new Map<string, string>();
      for (const c of cfgsRaw || []) if (c?.id && c?.square_location_id) cfgLocById.set(String(c.id), c.square_location_id);
      const storeToLoc = new Map<string, string>();
      const storeAbbrById = new Map<string, string>();
      for (const st of storesRaw || []) {
        if (!st?.id) continue;
        storeAbbrById.set(String(st.id), st?.abbreviation || null);
        const loc = st?.square_location_config_id ? cfgLocById.get(String(st.square_location_config_id)) : null;
        if (loc) storeToLoc.set(String(st.id), loc);
      }
      const catalogByDeliveryId = new Map<string, any>();
      for (const [, link] of catalogByObjectId) {
        if (link?.delivery_id && !catalogByDeliveryId.has(link.delivery_id)) catalogByDeliveryId.set(link.delivery_id, link);
      }

      // Completed deliveries with a COD requirement (bounded pages).
      type CodDelivery = { id: string; locId: string; cents: number; completedAt: number; date: string; patientId: any; patientName: string; abbr: string | null };
      const codDeliveries: CodDelivery[] = [];
      const backfillFloorMs = new Date(new Date(windowStart).getTime() - 3 * 86400000).getTime();
      for (let page = 0; page < 4; page++) {
        const rows: any[] = (await base44.asServiceRole.entities.Delivery.list('-created_date', 2000, page * 2000).catch(() => [])) as any[];
        const list = rows || [];
        for (const d of list) {
          if (d?.status !== 'completed' || d?.cod_confirmed_collected) continue;
          const required = Number(d?.cod_total_amount_required || 0);
          if (required <= 0) continue;
          const createdMs = new Date(d?.created_date || 0).getTime();
          if (Number.isFinite(createdMs) && createdMs < backfillFloorMs) continue;
          const locId = storeToLoc.get(String(d?.store_id || ''));
          if (!locId) continue;
          const completedAt = new Date(d?.actual_delivery_time || d?.updated_date || d?.created_date || 0).getTime();
          codDeliveries.push({
            id: String(d.id), locId, cents: Math.round(required * 100), completedAt,
            date: String(d?.delivery_date || ''), patientId: d?.patient_id || null,
            patientName: ledgerNormalizeText(d?.patient_name), abbr: storeAbbrById.get(String(d?.store_id || '')) || null,
          });
        }
        if (list.length < 2000) break;
        if (list.length && new Date(list[list.length - 1]?.created_date || 0).getTime() < backfillFloorMs) break;
      }

      // Unlinked completed CARD sales pool: current-window entries PLUS existing
      // ledger rows (window-independent repair). Declines are anchor evidence.
      type SaleCandidate = { key: string; existingId: string | null; cents: number; at: number; brand: string | null; method: string | null; fee: number; locId: string | null; cardFingerprint: string | null };
      const salePool: SaleCandidate[] = [];
      const declineAnchors: { cents: number; at: number; locId: string | null }[] = [];
      for (const e of allEntries) {
        if (e?.delivery_id) continue;
        const cents = Math.round(Number(e?.amount_cents || 0));
        const at = new Date(e?.occurred_at || 0).getTime();
        if (!Number.isFinite(at)) continue;
        if (e?.entry_kind === 'decline') { declineAnchors.push({ cents, at, locId: e?.location_id || null }); continue; }
        if (!['sale', 'collected'].includes(String(e?.entry_kind || '')) || String(e?.tender_type || '').toUpperCase() !== 'CARD') continue;
        if (String(e?.status || '').toUpperCase() !== 'COMPLETED') continue;
        if (e?.card_fingerprint) {
          const fk = `${e.location_id}:${e.card_fingerprint}`;
          storeFingerprintCounts[fk] = (storeFingerprintCounts[fk] || 0) + 1;
        }
        salePool.push({
          key: String(e.square_id), existingId: existingIdBySquareId.get(String(e.square_id)) || null,
          cents, at, brand: e?.card_brand || null, method: e?.entry_method || null,
          fee: Math.round(Number(e?.fee_cents || 0)), locId: e?.location_id || null, cardFingerprint: e?.card_fingerprint || null,
        });
      }
      for (const [sqid, rows] of existingRowsBySquareId) {
        if (entries.has(sqid)) continue;
        const e = rows[0];
        if (!e || e?.delivery_id) continue;
        const cents = Math.round(Number(e?.amount_cents || 0));
        const at = new Date(e?.occurred_at || 0).getTime();
        if (!Number.isFinite(at) || cents <= 0) continue;
        if (e?.entry_kind === 'decline') { declineAnchors.push({ cents, at, locId: e?.location_id || null }); continue; }
        if (!['sale', 'collected'].includes(String(e?.entry_kind || '')) || String(e?.tender_type || '').toUpperCase() !== 'CARD') continue;
        if (String(e?.status || '').toUpperCase() !== 'COMPLETED') continue;
        if (e?.card_fingerprint) {
          const fk = `${e.location_id}:${e.card_fingerprint}`;
          storeFingerprintCounts[fk] = (storeFingerprintCounts[fk] || 0) + 1;
        }
        salePool.push({
          key: String(e.square_id), existingId: e?.id || null,
          cents, at, brand: e?.card_brand || null, method: e?.entry_method || null,
          fee: Math.round(Number(e?.fee_cents || 0)), locId: e?.location_id || null, cardFingerprint: e?.card_fingerprint || null,
        });
      }

      // Store-card fingerprints (owner plan): a card swiped many times at one
      // location that never matches a COD is the store's own business card —
      // exclude its sales from COD matching.
      const storeCardFingerprints = new Set<string>();
      for (const [fk, n] of Object.entries(storeFingerprintCounts)) {
        if (Number(n) >= 5) storeCardFingerprints.add(fk.split(':')[1]);
      }

      const usedSaleKeys = new Set<string>();
      const WINDOW_BEFORE_MS = 90 * 60000;
      const WINDOW_AFTER_MS = 6 * 3600000;
      const subsetSumMatch = (pool: SaleCandidate[], target: number): SaleCandidate[] | null => {
        const avail = pool.filter((x) => !usedSaleKeys.has(x.key));
        for (const one of avail) if (one.cents === target) return [one];
        for (let i = 0; i < avail.length; i++) {
          for (let j = i + 1; j < avail.length; j++) {
            if (avail[i].cents + avail[j].cents === target) return [avail[i], avail[j]];
            for (let k = j + 1; k < avail.length; k++) {
              if (avail[i].cents + avail[j].cents + avail[k].cents === target) return [avail[i], avail[j], avail[k]];
            }
          }
        }
        return null;
      };

      for (const d of codDeliveries) {
        const pool = salePool.filter((x) =>
          x.locId === d.locId && !usedSaleKeys.has(x.key) &&
          !(x.cardFingerprint && storeCardFingerprints.has(x.cardFingerprint)) &&
          x.at >= d.completedAt - WINDOW_BEFORE_MS && x.at <= d.completedAt + WINDOW_AFTER_MS
        );
        if (!pool.length) continue;
        // Prefer pool members whose ring follows a decline of the same amount
        // (owner: declined full-COD swipe, then successful parts that sum to it).
        const anchored = pool.filter((x) => declineAnchors.some((a) => a.locId === d.locId && a.cents === d.cents && a.at >= d.completedAt - WINDOW_BEFORE_MS && a.at <= x.at));
        const match = subsetSumMatch(anchored.length ? anchored : pool, d.cents);
        if (!match) continue;
        const catalogLink = catalogByDeliveryId.get(d.id);
        const patientId = catalogLink?.patient_id || d.patientId || null;
        const itemName = catalogLink?.item_name || ledgerFormatItemName(d.date, d.abbr, d.patientName);
        const codType = String(match[0].brand || '').toUpperCase() === 'INTERAC' ? 'Debit' : 'Credit';
        for (const m of match) {
          usedSaleKeys.add(m.key);
          const stamp = { sale_class: 'cod_collection', delivery_id: d.id, patient_id: patientId, cod_item_name: itemName };
          if (m.existingId && !entries.has(m.key)) {
            await base44.asServiceRole.entities.SquareLedgerEntry.update(m.existingId, stamp).then(() => { backfillRepairs += 1; }).catch(() => {});
          } else {
            const rec = entries.get(m.key);
            if (rec) Object.assign(rec, stamp);
            backfillLinks += 1;
          }
          const expected = expectedFeeCents(m.brand, m.method, m.cents);
          if (expected != null) { backfillFeeChecks += 1; if (Math.abs(expected - m.fee) > 2) backfillFeeMismatches += 1; }
        }
        // Collection type sync (owner rule Oct 3): the swiped card is the
        // authority — INTERAC = Debit, any credit = Credit.
        try {
          const del: any = await base44.asServiceRole.entities.Delivery.get(d.id).catch(() => null);
          const payments = Array.isArray(del?.cod_payments) ? del.cod_payments : [];
          const centsOf = (n: any) => Math.round(Number(n || 0) * 100);
          let updated = false;
          let nextPayments = payments.map((p: any) => ({ ...p }));
          const exactIdx = nextPayments.findIndex((p: any) => centsOf(p?.amount) === d.cents);
          if (exactIdx >= 0) {
            if (nextPayments[exactIdx]?.type !== codType) { nextPayments[exactIdx] = { ...nextPayments[exactIdx], type: codType }; updated = true; }
          } else if (nextPayments.length === 1) {
            if (nextPayments[0]?.type !== codType) { nextPayments[0] = { ...nextPayments[0], type: codType }; updated = true; }
          } else {
            nextPayments = [...nextPayments, { type: codType, amount: d.cents / 100 }];
            updated = true;
          }
          if (updated || !del?.cod_confirmed_collected) {
            await base44.asServiceRole.entities.Delivery.update(d.id, {
              ...(updated ? { cod_payments: nextPayments } : {}),
              cod_confirmed_collected: true,
              cod_confirmed_collected_at: new Date().toISOString(),
            }).then(() => { backfillTypeSyncs += 1; }).catch(() => {});
          }
        } catch { /* non-fatal */ }
      }
    } catch (e: any) {
      syncErrors.push(`backfill: ${e?.message || e}`);
    }

    let upserted = 0;
    let failedUpserts = 0;
    // RATE-LIMIT-AWARE UPSERT (Oct 3 2026): a large backfill window (e.g. a
    // 2-year history import) writes thousands of rows and exhausts the entity
    // API's per-minute quota mid-loop — previously those rows were silently
    // dropped. Writes now run in small sequential chunks, and any chunk that
    // hits "Rate limit" pauses 30s and retries (up to 2 extra passes), so a
    // big window self-heals instead of losing rows. Normal 10-minute windows
    // never hit this path.
    const persistOne = async (record: any): Promise<boolean> => {
      const existingId = existingIdBySquareId.get(record.square_id);
      if (existingId) {
        // Never wipe a previously stamped COD link when this run's rebuild
        // failed to resolve it (e.g. catalog item since deleted).
        const exRow = existingRowsBySquareId.get(record.square_id)?.[0];
        const merged = exRow ? {
          ...record,
          sale_class: record.sale_class || exRow.sale_class || null,
          delivery_id: record.delivery_id || exRow.delivery_id || null,
          patient_id: record.patient_id || exRow.patient_id || null,
          cod_item_name: record.cod_item_name || exRow.cod_item_name || null,
        } : record;
        return base44.asServiceRole.entities.SquareLedgerEntry.update(existingId, merged).then(() => true).catch((e: any) => { throw e; });
      }
      return base44.asServiceRole.entities.SquareLedgerEntry.create(record).then(() => true).catch((e: any) => { throw e; });
    };
    let pending = allEntries.slice();
    for (let pass = 0; pass <= 2 && pending.length; pass++) {
      let nextPending: any[] = [];
      for (let i = 0; i < pending.length; i += UPSERT_CHUNK) {
        const chunk = pending.slice(i, i + UPSERT_CHUNK);
        const settled = await Promise.allSettled(chunk.map((r: any) => persistOne(r)));
        let chunkRateLimited = false;
        settled.forEach((res: any, idx: number) => {
          if (res.status === 'fulfilled') { upserted += 1; return; }
          const record = chunk[idx];
          const msg = String(res.reason?.message || res.reason || '');
          if (/rate limit/i.test(msg)) {
            chunkRateLimited = true;
            nextPending.push(record);
          } else if (syncErrors.length < 10) {
            syncErrors.push(`${existingIdBySquareId.get(record.square_id) ? 'update' : 'create'}(${record.square_id}): ${msg}`);
          }
        });
        failedUpserts += chunkRateLimited && pass < 2 ? 0 : nextPending.length;
        await sleep(100);
      }
      if (nextPending.length && pass < 2) {
        console.log(`[squareLedgerSync] rate-limited on ${nextPending.length} rows — waiting 30s before retry pass ${pass + 2}`);
        await sleep(30000);
        pending = nextPending;
      } else {
        failedUpserts = nextPending.length ? nextPending.length : 0;
        break;
      }
    }
    failedUpserts = Math.max(0, failedUpserts);

    // ── COD outstanding pass (card balance estimates, Oct 2026 owner spec) ──
    // A COD delivery subtracts its amount from the store's card balance while
    // pending/in_transit. Debit/Credit/Cheque collections lift it immediately;
    // Cash collections lift only once a matching COMPLETED Square order is in
    // the ledger — this pass IS the "regularly verify cash CODs" check (runs on
    // every balances page open, Refresh, and the 9pm briefing).
    const codOutstanding: any[] = [];
    let stampedConfirmations = 0;
    if (payload?.includeCodOutstanding) {
      try {
        const [storesRaw, allCfgRaw] = await Promise.all([
          base44.asServiceRole.entities.Store.list('-created_date', 2000).catch(() => []),
          base44.asServiceRole.entities.SquareLocationConfig.list('-updated_date', 500).catch(() => []),
        ]);
        const cfgLocById = new Map<string, string>();
        for (const c of allCfgRaw || []) if (c?.id && c?.square_location_id) cfgLocById.set(c.id, c.square_location_id);
        const storeToLoc = new Map<string, string>();
        for (const s of storesRaw || []) {
          const loc = s?.square_location_config_id ? cfgLocById.get(s.square_location_config_id) : null;
          if (s?.id && loc) storeToLoc.set(String(s.id), loc);
        }

        // Ledger evidence: delivery_ids with a COMPLETED cod_collection sale (any tender)
        const codSalesRaw: any[] = (await base44.asServiceRole.entities.SquareLedgerEntry.filter({ sale_class: 'cod_collection' }).catch(() => [])) as any[] || [];
        const confirmedByLedger = new Set<string>(
          (codSalesRaw || []).filter((e: any) => e?.delivery_id && String(e?.status || '').toUpperCase() === 'COMPLETED').map((e: any) => String(e.delivery_id))
        );

        // Owner rule (Oct 1 2026): CODs outstanding at true-up are ALREADY baked into
        // the starting balances — only deliveries DATED on/after the true-up day
        // count as CODs out. Past-dated COD deliveries are already accounted for.
        let cutoffDate = '';
        try {
          const cfgRows: any[] = ((await base44.asServiceRole.entities.AppSettings.filter({ setting_key: 'square_balances' }).catch(() => [])) as any[]) || [];
          const tu = (cfgRows || [])[0]?.setting_value?.trued_up_at;
          if (tu) cutoffDate = new Date(new Date(tu).getTime() - 6 * 3600000).toISOString().slice(0, 10); // Edmonton (UTC-6) date of the true-up
        } catch { /* fall through */ }
        if (payload?.codCutoffDate) cutoffDate = String(payload.codCutoffDate);
        if (!cutoffDate) cutoffDate = new Date(Date.now() - 6 * 3600000).toISOString().slice(0, 10);
        // Pagination stop: deliveries are staged at most a few days ahead, so
        // stop walking created_date-descending pages a few days before the cutoff.
        const createdFloor = new Date(new Date(cutoffDate + 'T00:00:00Z').getTime() - 3 * 86400000).getTime();
        const isCounted = (d: any) => String(d?.delivery_date || '') >= cutoffDate;
        const centsOf = (n: any) => Math.round(Number(n || 0) * 100);

        type Agg = { total: number; pendingTotal: number; pendingCount: number; awaitingTotal: number; awaitingCount: number; items: any[] };
        const byLoc = new Map<string, Agg>();
        const aggFor = (locId: string): Agg => {
          if (!byLoc.has(locId)) byLoc.set(locId, { total: 0, pendingTotal: 0, pendingCount: 0, awaitingTotal: 0, awaitingCount: 0, items: [] });
          return byLoc.get(locId)!;
        };

        // a) Pending / in-transit CODs — subtract the required amount minus any
        //    debit/credit/cheque already collected against it (cash never lifts
        //    at this stage).
        for (const status of ['pending', 'in_transit', 'en_route']) {
          let rows: any[] = [];
          try { rows = ((await base44.asServiceRole.entities.Delivery.filter({ status })) as any[]) || []; } catch { rows = []; }
          for (const d of rows) {
            const required = Number(d?.cod_total_amount_required || 0);
            if (required <= 0 || !isCounted(d) || d?.cod_confirmed_collected) continue;
            const locId = storeToLoc.get(String(d?.store_id || ''));
            if (!locId) continue;
            const payments = Array.isArray(d?.cod_payments) ? d.cod_payments : [];
            const nonCash = payments.filter((p: any) => String(p?.type || '').toLowerCase() !== 'cash').reduce((s: number, p: any) => s + centsOf(p?.amount), 0);
            const outstanding = Math.max(0, centsOf(required) - nonCash);
            if (outstanding <= 0) continue;
            const agg = aggFor(locId);
            agg.total += outstanding; agg.pendingTotal += outstanding; agg.pendingCount += 1;
            agg.items.push({ delivery_id: d.id, status, patient: d.patient_name || null, amount: outstanding / 100, reason: 'pending_or_in_transit' });
          }
        }

        // b) Completed cash CODs awaiting Square registration — stay subtracted
        //    until the ledger shows the completed Square order; then stamp the
        //    delivery's collection authority (same semantics as the Square COD
        //    sync's confirmation stamp).
        for (let page = 0; page < 4; page++) {
          const rows = await base44.asServiceRole.entities.Delivery.list('-created_date', 2000, page * 2000).catch(() => []);
          const list: any[] = rows || [];
          for (const d of list) {
            if (d?.status !== 'completed' || d?.cod_confirmed_collected || !isCounted(d)) continue;
            const payments = Array.isArray(d?.cod_payments) ? d.cod_payments : [];
            const cash = payments.filter((p: any) => String(p?.type || '').toLowerCase() === 'cash').reduce((s: number, p: any) => s + centsOf(p?.amount), 0);
            if (cash <= 0) continue;
            const locId = storeToLoc.get(String(d?.store_id || ''));
            if (!locId) continue;
            if (confirmedByLedger.has(String(d.id))) {
              await base44.asServiceRole.entities.Delivery.update(String(d.id), {
                cod_confirmed_collected: true,
                cod_confirmed_collected_at: new Date().toISOString(),
              }).then(() => { stampedConfirmations += 1; }).catch(() => {});
              continue;
            }
            const agg = aggFor(locId);
            agg.total += cash; agg.awaitingTotal += cash; agg.awaitingCount += 1;
            agg.items.push({ delivery_id: d.id, status: 'completed', patient: d.patient_name || null, amount: cash / 100, reason: 'cash_awaiting_square' });
          }
          if (list.length < 2000) break;
          if (list.length && new Date(list[list.length - 1]?.created_date || 0).getTime() < createdFloor) break;
        }

        for (const [location_id, agg] of byLoc) {
          codOutstanding.push({
            location_id,
            cutoff_date: cutoffDate,
            total: agg.total / 100,
            pending_total: agg.pendingTotal / 100,
            pending_count: agg.pendingCount,
            awaiting_square_total: agg.awaitingTotal / 100,
            awaiting_square_count: agg.awaitingCount,
            items: agg.items.slice(0, 25),
          });
        }
      } catch (e: any) {
        syncErrors.push(`codOutstanding: ${e?.message || e}`);
      }
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
      duplicateRowsDeleted,
      payoutsAvailable,
      codLinks: allEntries.filter((e) => e.delivery_id).length,
      backfillLinks,
      backfillRepairs,
      backfillTypeSyncs,
      backfillFeeChecks,
      backfillFeeMismatches,
      codOutstanding,
      stampedConfirmations,
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
