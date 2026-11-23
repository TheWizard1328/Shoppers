import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

/**
 * squarePendingProbe — READ ONLY. Finds a pending (open / authorized) card
 * charge at a Square location and names the store it came from.
 *
 * OWNER QUESTION (Nov 22 2026): a $3.09 card spend shows as pending on the
 * Callingwood card, but it is not a delivery in the system, so nothing in the
 * SquareTransaction mirror explains it. Seven stores share the Callingwood
 * location (L9Q5581TKTVBX), so the location alone cannot attribute it — the
 * ORDER LINE ITEM NAME carries the store prefix, e.g. "11/20(MD)-Name" = Meadows,
 * "(HS)" Hamptons, "(SC)" Scona, "(CW)" Callingwood.
 *
 * This probe asks Square directly (Orders OPEN + Payments not completed) and
 * returns every line item / payment near the amount, with its raw name.
 *
 * Body: { amount_cents?: number, location_id?: string, days?: number }
 * Nothing is written anywhere.
 */
const SQUARE_BASE_URL = 'https://connect.squareup.com';
const SQUARE_VERSION = '2025-01-23';

async function squareFetch(path, method, accessToken, body) {
  const res = await fetch(`${SQUARE_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Square-Version': SQUARE_VERSION
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const msg = (json?.errors || []).map((e) => e.detail).join(', ') || `Square ${res.status}`;
    throw new Error(msg);
  }
  return json;
}

Deno.serve(async (req) => {
  try {
    createClientFromRequest(req); // auth only, nothing is read or written
    const token = Deno.env.get('SQUARE_ACCESS_TOKEN');
    if (!token) return Response.json({ success: false, error: 'Square credentials not configured' }, { status: 500 });

    const body = await req.json().catch(() => ({}));
    const wantCents = Number(body?.amount_cents || 309);
    const locationId = String(body?.location_id || 'L9Q5581TKTVBX'); // Callingwood
    const days = Math.min(Math.max(Number(body?.days) || 30, 1), 90);
    const startAt = new Date(Date.now() - days * 86400000).toISOString();

    // ── OPEN orders (a swipe that is still pending at the POS) ─────────────
    const openOrders = [];
    let cursor = null;
    do {
      const json = await squareFetch('/v2/orders/search', 'POST', token, {
        location_ids: [locationId],
        cursor,
        limit: 500,
        query: {
          filter: { state_filter: { states: ['OPEN'] }, date_time_filter: { created_at: { start_at: startAt } } },
          sort: { sort_field: 'CREATED_AT', sort_order: 'DESC' }
        }
      });
      openOrders.push(...(json?.orders || []));
      cursor = json?.cursor || null;
    } while (cursor && openOrders.length < 2000);

    const orderHits = [];
    for (const o of openOrders) {
      for (const li of o?.line_items || []) {
        const cents = Number(li?.base_price_money?.amount || 0) * (Number(li?.quantity || 1) || 1);
        const total = Number(li?.total_money?.amount || cents);
        if (Math.abs(total - wantCents) > 5 && Math.abs(cents - wantCents) > 5) continue;
        orderHits.push({
          source: 'open_order',
          order_id: o.id,
          order_state: o?.state,
          created_at: o?.created_at,
          closed_at: o?.closed_at || null,
          item_name: li?.name || null,
          note: li?.note || null,
          quantity: li?.quantity || null,
          total_cents: total,
          line_item_uid: li?.uid || null,
          order_total_cents: o?.total_money?.amount ?? null,
          store_prefix: (String(li?.name || '').match(/\(([A-Za-z]{2,4})\)/) || [])[1] || null
        });
      }
    }

    // ── Payments that are authorized but not captured (the "pending" swipe) ─
    const payHits = [];
    let pCursor = null;
    do {
      const qs = new URLSearchParams({
        location_id: locationId,
        begin_time: startAt,
        sort_order: 'DESC',
        limit: '100'
      });
      if (pCursor) qs.set('cursor', pCursor);
      const json = await squareFetch(`/v2/payments?${qs.toString()}`, 'GET', token);
      for (const p of json?.payments || []) {
        if (Math.abs(Number(p?.amount_money?.amount || 0) - wantCents) > 5) continue;
        payHits.push({
          source: 'payment',
          payment_id: p.id,
          status: p?.status || null,
          card_status: p?.card_details?.status || null,
          created_at: p?.created_at || null,
          amount_cents: p?.amount_money?.amount ?? null,
          order_id: p?.order_id || null,
          note: p?.note || null,
          receipt_url: p?.receipt_url || null
        });
      }
      pCursor = json?.cursor || null;
    } while (pCursor);

    return Response.json({
      success: true,
      location_id: locationId,
      window_days: days,
      open_orders_scanned: openOrders.length,
      order_hits: orderHits,
      payment_hits: payHits,
      // When nothing matched, the caller still learns what IS open there.
      open_orders_summary: openOrders.slice(0, 15).map((o) => ({
        order_id: o.id,
        created_at: o.created_at,
        total_cents: o?.total_money?.amount ?? null,
        items: (o?.line_items || []).map((li) => li?.name).slice(0, 5)
      }))
    });
  } catch (e) {
    console.error('[squarePendingProbe] failed:', e?.message || e);
    return Response.json({ success: false, error: e?.message || String(e) }, { status: 500 });
  }
});
