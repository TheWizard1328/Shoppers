// Square finance-audit ledger sync.
// Backfills and refreshes SquareLedgerEntry records from the live Square account:
//   - /v2/payments      -> card sales (incl. business Square Card spends) + declines (FAILED)
//   - /v2/orders/search -> cash tenders + COD delivery links (catalog item matching)
//   - /v2/refunds       -> refunds, linked back to their originating payment
//   - /v2/payouts       -> (removed Oct 4 2026 — sweeps derived from settled_cents)
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

// MULTI-COD ORDER SPLIT (owner report Oct 7 2026): a single Square order can
// group several COD catalog items into ONE payment (e.g. a $4.53 COD and a
// $23.60 COD swiped together as one $28.13 transaction). resolveCodLink only
// ever returned the FIRST match, so the ledger entry (and its delivery_id
// link) represented just one of the two deliveries — the other delivery
// never got a matching ledger row and could never be auto-confirmed. This
// returns EVERY distinct COD line item in the order, each with its own
// money amount, so the caller can emit one ledger entry per delivery.
// Matching is by catalog_object_id FIRST, then by line-item NAME (the
// object-id link chain is often broken in Square — owner reports going back
// to Oct 3; the POS still carries the item's name, e.g.
// "10/06(MD)-Steve Magega", which is exactly the catalog item_name format).
function normalizeCatalogName(v: any): string {
  return String(v || '').replace(/\s+/g, '').toLowerCase();
}
function resolveCodLineItems(order: any, catalogByObjectId: Map<string, any>, catalogByName?: Map<string, any> | null) {
  const seenDeliveryIds = new Set<string>();
  const out: any[] = [];
  for (const li of order?.line_items || []) {
    let link = li?.catalog_object_id ? catalogByObjectId.get(li.catalog_object_id) : null;
    if (!link && catalogByName && li?.name) link = catalogByName.get(normalizeCatalogName(li.name)) || null;
    if (!link) continue;
    const dedupeKey = link.delivery_id ? String(link.delivery_id) : `obj:${li.catalog_object_id || li.name}`;
    if (seenDeliveryIds.has(dedupeKey)) continue;
    seenDeliveryIds.add(dedupeKey);
    const amount = Math.round(Number(li?.total_money?.amount ?? (Number(li?.base_price_money?.amount || 0) * Number(li?.quantity || 1))) || 0);
    out.push({ ...link, catalogObjectId: li.catalog_object_id || null, amountCents: amount });
  }
  return out;
}

// Delivery-side confirmation stamp shared by the exact-match backfill and the
// multi-item ring split pass: card brand is the authority for the collection
// type (INTERAC = Debit, any credit = Credit), and the delivery is marked
// cod_confirmed_collected. Returns true when a write happened.
async function confirmCodDeliveryWithCard(base44: any, deliveryId: string, codType: string, cents: number): Promise<boolean> {
  try {
    const del: any = await base44.asServiceRole.entities.Delivery.get(deliveryId).catch(() => null);
    const payments = Array.isArray(del?.cod_payments) ? del.cod_payments : [];
    const centsOf = (n: any) => Math.round(Number(n || 0) * 100);
    let updated = false;
    let nextPayments = payments.map((p: any) => ({ ...p }));
    const exactIdx = nextPayments.findIndex((p: any) => centsOf(p?.amount) === cents);
    if (exactIdx >= 0) {
      if (nextPayments[exactIdx]?.type !== codType) { nextPayments[exactIdx] = { ...nextPayments[exactIdx], type: codType }; updated = true; }
    } else if (nextPayments.length === 1) {
      if (nextPayments[0]?.type !== codType) { nextPayments[0] = { ...nextPayments[0], type: codType }; updated = true; }
    } else {
      nextPayments = [...nextPayments, { type: codType, amount: cents / 100 }];
      updated = true;
    }
    if (updated || !del?.cod_confirmed_collected) {
      await base44.asServiceRole.entities.Delivery.update(deliveryId, {
        ...(updated ? { cod_payments: nextPayments } : {}),
        cod_confirmed_collected: true,
        cod_confirmed_collected_at: new Date().toISOString(),
      });
      return true;
    }
  } catch { /* non-fatal */ }
  return false;
}

