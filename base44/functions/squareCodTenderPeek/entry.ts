/**
 * squareCodTenderPeek — auto-detect the tender type of a just-completed
 * Square POS swipe (owner spec Oct 9 2026):
 *   "After the money is on Square and I click back to the app, send back the
 *    type of transaction — debit (Interac) sets the collection type to Debit,
 *    Visa / Mastercard / any credit card sets it to Credit."
 *
 * Called by the COD collection panel when the app regains focus after a POS
 * handoff. Matches the newest COMPLETED card payment by exact amount since
 * the POS launch timestamp (with optional store location and driver
 * team-member preference), and reports Square's card_brand / entry_method so
 * the delivery's cod_payments entry can be stamped:
 *   card_brand INTERAC  → collection type 'Debit'
 *   anything else (VISA, MASTERCARD, AMEX, DISCOVER, ...) → 'Credit'
 *   entry_method KEYED  → keyed-in credit (higher fee — data preserved for
 *                         the reconcile fee sheet)
 */

import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

class HttpError extends Error { constructor(s, m) { super(m); this.status = s; } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const requireUser = async (b44) => { const u = await b44.auth.me().catch(() => null); if (!u) throw new HttpError(401, 'Unauthorized'); return u; };
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

const normStr = (v) => String(v || '').toLowerCase().trim().replace(/\s+/g, ' ');
const nameMatchesDriver = (squareName, driverName) => {
  if (!squareName || !driverName) return false;
  const sq = normStr(squareName);
  const dr = normStr(driverName);
  const [sqGiven = '', sqFamily = ''] = sq.split(' ');
  if (sqGiven.length >= 3 && (dr.includes(sqGiven) || sqGiven.includes(dr.split(' ')[0]))) return true;
  if (sqFamily.length >= 1 && dr.includes(sqFamily[0]) && sqGiven.length >= 3 && dr.includes(sqGiven)) return true;
  return dr.includes(sq) || sq.includes(dr);
};

async function handleCodTenderPeek(payload) {
  const accessToken = ensureSquareToken();
  const { amountCents, locationId, driverName, sinceMs } = payload || {};

  const amount = Math.round(Number(amountCents || 0));
  if (amount <= 0) throw new HttpError(400, 'amountCents is required');

  // Search window: from (POS launch − 2 min slack) to now, newest-first.
  const since = new Date(Math.max(0, Number(sinceMs || Date.now()) - 2 * 60 * 1000));
  const params = new URLSearchParams({
    begin_time: since.toISOString(),
    sort_order: 'DESC',
    limit: '50',
  });

  const json = await squareFetch(`/v2/payments?${params.toString()}`, 'GET', accessToken, null);
  const payments = (json?.payments || []).filter(Boolean);

  // Card payments with the exact amount; prefer COMPLETED, then APPROVED.
  const candidates = payments.filter((p) => {
    if (Number(p?.amount_money?.amount) !== amount) return false;
    if (!p?.card_details?.card?.card_brand) return false; // skip cash / other tenders
    const st = String(p?.status || '').toUpperCase();
    return ['COMPLETED', 'APPROVED'].includes(st);
  });

  if (!candidates.length) {
    return { matched: false, reason: 'no_card_payment_match' };
  }

  // Optional store filter: if a location was passed, prefer its payments but
  // do not hard-fail (shared cards mean a swipe may land on a sibling store
  // location the driver had active).
  if (locationId) {
    const atLoc = candidates.filter((p) => p?.location_id === locationId);
    if (atLoc.length) candidates.splice(0, candidates.length, ...atLoc);
  }

  // Optional driver preference: two drivers can collect the same COD amount
  // at a shared card store — prefer the invoking driver's swipe when the
  // Square team member can be resolved.
  if (driverName && driverName.trim()) {
    const driverTmIds = new Set();
    for (const p of candidates) {
      const tmId = p?.team_member_id;
      if (!tmId || driverTmIds.has(tmId)) continue;
      try {
        const tmJson = await squareFetch(`/v2/team-members/${tmId}`, 'GET', accessToken, null);
        const tm = tmJson?.team_member;
        const fullName = [tm?.given_name, tm?.family_name].filter(Boolean).join(' ');
        if (fullName && nameMatchesDriver(fullName, driverName)) driverTmIds.add(tmId);
      } catch (_) { /* skip unresolvable */ }
    }
    const byDriver = candidates.filter((p) => driverTmIds.has(p?.team_member_id));
    if (byDriver.length) candidates.splice(0, candidates.length, ...byDriver);
  }

  // Newest first.
  candidates.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  const payment = candidates[0];

  const cardBrand = String(payment?.card_details?.card?.card_brand || '').toUpperCase();
  const entryMethod = String(payment?.card_details?.entry_method || '').toUpperCase();
  const isDebit = cardBrand === 'INTERAC';

  return {
    matched: true,
    card_brand: cardBrand,
    entry_method: entryMethod,
    isDebit,
    tender: isDebit ? 'Debit' : 'Credit',
    payment_id: payment?.id || null,
    created_at: payment?.created_at || null,
    location_id: payment?.location_id || null,
    last_4: payment?.card_details?.card?.last_4 || null,
  };
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const payload = await req.json().catch(() => ({}));
    await requireUser(base44);
    return Response.json(await handleCodTenderPeek(payload));
  } catch (error) {
    const status = error?.status || 500;
    return Response.json({ error: error?.message || 'Internal Server Error' }, { status });
  }
});
