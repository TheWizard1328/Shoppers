import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

// Gentle Square COD batch processor (v1.0.1)
// Payload: { items: [{ deliveryId, patientName, storeAbbreviation, codAmount, deliveryDate, storeId }] }
// Processes sequentially with delays and retries to avoid Square rate limits

Deno.serve(async (req) => {
  const startedAt = new Date().toISOString();
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const bodyText = await req.text();
    let body;
    try { body = JSON.parse(bodyText || '{}'); } catch { body = {}; }
    const items = Array.isArray(body?.items) ? body.items : [];

    if (items.length === 0) {
      return Response.json({ success: true, processed: 0, message: 'No items to process', startedAt });
    }

    const SQUARE_ACCESS_TOKEN = Deno.env.get('SQUARE_ACCESS_TOKEN');
    const SQUARE_LOCATION_ID = Deno.env.get('SQUARE_LOCATION_ID');
    if (!SQUARE_ACCESS_TOKEN || !SQUARE_LOCATION_ID) {
      return Response.json({ error: 'Square configuration missing' }, { status: 500 });
    }

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    async function upsertCodItem(item) {
      const idempotencyKey = `cod-${item.deliveryId}`;
      const itemName = `${(item.deliveryDate || '').slice(5)}(${item.storeAbbreviation || 'ST'})-${item.patientName || 'COD'}`;
      const amountCents = Math.round((Number(item.codAmount) || 0) * 100);

      const payload = {
        idempotency_key: idempotencyKey,
        batches: [
          {
            objects: [
              {
                type: 'ITEM',
                id: `#${idempotencyKey}`,
                item_data: {
                  present_at_all_locations: false,
                  present_at_location_ids: [SQUARE_LOCATION_ID],
                  name: itemName,
                  description: `COD for ${item.patientName || 'Patient'} | Delivery ${item.deliveryId}`,
                  variations: [
                    {
                      type: 'ITEM_VARIATION',
                      id: `#var-${idempotencyKey}`,
                      item_variation_data: {
                        name: 'Default',
                        pricing_type: 'FIXED_PRICING',
                        price_money: { amount: amountCents, currency: 'CAD' },
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      const res = await fetch('https://connect.squareup.com/v2/catalog/batch-upsert', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${SQUARE_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
          'Square-Version': '2023-12-13',
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Square upsert failed: ${res.status} ${text}`);
      }

      const data = await res.json();
      return data;
    }

    const results = [];

    for (const item of items) {
      let attempts = 0;
      let lastErr = null;
      while (attempts < 3) {
        attempts += 1;
        try {
          const data = await upsertCodItem(item);
          try {
            await base44.entities.SquareTransaction.create({
              type: 'collection',
              status: 'completed',
              amount: Number(item.codAmount) || 0,
              amount_cents: Math.round((Number(item.codAmount) || 0) * 100),
              item_name: `${(item.deliveryDate || '').slice(5)}(${item.storeAbbreviation || 'ST'})-${item.patientName || 'COD'}`,
              delivery_id: item.deliveryId,
              store_id: item.storeId,
              raw_square_data: data,
            });
          } catch (_) {}
          results.push({ deliveryId: item.deliveryId, status: 'ok' });
          break;
        } catch (e) {
          lastErr = e;
          const backoffs = [500, 1500, 4000];
          await sleep(backoffs[attempts - 1] || 4000);
        }
      }
      await sleep(350);
      if (lastErr && attempts >= 3) {
        try {
          await base44.entities.SquareTransaction.create({
            type: 'collection',
            status: 'failed',
            amount: Number(item.codAmount) || 0,
            amount_cents: Math.round((Number(item.codAmount) || 0) * 100),
            item_name: `${(item.deliveryDate || '').slice(5)}(${item.storeAbbreviation || 'ST'})-${item.patientName || 'COD'}`,
            delivery_id: item.deliveryId,
            store_id: item.storeId,
            raw_square_data: { error: String(lastErr?.message || lastErr) },
          });
        } catch (_) {}
        results.push({ deliveryId: item.deliveryId, status: 'failed', error: String(lastErr?.message || lastErr) });
      }
    }

    return Response.json({ success: true, processed: results.length, results, startedAt, finishedAt: new Date().toISOString() });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});