// Splits a full payment's amount/fee/folder/loan across its matched COD line
// items in proportion to each item's own money (remainder cents go to the
// last split so the parts always sum exactly to the whole — no money
// created or lost). Returns [] when there is nothing to split.
function splitPaymentAcrossCodLinks(codLinks: any[], fullAmountCents: number, fullFeeCents: number) {
  const lineTotal = codLinks.reduce((s, l) => s + Math.max(0, l.amountCents || 0), 0);
  if (lineTotal <= 0) return [];
  const full = Math.round(Number(fullAmountCents) || 0);
  const fee = Math.round(Number(fullFeeCents) || 0);
  let amountLeft = full;
  let feeLeft = fee;
  const parts = codLinks.map((link, idx) => {
    const isLast = idx === codLinks.length - 1;
    const share = Math.max(0, link.amountCents || 0) / lineTotal;
    const amount = isLast ? amountLeft : Math.round(full * share);
    const feePart = isLast ? feeLeft : Math.round(fee * share);
    amountLeft -= amount;
    feeLeft -= feePart;
    return { ...link, amountCents: amount, feeCents: feePart };
  });
  return parts;
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
  // Folder: Square TRUNCATES the per-sale contribution (owner-verified
  // Oct 4 2026: $87.33 x 2% = 174.66, Square moved 174) — never round up.
  const folder = Math.floor(amount * rates.folderRate);
  // Loan: ROUNDED to the nearest cent (owner spec Oct 6 2026 — truncation
  // left loan fees/settled off by $0.01, e.g. $18.37 x 0.1725 = 316.88c
  // truncated to $3.16 instead of $3.17; $14.47 x 0.1725 = 249.61c truncated
  // to $2.49 instead of $2.50).
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
    attributed_location_id: base.attributed_location_id ?? null,
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

    // ONE-OFF DIAGNOSTIC (Oct 6 2026): list Square ORDERS with tenders
    // across all configured locations, plus account-wide payments, so we can
    // see exactly how each COD catalog item was rung up (card vs cash vs
    // never-rung) and whether the amounts the owner sees in the Square app's
    // card feed exist as real payments ANYWHERE in the account.
    if (payload?.debugOrders === true) {
      const days = Number(payload.days || 10);
      const since = new Date(Date.now() - days * 86400000).toISOString();
      const cfgs = await base44.entities.SquareLocationConfig.list('-updated_date', 100).catch(() => []);
      const locIds = Array.from(new Set((cfgs || []).map((c) => c?.square_location_id).filter(Boolean)));
      const allOrders = [];
      for (const locId of locIds) {
        let cursor;
        let pages = 0;
        do {
          const r = await fetch('https://connect.squareup.com/v2/orders/search', {
            method: 'POST',
            headers: { Authorization: `Bearer ${accessToken}`, 'Square-Version': '2025-01-23', 'Content-Type': 'application/json' },
            body: JSON.stringify({
              location_ids: [locId],
              query: { filter: { date_time_filter: { created_at: { start_at: since } } }, sort: { sort_field: 'CREATED_AT', sort_order: 'DESC' } },
              limit: 50,
              ...(cursor ? { cursor } : {}),
            }),
          });
          const j = await r.json().catch(() => ({}));
          if (j?.errors) return Response.json({ error: j.errors, locId }, { status: 500 });
          allOrders.push(...(j.orders || []).map((o) => ({
            id: o.id, state: o.state, created_at: o.created_at, location_id: o.location_id,
            total_cents: o.total_money?.amount,
            line_items: (o.line_items || []).map((li) => ({ name: li.name, qty: li.quantity, base_cents: li.base_price_money?.amount, catalog_object_id: li.catalog_object_id })),
            tenders: (o.tenders || []).map((t) => ({ id: t.id, type: t.type, amount_cents: t.amount_money?.amount, card_brand: t.card_details?.card?.card_brand, last4: t.card_details?.card?.last_4, entry: t.card_details?.entry_method })),
            refunds: (o.refunds || []).map((rf) => ({ id: rf.id, state: rf.state, amount_cents: rf.amount_money?.amount })),
          })));
          cursor = j.cursor;
          pages++;
        } while (cursor && pages < 8);
      }
      let payments = null;
      if (payload.includePayments === true) {
        const pOut = [];
        let pCursor;
        let pPages = 0;
        do {
          const url = `https://connect.squareup.com/v2/payments?begin_time=${encodeURIComponent(since)}&sort_order=DESC&limit=100${pCursor ? `&cursor=${encodeURIComponent(pCursor)}` : ''}`;
          const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}`, 'Square-Version': '2025-01-23' } });
          const j = await r.json().catch(() => ({}));
          if (j?.errors) return Response.json({ error: j.errors, paymentsPhase: true }, { status: 500 });
          pOut.push(...(j.payments || []));
          pCursor = j.cursor;
          pPages++;
        } while (pCursor && pPages < 10);
        payments = pOut.map((p) => ({ id: p.id, status: p.status, amount_cents: p.amount_money?.amount, location_id: p.location_id, order_id: p.order_id, created_at: p.created_at, card_brand: p.card_details?.card?.card_brand, last4: p.card_details?.card?.last_4, entry: p.card_details?.entry_method, source_type: p.source_type, note: p.note }));
      }
      // Optional server-side amount filter so the response stays small
      const amtFilter = Array.isArray(payload.amountFilter) ? payload.amountFilter.map((n) => Math.round(Number(n))) : null;
      const amtMatch = (cents) => !!amtFilter && amtFilter.includes(Math.round(Number(cents)));
      const filteredOrders = amtFilter
        ? allOrders.filter((o) => amtMatch(o.total_cents) || (o.tenders || []).some((t) => amtMatch(t.amount_cents)) || (o.line_items || []).some((li) => amtMatch(li.base_cents)))
        : allOrders;
      const filteredPayments = amtFilter && Array.isArray(payments) ? payments.filter((p) => amtMatch(p.amount_cents)) : payments;
      return Response.json({ since, locations: locIds, orderCount: allOrders.length, orderMatches: filteredOrders.length, orders: filteredOrders, payments: filteredPayments });
    }

    // ONE-OFF DIAGNOSTIC (Oct 6 2026): probe every Square endpoint that
    // could expose the Square CARD / Square Checking activity feed (the
    // negative "Card spend" entries the owner sees in the Square app).
    // Records status codes + first bytes so we know definitively what the
    // API surface offers.
    if (payload?.probeEndpoints === true) {
      const tryGet = async (label, url) => {
        try {
          const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}`, 'Square-Version': '2025-01-23' } });
          const text = await r.text();
          return { label, status: r.status, body: text.slice(0, 900) };
        } catch (e) {
          return { label, error: String(e).slice(0, 200) };
        }
      };
      const results = [];
      results.push(await tryGet('list_wallets', 'https://connect.squareup.com/v2/wallets'));
      results.push(await tryGet('list_cards', 'https://connect.squareup.com/v2/cards'));
      const bankRaw = await fetch('https://connect.squareup.com/v2/bank-accounts', { headers: { Authorization: `Bearer ${accessToken}`, 'Square-Version': '2025-01-23' } });
      const bankJson = await bankRaw.json().catch(() => ({}));
      results.push({ label: 'list_bank_accounts', status: bankRaw.status, ids: (bankJson.bank_accounts || []).map((b) => ({ id: b.id, name: b.bank_account_name, type: b.type, status: b.status })) });
      for (const b of (bankJson.bank_accounts || []).slice(0, 2)) {
        results.push(await tryGet(`bank_txns_${b.id}`, `https://connect.squareup.com/v2/bank-accounts/${b.id}/transactions`));
      }
      const cardsRaw = await fetch('https://connect.squareup.com/v2/cards', { headers: { Authorization: `Bearer ${accessToken}`, 'Square-Version': '2025-01-23' } });
      const cardsJson = await cardsRaw.json().catch(() => ({}));
      for (const c of (cardsJson.cards || []).slice(0, 2)) {
        results.push(await tryGet(`card_${c.id}`, `https://connect.squareup.com/v2/cards/${c.id}/transactions`));
        results.push(await tryGet(`card_${c.id}_details`, `https://connect.squareup.com/v2/cards/${c.id}`));
      }
      results.push(await tryGet('payments_v1', 'https://connect.squareup.com/v1/me/payments'));
      return Response.json({ results });
    }

    // ONE-OFF DIAGNOSTIC (Oct 6 2026): check Square's raw /v2/payments for
    // PENDING/APPROVED statuses specifically (not just COMPLETED/FAILED),
    // across all locations, to confirm whether the owner's "Pending" card
    // spend entries (e.g. Elaine Ash 49.98) actually exist there.
    if (payload?.probePending === true) {
      const days = Number(payload.days || 10);
      const since = new Date(Date.now() - days * 86400000).toISOString();
      const cfgs = await base44.entities.SquareLocationConfig.list('-updated_date', 100).catch(() => []);
      const locIds = Array.from(new Set((cfgs || []).map((c) => c?.square_location_id).filter(Boolean)));
      const allPending = [];
      const statusCounts = {};
      for (const locId of locIds) {
        let cursor;
        let pages = 0;
        do {
          const url = `https://connect.squareup.com/v2/payments?location_id=${encodeURIComponent(locId)}&begin_time=${encodeURIComponent(since)}&sort_order=DESC&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
          const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}`, 'Square-Version': '2025-01-23' } });
          const j = await r.json().catch(() => ({}));
          if (j?.errors) return Response.json({ error: j.errors, locId }, { status: 500 });
          for (const p of (j.payments || [])) {
            const st = String(p.status || 'UNKNOWN');
            statusCounts[st] = (statusCounts[st] || 0) + 1;
            if (st !== 'COMPLETED' && st !== 'FAILED') {
              allPending.push({ id: p.id, status: p.status, amount_cents: p.amount_money?.amount, location_id: p.location_id, created_at: p.created_at, card_brand: p.card_details?.card?.card_brand, last4: p.card_details?.card?.last_4, note: p.note });
            }
          }
          cursor = j.cursor;
          pages++;
        } while (cursor && pages < 5);
      }
      // Also check /v2/payouts for PENDING/IN_PROGRESS statuses (store card
      // top-ups/withdrawals use this endpoint, not /v2/payments).
      const payoutStatusCounts = {};
      const pendingPayouts = [];
      for (const locId of locIds) {
        let cursor;
        let pages = 0;
        do {
          const url = `https://connect.squareup.com/v2/payouts?location_id=${encodeURIComponent(locId)}&begin_time=${encodeURIComponent(since)}&sort_order=DESC&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
          const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}`, 'Square-Version': '2025-01-23' } });
          const j = await r.json().catch(() => ({}));
          if (j?.errors) { payoutStatusCounts.__error = j.errors; break; }
          for (const po of (j.payouts || [])) {
            const st = String(po.status || 'UNKNOWN');
            payoutStatusCounts[st] = (payoutStatusCounts[st] || 0) + 1;
            if (st !== 'PAID' && st !== 'FAILED' && st !== 'CANCELLED') {
              pendingPayouts.push({ id: po.id, status: po.status, amount_cents: po.amount_money?.amount, type: po.type, location_id: po.location_id, created_at: po.created_at, destination_type: po.destination?.type });
            }
          }
          cursor = j.cursor;
          pages++;
        } while (cursor && pages < 5);
      }
      return Response.json({ since, locations: locIds, statusCounts, pendingOrApprovedCount: allPending.length, pendingOrApproved: allPending, payoutStatusCounts, pendingPayoutsCount: pendingPayouts.length, pendingPayouts });
    }

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
      let renameSales = 0, deletedPayouts = 0, stampSettlement = 0, stampClasses = 0;
      const payoutDeleteIds: string[] = [];
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
      const saleFeeBySquareId = new Map<string, any>();
      for (const r of scanned) {
        const k = String(r?.entry_kind || '');
        if ((k === 'sale' || k === 'collected') && r?.square_id && r?.fee_cents != null) {
          if (!saleFeeBySquareId.has(String(r.square_id))) saleFeeBySquareId.set(String(r.square_id), r.fee_cents);
        }
      }
      let stampedTopupFees = 0;
      for (const row of scanned) {
        if (!row?.id) continue;
        const kind = String(row.entry_kind || '');
        const patch: any = {};
        if (kind === 'card_topup' && row.fee_cents == null) {
          const tokens = String(row.reason || '').split(' | ').filter(Boolean);
          const srcId = tokens.length ? tokens[tokens.length - 1] : '';
          const fee = srcId ? saleFeeBySquareId.get(srcId) : undefined;
          if (fee != null) { patch.fee_cents = fee; stampedTopupFees += 1; }
        }
        if (kind === 'sale') { patch.entry_kind = 'collected'; renameSales += 1; }
        else if (kind === 'payout' || kind === 'card_spend') { payoutDeleteIds.push(row.id); }
        const isSale = kind === 'sale' || kind === 'collected';
        const isCardSale = isSale
          && String(row.tender_type || '').toUpperCase() === 'CARD'
          && String(row.status || '').toUpperCase() === 'COMPLETED';
        if (isCardSale && row.settled_cents == null) {
          Object.assign(patch, cardSettlementCents(rates, row.location_id, row.amount_cents, row.fee_cents));
          stampSettlement += 1;
        } else if (isCardSale) {
          // Round-up era repair: rows stamped with the old Math.round formula
          // can carry a folder/loan cent too high (e.g. 175 vs Square's real
          // 174). Recompute ONLY when the stored value matches the old
          // round() result and differs from the truncated one, so rows whose
          // cents came from any other source are left untouched.
          const amt = Math.round(Number(row.amount_cents) || 0);
          const fee = Math.round(Number(row.fee_cents) || 0);
          const recomputed = cardSettlementCents(rates, row.location_id, amt, fee);
          // Era 1 (round-everything) folders are one cent high — floor them.
          const oldFolder = Math.round(amt * rates.folderRate);
          // Era 2 (floor-everything) loans are one cent LOW (owner report
          // Oct 6 2026) — lift them to the new rounded-loan spec.
          const oldLoan = Math.floor(amt * (rates.loanRateByLoc.get(String(row.location_id || '')) || 0));
          const storedFolder = Number(row.folder_cents);
          const storedLoan = Number(row.loan_cents);
          if (storedFolder === oldFolder && oldFolder !== recomputed.folder_cents) {
            patch.folder_cents = recomputed.folder_cents;
            patch.settled_cents = recomputed.settled_cents;
            stampSettlement += 1;
          } else if (storedLoan === oldLoan && oldLoan !== recomputed.loan_cents) {
            patch.loan_cents = recomputed.loan_cents;
            patch.settled_cents = recomputed.settled_cents;
            stampSettlement += 1;
          }
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
      // Payout-kind rows (payout / card_spend) are redundant duplicates of
      // folder_cents + settled_cents on their collected sale rows — delete
      // them outright (owner rule Oct 4 2026).
      for (let i = 0; i < payoutDeleteIds.length; i += 50) {
        const chunkIds = payoutDeleteIds.slice(i, i + 50);
        const results = await Promise.allSettled(chunkIds.map((id) => base44.asServiceRole.entities.SquareLedgerEntry.delete(id)));
        for (const r of results) if (r.status === 'fulfilled') deletedPayouts += 1;
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
        deletedPayoutRows: deletedPayouts,
        stampedTopupFees,
        settlementStamps: stampSettlement,
        saleClassStamps: stampClasses,
      });
    }

    const monthsBack = Math.min(MAX_MONTHS_BACK, Math.max(1, Math.round(Number(payload?.monthsBack || DEFAULT_MONTHS_BACK)) || DEFAULT_MONTHS_BACK));
    let windowStart = payload?.startDate || new Date(Date.now() - monthsBack * 30.44 * 86400000).toISOString().slice(0, 10) + 'T00:00:00Z';
    const windowEnd = payload?.endDate || new Date().toISOString();
    // Active store location configs (restore: this fetch was accidentally
    // dropped in an Oct 4 edit — configs/configIds were undefined, so every
    // rawPreview and regular sync call failed 500 "configs is not defined").
    const configsRaw = await base44.asServiceRole.entities.SquareLocationConfig.list('-updated_date', 500).catch(() => []);
    const configs = (configsRaw || []).filter((c: any) => c?.square_location_id && (!c?.status || c.status === 'active'));
    // Payout-only backfill mode (light chunks, no payments/orders/refunds).
    const isTopupBackfill = String(payload?.mode || '') === 'topupBackfill';
    if (!configs.length && !isTopupBackfill) throw new HttpError(400, 'No active Square location configurations found');

    // ── CARD SPEND PROBE v2 (owner Oct 5 2026): find how Square represents
    // MONEY SPENT from the store Square Cards. Scan payouts at every ACTIVE
    // location over N days, page through, and report only "unusual" payouts:
    // negative amounts or entries whose type is not the familiar funding mix
    // (CHARGE / BALANCE_FOLDERS_TRANSFER / SQUARE_CAPITAL_PAYMENT).
    if (String(payload?.mode || '') === 'cardSpendProbe') {
      const days = Math.min(365, Math.max(1, Math.round(Number(payload?.days || 90)) || 90));
      const since = new Date(Date.now() - days * 86400000).toISOString();
      const KNOWN = new Set(['CHARGE', 'BALANCE_FOLDERS_TRANSFER', 'SQUARE_CAPITAL_PAYMENT']);
      const out: any = { since, locations: [], findings: [], scanned: 0 };
      try {
        const locsJson: any = await squareFetch('/v2/locations', 'GET', accessToken);
        out.locations = (locsJson?.locations || []).map((l: any) => ({ id: l.id, name: l.name, type: l.type, status: l.status }));
      } catch (e: any) { out.locationsError = e?.message || String(e); }
      for (const l of out.locations) {
        if (String(l?.status || '').toUpperCase() !== 'ACTIVE') continue;
        try {
          let cursor = '';
          for (let page = 0; page < 12; page++) {
            const path = `/v2/payouts?location_id=${encodeURIComponent(l.id)}&begin_time=${encodeURIComponent(since)}&sort_order=DESC&limit=100` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
            const pj: any = await squareFetch(path, 'GET', accessToken);
            const pos = pj?.payouts || [];
            out.scanned += pos.length;
            for (const po of pos) {
              const amt = Number(po?.amount_money?.amount || 0);
              if (amt >= 0) continue; // card spends must be money OUT
              let ents: any[] = [];
              try { const e: any = await squareFetch(`/v2/payouts/${po.id}/payout-entries`, 'GET', accessToken); ents = e?.payout_entries || []; } catch { /* best effort */ }
              const types = ents.map((x: any) => String(x?.type || ''));
              const hasUnknown = types.some((t: any) => t && !KNOWN.has(t));
              if (!hasUnknown && !types.length) continue;
              out.findings.push({
                loc: l.name, locId: l.id,
                payout: { id: po.id, amount: amt, status: po.status, type: po.type, dest: po.destination?.type, created: po.created_at },
                entries: ents.map((x: any) => ({ type: x.type, gross: x.gross_amount_money?.amount, net: x.net_amount_money?.amount, other: x.type_other_details || null, paymentId: x.type_charge_details?.payment_id || null }))
              });
              await sleep(60);
            }
            cursor = pj?.cursor || '';
            if (!cursor || pos.length < 100) break;
            await sleep(80);
          }
        } catch (e: any) { out.findings.push({ loc: l.name, locId: l.id, error: e?.message || String(e) }); }
        await sleep(80);
      }
      return Response.json({ success: true, probe: out });
    }

    // ── RAW API PREVIEW (owner request Oct 4 2026): return the raw records
    // EXACTLY as the Square API delivered them — before any mapping, COD
    // linking, settlement stamping, or DB writes. Nothing is persisted.
    // One page per endpoint per location, merged newest-first, capped at
    // payload.limit (default 100).
    if (payload?.rawPreview) {
      const limit = Math.min(200, Math.max(1, Math.round(Number(payload?.limit || 100)) || 100));
      const raw: any[] = [];
      const errors: string[] = [];
      const jobs: Promise<any>[] = [];
      for (const c of configs) {
        const locationId = String(c.square_location_id);
        const locationName = c.name || c.store_name || locationId;
        jobs.push((async () => {
          try {
            const pj: any = await squareFetch(`/v2/payments?location_id=${encodeURIComponent(locationId)}&begin_time=${encodeURIComponent(windowStart)}&end_time=${encodeURIComponent(windowEnd)}&sort_order=DESC&limit=${limit}`, 'GET', accessToken);
            for (const p of pj?.payments || []) raw.push({ source: 'payment', location: locationName, at: p.created_at, raw: p });
          } catch (e: any) { errors.push(`payments(${locationName}): ${e?.message || e}`); }
        })());
        jobs.push((async () => {
          try {
            const oj: any = await squareFetch('/v2/orders/search', 'POST', accessToken, {
              location_ids: [locationId],
              limit,
              query: {
                filter: {
                  state_filter: { states: ['COMPLETED', 'CANCELED'] },
                  date_time_filter: { created_at: { start_at: windowStart, end_at: windowEnd } },
                },
                sort: { sort_field: 'CREATED_AT', sort_order: 'DESC' },
              },
            });
            for (const o of oj?.orders || []) raw.push({ source: 'order', location: locationName, at: o.created_at, raw: o });
          } catch (e: any) { errors.push(`orders(${locationName}): ${e?.message || e}`); }
        })());
        jobs.push((async () => {
          try {
            const rj: any = await squareFetch(`/v2/refunds?location_id=${encodeURIComponent(locationId)}&begin_time=${encodeURIComponent(windowStart)}&end_time=${encodeURIComponent(windowEnd)}&sort_order=DESC&limit=${limit}`, 'GET', accessToken);
            for (const r of rj?.refunds || []) raw.push({ source: 'refund', location: locationName, at: r.created_at, raw: r });
          } catch (e: any) { errors.push(`refunds(${locationName}): ${e?.message || e}`); }
        })());
      }
      await Promise.all(jobs);
      raw.sort((a: any, b: any) => String(b.at || '').localeCompare(String(a.at || '')));
      return Response.json({
        success: true,
        rawPreview: true,
        windowStart,
        windowEnd,
        pulled: raw.length,
        count: Math.min(raw.length, limit),
        entries: raw.slice(0, limit),
        errors,
      });
    }
    const configIds = new Set(configs.map((c: any) => String(c.square_location_id)));

    // COD link map: catalog object id -> { delivery_id, patient_id, item_name }
    // plus a NAME-keyed map for orders whose line items lost their
    // catalog_object_id (owner report Oct 7 2026: the Callingwood $4.53 MD +
    // $23.60 CW grouped ring — Square's payment→order→line-item→catalog
    // chain is routinely broken, but the line items still carry the
    // catalog item NAME, which matches item_name exactly).
    const catalogByObjectId = new Map<string, any>();
    const catalogByName = new Map<string, any>();
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
          const link = {
            delivery_id: deliveryId,
            patient_id: item.patient_id || null,
            item_name: item.item_name || null,
          };
          catalogByObjectId.set(item.square_catalog_object_id, link);
          // NAME key: only when the row resolves to a delivery — and never
          // let two different deliveries share one name key (ambiguous name
          // = no match at all, safer than a wrong link).
          if (deliveryId && link.item_name) {
            const nk = normalizeCatalogName(link.item_name);
            if (nk) {
              const prev = catalogByName.get(nk);
              if (prev) {
                if (String(prev.delivery_id) !== String(deliveryId)) catalogByName.delete(nk);
              } else {
                catalogByName.set(nk, link);
              }
            }
          }
        }
      }
      if (rows.length < 2000) break;
      catalogSkip += 2000;
    }

    const entries: Map<string, any> = new Map();
    const locationStats: any[] = [];
    let payoutsAvailable = true;
    const syncErrors: string[] = [];
    // square_ids of pre-split combined rows (owner report Oct 7 2026: a
    // multi-COD payment's old single ledger row is now replaced by one row
    // per delivery) — deleted from the table below so the combined row never
    // sits alongside its split children and double-counts the sale.
    const supersededSquareIds = new Set<string>();

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
        // Payout rows REMOVED (owner rule Oct 4 2026): the per-sale SIMPLE
        // (folder) and BATCH (settled sweep) transfers duplicate folder_cents /
        // settled_cents already stamped on each collected card sale — storing
        // them as extra rows was pure duplication. Bank sweeps are now DERIVED
        // from the collected rows' settled_cents (useSquareBalancesSummary).
        // /v2/payouts is no longer fetched for store locations (also saves the
        // API call). MOBILE-location top-ups are still pulled separately below.
      ];
      await Promise.all(tasks);
      return out;
    };

    const locationData = (!isTopupBackfill && configs.length)
      ? await Promise.all((configs as any[]).map(fetchLocationData))
      : [];
    for (const ld of locationData) {
      if (ld.payoutsScopeMissing) payoutsAvailable = false;
      for (const e of ld.errors || []) syncErrors.push(e);
    }

    for (const ld of locationData) {
      const locationId = ld.config.square_location_id;
      const locationName = ld.locationName;
      const { payments, orders, refunds } = ld;

      const orderById = new Map<string, any>(orders.map((o: any) => [o.id, o]));
      const paymentById = new Map<string, any>(payments.map((p: any) => [p.id, p]));

      // Card payments -> sale or decline entries
      for (const payment of payments) {
        const order = payment?.order_id ? orderById.get(payment.order_id) : null;
        const codLinksAll = order ? resolveCodLineItems(order, catalogByObjectId) : [];
        const codLink = codLinksAll[0] || null;
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

        // CANCELED payments never settle — nothing to show.
        if (status === 'CANCELED') continue;
        // PENDING/APPROVED (owner report Oct 6 2026: Square's own app shows
        // these under a "Pending" header — a card swipe/business-card spend
        // that is authorized but not yet settled, e.g. Elaine Ash's 49.98).
        // Store them with their real status so they're visible in the ledger
        // and eligible for Card Spend badge matching; a later sync overwrites
        // this same square_id with the COMPLETED version once it settles
        // (buildEntry/entries.set is keyed by payment.id either way).
        if (status !== 'COMPLETED' && status !== 'APPROVED' && status !== 'PENDING') continue;

        // MULTI-COD SPLIT (Oct 7 2026): 2+ distinct CODs swiped as one
        // payment each get their own ledger entry (own amount/fee/settlement),
        // so each delivery can be individually matched and auto-confirmed.
        // The pre-split combined row (keyed by payment.id alone) is stale once
        // split and is deleted below via supersededSquareIds.
        if (codLinksAll.length > 1) {
          const fullFee = sumProcessingFees(payment);
          const splitParts = splitPaymentAcrossCodLinks(codLinksAll, payment?.amount_money?.amount, fullFee);
          if (splitParts.length) {
            supersededSquareIds.add(String(payment.id));
            for (const part of splitParts) {
              const splitSuffix = String(part.delivery_id || part.catalogObjectId || part.item_name || '').replace(/\s+/g, '');
              entries.set(`${payment.id}:${splitSuffix}`, buildEntry({
                square_id: `${payment.id}:${splitSuffix}`,
                entry_kind: 'collected',
                tender_type: 'CARD',
                sale_class: 'cod_collection',
                amount_cents: part.amountCents,
                fee_cents: part.feeCents,
                ...cardSettlementCents(rates, locationId, part.amountCents, part.feeCents),
                status: payment.status,
                occurred_at: payment.created_at,
                location_id: locationId,
                location_name: locationName,
                order_id: payment.order_id || null,
                delivery_id: part.delivery_id || null,
                patient_id: part.patient_id || null,
                cod_item_name: part.item_name || null,
                card_fingerprint: card?.fingerprint || null,
                card_last4: card?.last_4 || null,
                card_brand: card?.card_brand || null,
                entry_method: payment?.card_details?.entry_method || null,
              }));
            }
            continue;
          }
        }

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
          const codLinksAll = resolveCodLineItems(order, catalogByObjectId, catalogByName);
          const codLink = codLinksAll[0] || null;
          // MULTI-COD SPLIT (Oct 7 2026) — same reasoning as the card-payment
          // branch: a cash ring covering 2+ CODs in one tender needs one entry
          // per delivery so each can be individually matched/confirmed.
          if (codLinksAll.length > 1) {
            const splitParts = splitPaymentAcrossCodLinks(codLinksAll, tender?.amount_money?.amount, 0);
            if (splitParts.length) {
              supersededSquareIds.add(`tender-${tender.id}`);
              for (const part of splitParts) {
                const splitSuffix = String(part.delivery_id || part.catalogObjectId || part.item_name || '').replace(/\s+/g, '');
                entries.set(`tender-${tender.id}:${splitSuffix}`, buildEntry({
                  square_id: `tender-${tender.id}:${splitSuffix}`,
                  entry_kind: 'collected',
                  tender_type: tender.type || 'OTHER',
                  sale_class: 'cod_collection',
                  amount_cents: part.amountCents,
                  status: order.state === 'COMPLETED' ? 'COMPLETED' : order.state,
                  occurred_at: tender.created_at || order.created_at,
                  location_id: locationId,
                  location_name: locationName,
                  order_id: order.id,
                  delivery_id: part.delivery_id || null,
                  patient_id: part.patient_id || null,
                  cod_item_name: part.item_name || null,
                }));
              }
              continue;
            }
          }
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


      locationStats.push({
        location_id: locationId,
        name: locationName,
        payments: payments.length,
        orders: orders.length,
        refunds: refunds.length,
        payouts: 0, // payout rows removed Oct 4 2026 — sweeps derived from settled_cents
      });
    }

    // ── STORE-CARD SWEEP PAYOUTS (owner spec Oct 5 2026) ────────────────────────
    // The Summaries page must be the CARD ledger: Collected = any amount
    // ADDED to the store's Square Card, using the ACTUAL swept cents from
    // Square payout records — NOT the settled_cents formula on sale rows
    // (owner: "actual collected, not the settled amounts"). Each card sale's
    // settled remainder sweeps from the location balance onto the store
    // card's stored balance as a BATCH payout AT THE STORE LOCATION with
    // destination SQUARE_STORED_BALANCE. SIMPLE payouts are folder transfers
    // (not card money) -> skipped. Negative payouts driven by REFUND entries
    // are refund reversals -> skipped (register refunds own that money). Any
    // other negative payout is a real withdrawal from the card ->
    // entry_kind 'store_withdraw' (Spent). Runs in BOTH the regular sync and
    // mode:'topupBackfill' chunks.
    const locNameById = new Map<string, string>();
    try {
      const locsJson2: any = await squareFetch('/v2/locations', 'GET', accessToken);
      for (const l of (locsJson2?.locations || [])) locNameById.set(String(l?.id || ''), String(l?.name || l?.id || ''));
    } catch { /* names best effort */ }
    let storeTopupsFetched = 0;
    for (const cfg of (configs as any[])) {
      const locationId = String(cfg?.square_location_id || '');
      if (!locationId) continue;
      const locationName = locNameById.get(locationId) || cfg?.name || cfg?.store_name || locationId;
      try {
        const payoutsPath = `/v2/payouts?location_id=${encodeURIComponent(locationId)}&begin_time=${encodeURIComponent(windowStart)}&end_time=${encodeURIComponent(windowEnd)}&sort_order=ASC`;
        const pos = await paginatedSquareGet(payoutsPath, accessToken);
        for (const po of pos || []) {
          if (String(po?.destination?.type || '') !== 'SQUARE_STORED_BALANCE') continue;
          const amt = Math.round(Number(po?.amount_money?.amount || 0));
          if (!po?.id || amt === 0) continue;
          if (amt > 0 && String(po?.type || '') !== 'BATCH') continue; // SIMPLE = folder transfer, never card money
          let entryTypes: string[] = [];
          if (amt < 0) {
            try {
              const entsJson: any = await squareFetch(`/v2/payouts/${po.id}/payout-entries`, 'GET', accessToken);
              entryTypes = (entsJson?.payout_entries || []).map((x: any) => String(x?.type || '')).filter(Boolean);
            } catch { /* best effort */ }
            if (entryTypes.includes('REFUND')) continue; // refund reversal — refunds own it
          }
          entries.set(String(po.id), buildEntry({
            square_id: String(po.id),
            entry_kind: amt > 0 ? 'store_topup' : 'store_withdraw',
            amount_cents: Math.abs(amt),
            status: po.status,
            occurred_at: po.created_at,
            location_id: locationId,
            location_name: locationName,
            reason: [amt > 0 ? 'STORE_CARD_TOPUP' : 'STORE_CARD_WITHDRAW', po.type, entryTypes.join('/') || null].filter(Boolean).join(' | '),
          }));
          storeTopupsFetched += 1;
          await sleep(60);
        }
      } catch (e: any) { syncErrors.push(`storePayouts(${locationName}): ${e?.message || e}`); }
    }

    // ── CARD LOCATIONS — fund transfers onto the Square Cards (owner request,
    // Oct 3 2026: "pull transfer records card-to-card / folder-to-card").
    // Square models each Square Card as a MOBILE location; payouts with
    // destination SQUARE_STORED_BALANCE at those locations are the money
    // moves ONTO the card (per-sale top-ups today; manual folder/card
    // transfers when Square exposes them). The per-store loop above never
    // sees them (they are not attributed to store locations), so they are
    // pulled separately and stored as entry_kind 'card_topup' — a CREDIT.
    // Readers must never count card_topup as a bank sweep (PAYOUT_KINDS in
    // useSquareBalancesSummary.js excludes it on purpose).
    const topupSrcByPayout = new Map<string, string | null>();
    let topupsFetched = 0;
    const storeLocIds = new Set(rates.loanRateByLoc.keys());
    try {
      const locsJson: any = await squareFetch('/v2/locations', 'GET', accessToken);
      const cardLocs = ((locsJson?.locations || []) as any[])
        .filter((l: any) => l?.id && String(l?.status || '').toUpperCase() === 'ACTIVE')
        .filter((l: any) => !configIds.has(String(l.id)));
      for (const cl of cardLocs) {
        try {
          const payoutsPath = `/v2/payouts?location_id=${encodeURIComponent(cl.id)}&begin_time=${encodeURIComponent(windowStart)}&end_time=${encodeURIComponent(windowEnd)}&sort_order=ASC`;
          const pos = await paginatedSquareGet(payoutsPath, accessToken);
          for (const po of pos || []) {
            if (!po?.id) continue;
            const destType = String(po?.destination?.type || '');
            // Payout entries reveal the source sale (CHARGE -> payment id) so
            // the transfer can be attributed to the store whose sale fed the
            // card. Best effort: manual folder transfers have no CHARGE entry.
            let srcPaymentId: string | null = null;
            let entryTypes: string[] = [];
            try {
              const entsJson: any = await squareFetch(`/v2/payouts/${po.id}/payout-entries`, 'GET', accessToken);
              const ents = entsJson?.payout_entries || [];
              entryTypes = (ents.map((e: any) => String(e?.type || '')).filter(Boolean)) as string[];
              const charge = ents.find((e: any) => e?.type_charge_details?.payment_id);
              if (charge) srcPaymentId = String(charge.type_charge_details.payment_id);
            } catch { /* entries best effort */ }
            topupSrcByPayout.set(String(po.id), srcPaymentId);
            entries.set(po.id, buildEntry({
              square_id: po.id,
              entry_kind: 'card_topup',
              amount_cents: po?.amount_money?.amount,
              status: po.status,
              occurred_at: po.created_at,
              location_id: cl.id,
              location_name: cl.name || cl.id,
              reason: [destType, po.type, entryTypes.join('/') || null, srcPaymentId].filter(Boolean).join(' | '),
            }));
            topupsFetched += 1;
            await sleep(60);
          }
          locationStats.push({
            location_id: cl.id,
            name: `${cl.name || cl.id} (card)`,
            payments: 0, orders: 0, refunds: 0, payouts: (pos || []).length,
          });
        } catch (e: any) { syncErrors.push(`cardPayouts(${cl.name || cl.id}): ${e?.message || e}`); }
      }
    } catch (e: any) { syncErrors.push(`cardLocations: ${e?.message || e}`); }

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

    // SUPERSEDED COMBINED-ROW CLEANUP (Oct 7 2026 multi-COD split): a
    // payment/tender that used to be ONE ledger row (before this fix split it
    // into one row per delivery) must have its old combined row removed —
    // otherwise the combined amount and its split children both count,
    // double-booking the sale and its fee.
    let supersededRowsDeleted = 0;
    for (const sqid of supersededSquareIds) {
      const existingId = existingIdBySquareId.get(sqid);
      if (!existingId) continue;
      await base44.asServiceRole.entities.SquareLedgerEntry.delete(existingId)
        .then(() => { supersededRowsDeleted += 1; existingIdBySquareId.delete(sqid); })
        .catch((e: any) => { if (syncErrors.length < 10) syncErrors.push(`supersededDelete(${existingId}): ${e?.message || e}`); });
    }

    // ── TOPUP ATTRIBUTION ─────────────────────────────────────────────────────
    // A card top-up's CHARGE entry points at the source sale's payment id.
    // Resolve it to the STORE whose sale fed the card (in-window sales live
    // in the entries Map; older sales come from existing ledger rows).
    let topupsAttributed = 0;
    // Source sales older than the scan pool (or from skipped store phases in
    // topup-only backfills) are fetched straight from the ledger by square_id.
    const unresolvedSrcs = new Set<string>();
    for (const rec of allEntries) {
      if (rec?.entry_kind !== 'card_topup') continue;
      const src = topupSrcByPayout.get(String(rec.square_id)) || null;
      if (!src) continue;
      // Resolve the SOURCE SALE ROW (not just its location) so the top-up can
      // inherit the fee skimmed from that sale (owner report Oct 4 2026:
      // top-ups showed no fee cents).
      const srcRow = entries.get(src) || existingRowsBySquareId.get(src)?.[0] || null;
      const storeLoc = srcRow?.location_id || null;
      if (storeLoc && storeLocIds.has(String(storeLoc))) {
        rec.attributed_location_id = String(storeLoc);
        if (rec.fee_cents == null && srcRow?.fee_cents != null) rec.fee_cents = srcRow.fee_cents;
        topupsAttributed += 1;
      } else if (!storeLoc) {
        unresolvedSrcs.add(src);
      }
    }
    const srcRowByPaymentId = new Map<string, any>();
    for (const src of unresolvedSrcs) {
      try {
        const rows: any[] = (await base44.asServiceRole.entities.SquareLedgerEntry.filter({ square_id: src }).catch(() => [])) as any[];
        const row = (rows || []).find((r: any) => r?.location_id);
        if (row?.location_id) srcRowByPaymentId.set(String(src), row);
      } catch { /* best effort */ }
      await sleep(40);
    }
    for (const rec of allEntries) {
      if (rec?.entry_kind !== 'card_topup' || rec.attributed_location_id) continue;
      const src = topupSrcByPayout.get(String(rec.square_id)) || null;
      const srcRow = src ? srcRowByPaymentId.get(String(src)) || null : null;
      const storeLoc = srcRow?.location_id || null;
      if (storeLoc && storeLocIds.has(String(storeLoc))) {
        rec.attributed_location_id = storeLoc;
        if (rec.fee_cents == null && srcRow?.fee_cents != null) rec.fee_cents = srcRow.fee_cents;
        topupsAttributed += 1;
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
    let multiSplitRings = 0;
    let multiSplitChildren = 0;
    let multiSplitOrdersRetrieved = 0;
    const storeFingerprintCounts: any = {};
    if (isTopupBackfill) { /* skipped: topup-only backfill */ } else try {
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
      type CodDelivery = { id: string; locId: string; cents: number; cents2: number; completedAt: number; date: string; patientId: any; patientName: string; abbr: string | null; confirmed: boolean };
      const codDeliveries: CodDelivery[] = [];
      const patientIdsToResolve = new Set<string>();
      const backfillFloorMs = new Date(new Date(windowStart).getTime() - 3 * 86400000).getTime();
      for (let page = 0; page < 4; page++) {
        const rows: any[] = (await base44.asServiceRole.entities.Delivery.list('-created_date', 2000, page * 2000).catch(() => [])) as any[];
        const list = rows || [];
        for (const d of list) {
          // Owner spec (Oct 6 2026): confirmed-collected deliveries ARE the
          // ones whose real card swipe exists — including them is what makes
          // the patient-name link pass actually match. (Only the outstanding
          // pass below still excludes them.)
          if (d?.status !== 'completed') continue;
          const required = Number(d?.cod_total_amount_required || 0);
          // Card-side amount first (Debit+Credit cod_payments sum, in cents),
          // fallback to the required total — mirrors the Square Balances
          // candidate-amount rule.
          const payments = Array.isArray(d?.cod_payments) ? d.cod_payments : [];
          const cardCents = payments
            .filter((p: any) => ['debit', 'credit'].includes(String(p?.type || '').toLowerCase()))
            .reduce((s: number, p: any) => s + Math.round(Number(p?.amount || 0) * 100), 0);
          if (required <= 0 && cardCents <= 0) continue;
          const createdMs = new Date(d?.created_date || 0).getTime();
          if (Number.isFinite(createdMs) && createdMs < backfillFloorMs) continue;
          const locId = storeToLoc.get(String(d?.store_id || ''));
          if (!locId) continue;
          const completedAt = new Date(d?.actual_delivery_time || d?.updated_date || d?.created_date || 0).getTime();
          const requiredCents = Math.round(required * 100);
          codDeliveries.push({
            id: String(d.id), locId,
            cents: cardCents > 0 ? cardCents : requiredCents,
            cents2: cardCents > 0 && requiredCents > 0 && requiredCents !== cardCents ? requiredCents : 0,
            completedAt,
            date: String(d?.delivery_date || ''), patientId: d?.patient_id || null,
            patientName: ledgerNormalizeText(d?.patient_name), abbr: storeAbbrById.get(String(d?.store_id || '')) || null,
            confirmed: !!d?.cod_confirmed_collected,
          });
          if (d?.patient_id && !ledgerNormalizeText(d?.patient_name)) patientIdsToResolve.add(String(d.patient_id));
        }
        // Resolve actual patient names for deliveries that only carry a
        // patient_id (owner Oct 6: no more "Unknown Patient" in the ledger
        // Item column when the id is known). One .get per id (bounded pool:
        // completed CODs since the backfill floor), throttled.
        const patientNameById = new Map<string, string>();
        {
          const ids = Array.from(patientIdsToResolve);
          for (const pid of ids) {
            const p: any = await base44.asServiceRole.entities.Patient.get(pid).catch(() => null);
            if (p?.id) patientNameById.set(String(p.id), ledgerNormalizeText(p?.full_name || p?.name));
            await sleep(40);
          }
          for (const d of codDeliveries) {
            const resolved = d.patientId ? patientNameById.get(String(d.patientId)) : '';
            if (resolved) d.patientName = resolved;
          }
        }
        if (list.length < 2000) break;
        if (list.length && new Date(list[list.length - 1]?.created_date || 0).getTime() < backfillFloorMs) break;
      }

      // Unlinked completed CARD sales pool: current-window entries PLUS existing
      // ledger rows (window-independent repair). Declines are anchor evidence.
      type SaleCandidate = { key: string; existingId: string | null; cents: number; at: number; brand: string | null; method: string | null; fee: number; locId: string | null; cardFingerprint: string | null; orderId: string | null };
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
          orderId: e?.order_id ? String(e.order_id) : null,
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
          orderId: e?.order_id ? String(e.order_id) : null,
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

      const matchedDeliveryIds = new Set<string>(); // exact-pass matches — excluded from the multi-item split pass below
      for (const d of codDeliveries) {
        // Rough-date window (owner Oct 6 2026): the delivery's Edmonton
        // calendar day, padded 6h on both edges (Edmonton midnight = 06:00Z
        // in MDT / 07:00Z in MST; the pad absorbs both). Sales in this day
        // window OR in the tight completion ring are candidates — same
        // rough-date rule as catalog creation.
        const dayAnchorMs = Date.parse(`${d.date || '1970-01-01'}T06:00:00Z`);
        const dayStartMs = dayAnchorMs - 6 * 3600000;
        const dayEndMs = dayAnchorMs + 24 * 3600000 + 6 * 3600000;
        const anchorAt = d.completedAt > 0 ? d.completedAt : dayStartMs + 18 * 3600000;
        const pool = salePool.filter((x) => {
          if (x.locId !== d.locId || usedSaleKeys.has(x.key)) return false;
          if (x.cardFingerprint && storeCardFingerprints.has(x.cardFingerprint)) return false;
          const inRing = d.completedAt > 0 && x.at >= d.completedAt - WINDOW_BEFORE_MS && x.at <= d.completedAt + WINDOW_AFTER_MS;
          const inDay = x.at >= dayStartMs && x.at <= dayEndMs;
          return inRing || inDay;
        });
        if (!pool.length) continue;
        // Prefer closest-in-time candidates first (subset-sum picks in order).
        pool.sort((a, b) => Math.abs(a.at - anchorAt) - Math.abs(b.at - anchorAt));
        // Prefer pool members whose ring follows a decline of the same amount
        // (owner: declined full-COD swipe, then successful parts that sum to it).
        const anchored = pool.filter((x) => declineAnchors.some((a) => a.locId === d.locId && (a.cents === d.cents || (d.cents2 > 0 && a.cents === d.cents2)) && (d.completedAt > 0 ? (a.at >= d.completedAt - WINDOW_BEFORE_MS && a.at <= x.at) : (a.at >= dayStartMs && a.at <= x.at))));
        // Try the card-side amount first, then the required-total fallback.
        const targets = [d.cents, ...(d.cents2 > 0 ? [d.cents2] : [])];
        let match: SaleCandidate[] | null = null;
        for (const t of targets) {
          match = subsetSumMatch(anchored.length ? anchored : pool, t);
          if (match) break;
        }
        if (!match) continue;
        matchedDeliveryIds.add(d.id);
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
        if (await confirmCodDeliveryWithCard(base44, d.id, codType, d.cents)) backfillTypeSyncs += 1;
      }
    // ── MULTI-ITEM RING SPLIT (owner report Oct 7 2026: "$4.53(MD) & $23.60(CW)
    // swiped as one $28.13 Callingwood debit") ─────────────────────────────────
    // The exact pass above matches WHOLE sales to one delivery. A grouped ring
    // (2+ COD catalog items in ONE transaction) can never match whole, so the
    // sale stays unlinked and NO delivery in the group ever confirms — both
    // items sat in Past Uncollected even though the card was collected. This
    // pass splits such sales into one ledger entry PER DELIVERY:
    //   1. ORDER-LINE match — batch-retrieve the payment's Square order and
    //      resolve its line items by catalog_object_id, falling back to the
    //      line NAME (the catalog item_name format, e.g.
    //      "10/06(MD)-Steve Magega" — the object-id chain is often broken).
    //   2. SUBSET-SUM match (no order data) — the sale's exact cents equal
    //      the sum of 2-3 UNCOLLECTED CODs whose Edmonton day falls within
    //      [sale day - 3, sale day] (office rings collected cards up to a few
    //      days after delivery; multiple stores share one card, so the split
    //      is intentionally NOT scoped to the sale's location).
    // Split children are individually linked per delivery (square_id
    // "<parent>:<deliveryId>"), so the Finance Audit page Item/Reason column
    // shows the individual items and Square Balances reconciles each
    // delivery; the combined parent row is deleted so nothing double-counts.
    try {
      // Deliveries still awaiting their Square evidence (multi-split pool):
      // never confirmed, never linked to a COMPLETED cod_collection sale
      // (including links the exact pass just stamped this run).
      const linkedCodDeliveryIds = new Set<string>();
      const isLinkedCodRow = (e: any) =>
        !!e?.delivery_id && String(e?.sale_class || '') === 'cod_collection' && String(e?.status || '').toUpperCase() === 'COMPLETED';
      for (const e of allEntries) if (isLinkedCodRow(e)) linkedCodDeliveryIds.add(String(e.delivery_id));
      for (const [, rows] of existingRowsBySquareId) if (rows[0] && isLinkedCodRow(rows[0])) linkedCodDeliveryIds.add(String(rows[0].delivery_id));
      // Pool note (Oct 7 2026): do NOT exclude confirmed-collected deliveries
      // here. A grouped ring's deliveries can be confirmed by an earlier run
      // whose child rows failed to persist (or by a delivery-side confirm
      // that ran before the ledger split landed) — a confirmed delivery with
      // NO linked ledger row is exactly the stranded case this pass repairs.
      // The real guards are: no existing linked COMPLETED cod_collection sale
      // (linked) and not matched by another path this run.
      const splitPool = codDeliveries.filter((d: any) =>
        !matchedDeliveryIds.has(d.id) && !linkedCodDeliveryIds.has(d.id) && d.cents > 0);
      if (splitPool.length) {
        // Candidate sales: unlinked, unclaimed by the exact pass, recent
        // CARD sales whose cents could be a single uncollected COD or a
        // 2-3 item subset-sum of them. NOTE (owner report Oct 7 2026): the
        // store-card fingerprint exclusion is deliberately NOT applied here
        // — these grouped rings are tendered with the STORE'S OWN Square
        // debit card (the office loads the collected cash back onto the
        // card), so the 5-swipes-never-COD-linked heuristic would exclude
        // exactly the sales this pass must split. Same lesson as the Oct 3
        // Lasaga fix: the fingerprint heuristic must never block a genuine
        // COD match. The exact-cents subset-sum (and, in strategy 1, the
        // order line NAME match) is the precision guard instead.
        const nowMs = Date.now();
        const matchableSums = new Set<number>();
        for (const d of splitPool) matchableSums.add(d.cents);
        const sumCap = splitPool.length <= 60 ? 3 : 2;
        if (sumCap >= 2) {
          for (let i = 0; i < splitPool.length; i++) {
            for (let j = i + 1; j < splitPool.length; j++) {
              matchableSums.add(splitPool[i].cents + splitPool[j].cents);
              if (sumCap === 3) {
                for (let k = j + 1; k < splitPool.length; k++) {
                  matchableSums.add(splitPool[i].cents + splitPool[j].cents + splitPool[k].cents);
                }
              }
            }
          }
        }
        const candSales = salePool.filter((x) =>
          !usedSaleKeys.has(x.key) && x.orderId && x.cents > 0 &&
          (nowMs - x.at) < 30 * 86400000 &&
          matchableSums.has(x.cents)
        ).sort((a, b) => b.at - a.at).slice(0, 24);

        // Shared split mechanics: supersede the combined parent (delete its
        // stale DB copy + remove it from this run's upsert), then emit one
        // child entry per delivery with proportional fee/folder/loan.
        const splitSaleAcrossDeliveries = async (parent: SaleCandidate, parts: { deliveryId: string; patientId: any; itemName: string | null; amountCents: number }[]) => {
          const parentInEntries = entries.has(parent.key);
          const parentRow = entries.get(parent.key) || existingRowsBySquareId.get(parent.key)?.[0] || null;
          if (!parentRow) return 0;
          const splitParts = splitPaymentAcrossCodLinks(parts.map((p) => ({ ...p, catalogObjectId: null })), parent.cents, parent.fee);
          if (!splitParts.length) return 0;
          supersededSquareIds.add(parent.key);
          // Remove the parent from BOTH the upsert Map and the persist
          // snapshot (allEntries is snapshotted before this pass — a child
          // pushed only to `entries` would never persist, and the parent
          // would be re-upserted by the snapshot copy).
          entries.delete(parent.key);
          const pIdx = allEntries.indexOf(parentRow);
          if (pIdx >= 0) allEntries.splice(pIdx, 1);
          usedSaleKeys.add(parent.key);
          let created = 0;
          let parentDbDeleted = false;
          // The superseded-row cleanup earlier in the run ran BEFORE this
          // pass added the parent, so delete the parent's stale DB copy here.
          if (parent.existingId) {
            await base44.asServiceRole.entities.SquareLedgerEntry.delete(parent.existingId)
              .then(() => { parentDbDeleted = true; }).catch(() => {});
            await sleep(40);
          }
          for (const part of splitParts) {
            const childKey = `${parent.key}:${part.deliveryId || created}`;
            const child = buildEntry({
              ...parentRow,
              square_id: childKey,
              entry_kind: 'collected',
              tender_type: 'CARD',
              sale_class: 'cod_collection',
              amount_cents: part.amountCents,
              fee_cents: part.feeCents,
              ...cardSettlementCents(rates, parentRow.location_id || parent.locId, part.amountCents, part.feeCents),
              delivery_id: part.deliveryId || null,
              patient_id: part.patientId || null,
              cod_item_name: part.itemName || null,
            });
            if (parentInEntries) {
              // In this run's upsert pool: children ride the normal persist
              // loop (entries Map + the allEntries snapshot).
              entries.set(childKey, child);
              allEntries.push(child);
              created += 1;
            } else {
              // Parent only exists in the DB (outside this run's Square
              // window): create children directly and delete the parent now.
              await base44.asServiceRole.entities.SquareLedgerEntry.create(child)
                .then(() => { created += 1; }).catch(() => {});
              await sleep(40);
            }
            // Delivery-side confirmation: the swiped card is the authority.
            const codType = String(parent.brand || '').toUpperCase() === 'INTERAC' ? 'Debit' : 'Credit';
            if (part.deliveryId) await confirmCodDeliveryWithCard(base44, part.deliveryId, codType, part.amountCents);
          }
          return created;
        };

        // STRATEGY 1: order-line resolution via batch-retrieve.
        const unresolved: SaleCandidate[] = [];
        const retrieveMap = new Map<string, SaleCandidate[]>();
        for (const c of candSales) {
          if (!retrieveMap.has(c.orderId!)) retrieveMap.set(c.orderId!, []);
          retrieveMap.get(c.orderId!)!.push(c);
        }
        const orderIds = Array.from(retrieveMap.keys()).slice(0, 80);
        const retrievedOrderById = new Map<string, any>();
        for (let i = 0; i < orderIds.length; i += 20) {
          try {
            const json = await squareFetch('/v2/orders/batch-retrieve', 'POST', accessToken, { order_ids: orderIds.slice(i, i + 20) });
            for (const o of json?.orders || []) retrievedOrderById.set(String(o.id), o);
            multiSplitOrdersRetrieved += 1;
            await sleep(150);
          } catch { /* best effort — subset-sum pass still runs */ }
        }
        for (const c of candSales) {
          const order = c.orderId ? retrievedOrderById.get(c.orderId) : null;
          const links = order ? resolveCodLineItems(order, catalogByObjectId, catalogByName) : [];
          const usable = links.filter((l: any) => l?.delivery_id &&
            !linkedCodDeliveryIds.has(String(l.delivery_id)) && !matchedDeliveryIds.has(String(l.delivery_id)));
          const catalogLinkOf = (deliveryId: string) => {
            const cl = catalogByDeliveryId.get(deliveryId);
            return cl?.item_name || null;
          };
          if (usable.length >= 2) {
            const parts = usable.map((l: any) => ({
              deliveryId: String(l.delivery_id),
              patientId: l.patient_id || null,
              itemName: l.item_name || catalogLinkOf(String(l.delivery_id)),
              amountCents: l.amountCents,
            }));
            const n = await splitSaleAcrossDeliveries(c, parts);
            if (n) { multiSplitRings += 1; multiSplitChildren += n; for (const p of parts) matchedDeliveryIds.add(p.deliveryId); }
            continue;
          }
          if (usable.length === 1 && usable[0].amountCents === c.cents) {
            // Single COD line covering the whole payment — plain link stamp.
            const l = usable[0];
            usedSaleKeys.add(c.key);
            matchedDeliveryIds.add(String(l.delivery_id));
            const stamp = { sale_class: 'cod_collection', delivery_id: l.delivery_id, patient_id: l.patient_id || null, cod_item_name: l.item_name || catalogLinkOf(String(l.delivery_id)) || null };
            const rec = entries.get(c.key);
            if (rec) { Object.assign(rec, stamp); backfillLinks += 1; }
            else if (c.existingId) {
              await base44.asServiceRole.entities.SquareLedgerEntry.update(c.existingId, stamp)
                .then(() => { backfillRepairs += 1; }).catch(() => {});
              await sleep(40);
            }
            const codType = String(c.brand || '').toUpperCase() === 'INTERAC' ? 'Debit' : 'Credit';
            if (await confirmCodDeliveryWithCard(base44, String(l.delivery_id), codType, c.cents)) backfillTypeSyncs += 1;
            continue;
          }
          unresolved.push(c);
        }

        // Sales with NO order_id at all go straight to strategy 2 (no
        // fingerprint exclusion either — see candSales note above).
        const orderlessCands = salePool.filter((x) =>
          !usedSaleKeys.has(x.key) && !x.orderId && x.cents > 0 &&
          (nowMs - x.at) < 30 * 86400000 &&
          matchableSums.has(x.cents)
        ).sort((a, b) => b.at - a.at).slice(0, 12);
        unresolved.push(...orderlessCands);

        // STRATEGY 2: subset-sum across uncollected CODs, day-scoped.
        const edmontonDayNum = (ms: number) => Math.floor((ms - 21600000) / 86400000);
        const dayNumByDelivery = new Map<string, number>();
        for (const d of splitPool) {
          const anchor = Date.parse(`${d.date || '1970-01-01'}T06:00:00Z`);
          dayNumByDelivery.set(d.id, Number.isFinite(anchor) ? edmontonDayNum(anchor) : -1);
        }
        for (const c of unresolved) {
          const saleDay = edmontonDayNum(c.at);
          const near = splitPool
            .filter((d: any) => {
              const dn = dayNumByDelivery.get(d.id) ?? -1;
              return dn >= 0 && saleDay - dn >= 0 && saleDay - dn <= 3 && !matchedDeliveryIds.has(d.id);
            })
            .sort((a: any, b: any) => (dayNumByDelivery.get(b.id) ?? 0) - (dayNumByDelivery.get(a.id) ?? 0));
          if (!near.length) continue;
          const capped = near.slice(0, 30);
          let combo: any[] | null = null;
          outer2: for (let i = 0; i < capped.length && !combo; i++) {
            for (let j = i + 1; j < capped.length; j++) {
              if (capped[i].cents + capped[j].cents === c.cents) { combo = [capped[i], capped[j]]; break outer2; }
              for (let k = j + 1; k < capped.length; k++) {
                if (capped[i].cents + capped[j].cents + capped[k].cents === c.cents) { combo = [capped[i], capped[j], capped[k]]; break outer2; }
              }
            }
          }
          if (!combo) continue;
          const parts = combo.map((d: any) => ({
            deliveryId: d.id,
            patientId: d.patientId || null,
            itemName: catalogByDeliveryId.get(d.id)?.item_name || ledgerFormatItemName(d.date, d.abbr, d.patientName),
            amountCents: d.cents,
          }));
          const n = await splitSaleAcrossDeliveries(c, parts);
          if (n) {
            multiSplitRings += 1;
            multiSplitChildren += n;
            for (const p of parts) matchedDeliveryIds.add(p.deliveryId);
          }
        }
      }
    } catch (e: any) {
      syncErrors.push(`multiItemSplit: ${e?.message || e}`);
    }

    // ALREADY-LINKED ROW NAME REPAIR (owner Oct 6): rows linked before the
    // patient-name resolution exists still show "Unknown Patient" (the
    // Square catalog item was named before the patient was known). If the
    // delivery sits in this run's pool with a real resolved name, re-stamp.
    try {
      const itemNameByDeliveryId = new Map<string, string>();
      for (const cd of codDeliveries) {
        if (!itemNameByDeliveryId.has(cd.id)) {
          itemNameByDeliveryId.set(cd.id, ledgerFormatItemName(cd.date, cd.abbr, cd.patientName));
        }
      }
      for (const [sqid, rows] of existingRowsBySquareId) {
        if (entries.has(sqid)) continue;
        const row = rows[0];
        if (!row?.delivery_id) continue;
        if (!['sale', 'collected'].includes(String(row?.entry_kind || ''))) continue;
        const current = String(row?.cod_item_name || '');
        if (current && !current.includes('Unknown Patient')) continue;
        const fixed = itemNameByDeliveryId.get(String(row.delivery_id));
        if (!fixed || fixed.includes('Unknown Patient')) continue;
        await base44.asServiceRole.entities.SquareLedgerEntry.update(row.id, { cod_item_name: fixed })
          .then(() => { backfillRepairs += 1; }).catch(() => {});
        await sleep(40);
      }
    } catch { /* non-fatal */ }
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
      topupsFetched,
      storeTopupsFetched,
      topupsAttributed,
      entriesUpserted: upserted,
      entriesFailed: failedUpserts,
      duplicateRowsDeleted,
      supersededRowsDeleted,
      multiSplitRings,
      multiSplitChildren,
      multiSplitOrdersRetrieved,
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
