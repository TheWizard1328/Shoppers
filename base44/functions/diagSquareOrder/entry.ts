import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const SQUARE_BASE_URL = 'https://connect.squareup.com';
const SQUARE_VERSION = '2025-01-23';

Deno.serve(async (req: Request) => {
  try {
    const base44 = createClientFromRequest(req);
    const accessToken = Deno.env.get('SQUARE_ACCESS_TOKEN');
    if (!accessToken) return Response.json({ error: 'no token' }, { status: 500 });

    const cfgs = await base44.asServiceRole.entities.SquareLocationConfig.list('-updated_date', 500).catch(() => []);
    const locIds = Array.from(new Set((cfgs || []).filter((c: any) => c?.status === 'active').map((c: any) => c?.square_location_id).filter(Boolean)));

    const body = {
      location_ids: locIds,
      query: {
        filter: {
          date_time_filter: { created_at: { start_at: '2026-07-16T00:00:00Z', end_at: '2026-07-17T00:00:00Z' } },
          state_filter: { states: ['COMPLETED'] },
        },
      },
      limit: 200,
    };
    const r = await fetch(`${SQUARE_BASE_URL}/v2/orders/search`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'Square-Version': SQUARE_VERSION },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    const orders = j?.orders || [];
    const target = orders.find((o: any) => Number(o?.total_money?.amount) === 1327);
    return Response.json({
      totalOrders: orders.length,
      target: target ? {
        id: target.id,
        state: target.state,
        created_at: target.created_at,
        total: target.total_money,
        line_items: (target.line_items || []).map((li: any) => ({
          uid: li.uid, name: li.name, catalog_object_id: li.catalog_object_id,
          catalog_version: li.catalog_version, base_price_money: li.base_price_money,
          quantity: li.quantity,
        })),
      } : null,
      error: j?.errors || null,
    });
  } catch (e: any) {
    return Response.json({ error: e?.message || String(e) }, { status: 500 });
  }
});
