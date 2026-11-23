import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

/**
 * squarePendingSwipes — READ ONLY. Lists card swipes that are live on a Square
 * location but have no delivery behind them yet.
 *
 * OWNER CONTEXT (Nov 22 2026): a store swipes the Callingwood card before the
 * delivery is entered, so the app shows a pending card spend it cannot explain.
 * Seven stores share that location, so the location alone cannot attribute it.
 * Two Square-side signals identify the swipe:
 *   1. a payment in APPROVED / card AUTHORIZED state (swiped, not captured), and
 *   2. an OPEN order (cart still open at the POS).
 * The store is named from the order line item prefix — "11/23(HS)-Name" — using
 * Store.abbreviation (CW Callingwood, HS Hamptons, SC Scona, MD Meadows,
 * LD Londonderry, BD Bonnie Doon, KW Kingsway, SP SouthPoint, WP WestPark,
 * SM Sherwood Pk Mall, LR Lakeland Ridge).
 *
 * Body: { hours?: number, location_ids?: string[] }
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

const prefixOf = (name) => {
  const m = String(name || '').match(/\(([A-Za-z]{2,4})\)/);
  return m ? m[1].toUpperCase() : null;
};

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const token = Deno.env.get('SQUARE_ACCESS_TOKEN');
    if (!token) return Response.json({ success: false, error: 'Square credentials not configured' }, { status: 500 });

    const body = await req.json().catch(() => ({}));
    const hours = Math.min(Math.max(Number(body?.hours) || 18, 1), 72);
    const startAt = new Date(Date.now() - hours * 3600000).toISOString();

    // ── location + store maps ────────────────────────────────────────────────
    const [configs, stores] = await Promise.all([
      base44.asServiceRole.entities.SquareLocationConfig.list('-updated_date', 200).catch(() => []),
      base44.asServiceRole.entities.Store.list('name', 500).catch(() => [])
    ]);

    const configById = new Map();
    for (const c of configs || []) {
      const loc = String(c?.square_location_id || '').trim();
      if (loc) configById.set(String(c.id), loc);
    }
    const storeByAbbr = new Map();
    const storeByConfig = new Map();
    for (const s of stores || []) {
      const abbr = String(s?.abbreviation || '').trim().toUpperCase();
      if (abbr) storeByAbbr.set(abbr, { id: s.id, name: s.name || abbr, abbr });
      const cfg = s?.square_location_config_id ? String(s.square_location_config_id) : '';
      if (cfg) {
        const list = storeByConfig.get(cfg) || [];
        list.push(s.name || abbr);
        storeByConfig.set(cfg, list);
      }
    }

    const requested = Array.isArray(body?.location_ids) ? body.location_ids.map(String) : [];
    const locationIds = (requested.length ? requested : Array.from(new Set(configById.values()))).filter(Boolean);
    if (!locationIds.length) return Response.json({ success: true, by_location: {}, total: 0 });

    const byLocation = {};
    let total = 0;

    for (const locationId of locationIds) {
      const rows = new Map(); // key = order_id || payment_id

      // 1. Payments swiped but not captured ──────────────────────────────────
      let cursor = null;
      let pages = 0;
      do {
        const qs = new URLSearchParams({ location_id: locationId, begin_time: startAt, sort_order: 'DESC', limit: '100' });
        if (cursor) qs.set('cursor', cursor);
        const json = await squareFetch(`/v2/payments?${qs.toString()}`, 'GET', token);
        for (const p of json?.payments || []) {
          const status = String(p?.status || '').toUpperCase();
          const cardStatus = String(p?.card_details?.status || '').toUpperCase();
          const live = status === 'APPROVED' || status === 'PENDING' || cardStatus === 'AUTHORIZED';
          if (!live) continue;
          const key = String(p?.order_id || p?.id || '');
          if (!key) continue;
          rows.set(key, {
            key,
            source: 'payment',
            amount_cents: Number(p?.amount_money?.amount || 0),
            created_at: p?.created_at || null,
            status: status || cardStatus || null,
            order_id: p?.order_id || null,
            payment_id: p?.id || null,
            item_name: null,
            store_id: null,
            store_name: null,
            store_abbr: null
          });
        }
        cursor = json?.cursor || null;
        pages++;
      } while (cursor && pages < 5);

      // 2. Open carts at the POS ──────────────────────────────────────────────
      let orderCursor = null;
      let orderPages = 0;
      const openOrders = [];
      do {
        const json = await squareFetch('/v2/orders/search', 'POST', token, {
          location_ids: [locationId],
          cursor: orderCursor,
          limit: 500,
          query: {
            filter: { state_filter: { states: ['OPEN'] }, date_time_filter: { created_at: { start_at: startAt } } },
            sort: { sort_field: 'CREATED_AT', sort_order: 'DESC' }
          }
        });
        openOrders.push(...(json?.orders || []));
        orderCursor = json?.cursor || null;
        orderPages++;
      } while (orderCursor && orderPages < 4);

      const attributeFromOrder = (order) => {
        const items = order?.line_items || [];
        let name = null;
        let abbr = null;
        for (const li of items) {
          const a = prefixOf(li?.name);
          if (a) { abbr = a; name = li?.name || null; break; }
          if (!name && li?.name) name = li.name;
        }
        const store = abbr ? storeByAbbr.get(abbr) : null;
        return { name, abbr, store };
      };

      for (const o of openOrders) {
        const key = String(o.id);
        const { name, abbr, store } = attributeFromOrder(o);
        const existing = rows.get(key);
        const amount = Number(o?.total_money?.amount ?? 0);
        if (existing) {
          existing.item_name = name || existing.item_name;
          existing.store_abbr = abbr || existing.store_abbr;
          if (store) { existing.store_id = store.id; existing.store_name = store.name; }
          if (!existing.amount_cents && amount) existing.amount_cents = amount;
        } else {
          rows.set(key, {
            key,
            source: 'open_order',
            amount_cents: amount,
            created_at: o?.created_at || null,
            status: 'OPEN',
            order_id: o.id,
            payment_id: null,
            item_name: name,
            store_id: store?.id || null,
            store_name: store?.name || null,
            store_abbr: abbr
          });
        }
      }

      // 3. Pending payments with no open cart: read the order for the prefix ──
      for (const row of rows.values()) {
        if (row.item_name || !row.order_id) continue;
        const order = await squareFetch(`/v2/orders/${row.order_id}`, 'GET', token).then((r) => r?.order).catch(() => null);
        if (!order) continue;
        const { name, abbr, store } = attributeFromOrder(order);
        row.item_name = name;
        row.store_abbr = abbr;
        if (store) { row.store_id = store.id; row.store_name = store.name; }
      }

      const list = Array.from(rows.values())
        .filter((r) => Number(r.amount_cents) > 0)
        .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));

      if (list.length) {
        byLocation[locationId] = list;
        total += list.length;
      }
    }

    // Which stores share each location — the reason attribution is needed.
    const shared = {};
    for (const [cfgId, names] of storeByConfig.entries()) {
      const loc = configById.get(cfgId);
      if (loc && names.length > 1) shared[loc] = names;
    }

    return Response.json({
      success: true,
      window_hours: hours,
      generated_at: new Date().toISOString(),
      total,
      by_location: byLocation,
      shared_locations: shared
    });
  } catch (e) {
    console.error('[squarePendingSwipes] failed:', e?.message || e);
    return Response.json({ success: false, error: e?.message || String(e) }, { status: 500 });
  }
});
