// squareTransferPeek — read-only diagnostic (owner, Oct 3 2026):
// "can we pull fund-transfer records (Folder savings -> card balance,
// card -> card)?" Pulls the Payouts API (ListPayouts + ListPayoutEntries,
// PAYOUTS_READ) for the last N days and returns the RAW JSON so we can see
// exactly how transfers (BALANCE_FOLDERS_TRANSFER, MONEY_TRANSFER,
// AUTOMATIC_SAVINGS[_REVERSED], etc.) surface. Read-only, admin-gated,
// same env SQUARE_ACCESS_TOKEN posture as squareLedgerSync.

const SQUARE_BASE_URL = 'https://connect.squareup.com';
const SQUARE_VERSION = '2025-01-23';

async function handleRequest(req: Request): Promise<Response> {
  const { createClientFromRequest } = await import('npm:@base44/sdk@0.8.31');
  const base44 = createClientFromRequest(req);
  const isAuthenticated = await base44.auth.isAuthenticated().catch(() => false);
  if (isAuthenticated) {
    const user = await base44.auth.me().catch(() => null);
    if (user && !['admin', 'app_owner'].includes(String(user.role || '').toLowerCase())) {
      throw Object.assign(new Error('Forbidden: Admin access required'), { status: 403 });
    }
  }

  const payload = await req.json().catch(() => ({}));
  const accessToken = Deno.env.get('SQUARE_ACCESS_TOKEN');
  if (!accessToken) throw Object.assign(new Error('Square credentials not configured'), { status: 500 });

  const days = Math.max(1, Math.min(90, Number(payload?.days) || 14));
  const begin = new Date(Date.now() - days * 86400000).toISOString();
  const withEntries = payload?.entries !== false;

  const sf = async (path: string) => {
    const r = await fetch(`${SQUARE_BASE_URL}${path}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Square-Version': SQUARE_VERSION,
      },
    });
    const json = await r.json().catch(() => ({}));
    if (!r.ok) return { error: r.status, detail: json?.errors?.map((e: any) => e?.detail).join(', ') || String(json) };
    return json;
  };

  // Payouts are account-level; query without location filter.
  const payouts: any[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 10; page++) {
    const path = `/v2/payouts?begin_time=${encodeURIComponent(begin)}&sort_order=DESC${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const json: any = await sf(path);
    if (json.error) return new Response(JSON.stringify({ success: false, stage: 'list-payouts', apiError: json }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    payouts.push(...(json.payouts || []));
    cursor = json.cursor || null;
    if (!cursor) break;
  }

  // Pull entries per payout (the money movements: charges, fees, folder transfers...).
  const byPayout: any[] = [];
  if (withEntries) {
    for (const p of payouts.slice(0, 25)) {
      const ents: any[] = [];
      let ec: string | null = null;
      for (let page = 0; page < 10; page++) {
        const json: any = await sf(`/v2/payouts/${p.id}/payout-entries${ec ? `?cursor=${encodeURIComponent(ec)}` : ''}`);
        if (json.error) { byPayout.push({ payout_id: p.id, entriesError: json }); break; }
        ents.push(...(json.payout_entries || []));
        ec = json.cursor || null;
        if (!ec) { byPayout.push({ payout_id: p.id, entries: ents }); break; }
      }
    }
  }

  // Summary: entry types found + transfer-looking entries.
  const typeCounts: Record<string, number> = {};
  const transfers: any[] = [];
  for (const bp of byPayout) {
    for (const e of bp.entries || []) {
      const t = String(e?.type || '?');
      typeCounts[t] = (typeCounts[t] || 0) + 1;
      if (/TRANSFER|SAVINGS|MONEY_TRANSFER|PAYOUT|OTHER/.test(t)) {
        transfers.push({ id: e?.id, payout_id: e?.payout_id, type: t, effective_at: e?.effective_at, amount: e?.net_amount_money?.amount, fee: e?.fee_amount_money?.amount });
      }
    }
  }

  return new Response(JSON.stringify({
    success: true,
    window_days: days,
    payouts_count: payouts.length,
    payout_destinations: Array.from(new Set(payouts.map((p: any) => [p?.destination?.type, p?.type, p?.status].join('|')))),
    payouts: payouts.map((p: any) => ({ id: p.id, type: p.type, status: p.status, amount: p?.amount_money?.amount, created_at: p.created_at, arriving: p?.arriving_date, destination: p?.destination?.type, location_id: p?.location_id })),
    payout_entry_type_counts: typeCounts,
    transfer_entries: transfers,
    by_payout: byPayout,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

Deno.serve(handleRequest);
