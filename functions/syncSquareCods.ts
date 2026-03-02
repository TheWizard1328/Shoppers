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
    const deletions = Array.isArray(body?.deletions) ? body.deletions : [];
    const scanMode = (!items.length && !deletions.length) || body?.scan === true;

    const SQUARE_ACCESS_TOKEN = Deno.env.get('SQUARE_ACCESS_TOKEN');
    if (!SQUARE_ACCESS_TOKEN) {
      return Response.json({ error: 'Square access token missing' }, { status: 500 });
    }

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // Resolve Square Location per Store with simple in-memory cache
    const storeCache = new Map();
    const locationConfigCache = new Map();
    async function getSquareLocationIdForStore(storeId) {
      if (!storeId) return null;
      if (locationConfigCache.has(storeId)) return locationConfigCache.get(storeId);
      try {
        let store = storeCache.get(storeId);
        if (!store) {
          const stores = await base44.entities.Store.filter({ id: storeId });
          store = stores?.[0];
          if (store) storeCache.set(storeId, store);
        }
        const cfgId = store?.square_location_config_id;
        if (!cfgId) {
          locationConfigCache.set(storeId, null);
          return null;
        }
        const cfgs = await base44.entities.SquareLocationConfig.filter({ id: cfgId });
        const cfg = cfgs?.[0];
        const locId = cfg?.square_location_id || null;
        locationConfigCache.set(storeId, locId);
        return locId;
      } catch (_) {
        return null;
      }
    }

    async function updateItemLocation(itemId, locationId) {
      if (!itemId || !locationId) return null;
      const payload = {
        idempotency_key: `locfix-${itemId}-${locationId}`,
        batches: [{
          objects: [{
            type: 'ITEM',
            id: itemId,
            present_at_all_locations: false,
            present_at_location_ids: [locationId],
            item_data: {
              present_at_all_locations: false,
              present_at_location_ids: [locationId],
            },
          }]
        }]
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
        const t = await res.text();
        throw new Error(`Square location fix failed: ${res.status} ${t}`);
      }
      return res.json();
    }

    async function updateVariationLocation(variationId, locationId) {
      if (!variationId || !locationId) return null;
      const payload = {
        idempotency_key: `varlocfix-${variationId}-${locationId}`,
        batches: [{
          objects: [{
            type: 'ITEM_VARIATION',
            id: variationId,
            present_at_all_locations: false,
            present_at_location_ids: [locationId],
            item_variation_data: {
              present_at_all_locations: false,
              present_at_location_ids: [locationId],
            },
          }]
        }]
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
        const t = await res.text();
        throw new Error(`Square variation location fix failed: ${res.status} ${t}`);
      }
      return res.json();
    }

    async function enforceItemLocation(itemName, locationId) {
      if (!itemName || !locationId) return { fixed: 0 };
      const searchPayload = {
        include_deleted_objects: false,
        include_related_objects: true,
        object_types: ['ITEM'],
        query: { text_query: { keywords: [itemName] } }
      };
      const searchRes = await fetch('https://connect.squareup.com/v2/catalog/search', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${SQUARE_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
          'Square-Version': '2023-12-13',
        },
        body: JSON.stringify(searchPayload),
      });
      if (!searchRes.ok) return { fixed: 0 };
      const data = await searchRes.json();
      const items = Array.isArray(data?.objects) ? data.objects.filter(o => o?.type === 'ITEM') : [];
      const related = Array.isArray(data?.related_objects) ? data.related_objects : [];
      const varsByItem = new Map();
      for (const ro of related) {
        if (ro?.type === 'ITEM_VARIATION' && ro?.item_variation_data?.item_id) {
          const arr = varsByItem.get(ro.item_variation_data.item_id) || [];
          arr.push(ro);
          varsByItem.set(ro.item_variation_data.item_id, arr);
        }
      }
      let fixed = 0;
      for (const o of items) {
        const atAll = o.present_at_all_locations === true || o?.item_data?.present_at_all_locations === true;
        const locs = o.present_at_location_ids || o?.item_data?.present_at_location_ids || [];
        const hasLoc = Array.isArray(locs) && locs.includes(locationId);
        const needsFix = atAll || !hasLoc || (Array.isArray(locs) && (locs.length !== 1 || locs[0] !== locationId));
        if (needsFix) {
          try { await updateItemLocation(o.id, locationId); fixed += 1; } catch (_) {}
        }
        const variations = varsByItem.get(o.id) || [];
        for (const v of variations) {
          const vatAll = v.present_at_all_locations === true || v?.item_variation_data?.present_at_all_locations === true;
          const vlocs = v.present_at_location_ids || v?.item_variation_data?.present_at_location_ids || [];
          const vHasLoc = Array.isArray(vlocs) && vlocs.includes(locationId);
          const vNeedsFix = vatAll || !vHasLoc || (Array.isArray(vlocs) && (vlocs.length !== 1 || vlocs[0] !== locationId));
          if (vNeedsFix) {
            try { await updateVariationLocation(v.id, locationId); fixed += 1; } catch (_) {}
          }
        }
      }
      return { fixed };
    }

    async function upsertCodItem(item, locationId) {
      const idempotencyKey = `cod-${item.deliveryId}`;
      const d = new Date(((item.deliveryDate || '') + 'T00:00:00'));
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      const abbr = (item.storeAbbreviation || 'ST').trim();
      const amountNum = Number(item.codAmount) || 0;
      const amountCents = Math.round(amountNum * 100);
      const itemName = `${mm}/${dd}(${abbr})-${item.patientName || 'COD'}`;

      const payload = {
        idempotency_key: idempotencyKey,
        batches: [
          {
            objects: [
              {
                type: 'ITEM',
                id: `#${idempotencyKey}`,
                present_at_all_locations: false,
                present_at_location_ids: [locationId],
                item_data: {
                  present_at_all_locations: false,
                  present_at_location_ids: [locationId],
                  name: itemName,
                  description: `COD for ${item.patientName || 'Patient'} | Delivery ${item.deliveryId}`,
                  variations: [
                    {
                      type: 'ITEM_VARIATION',
                      id: `#var-${idempotencyKey}`,
                      present_at_all_locations: false,
                      present_at_location_ids: [locationId],
                      item_variation_data: {
                        present_at_all_locations: false,
                        present_at_location_ids: [locationId],
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

    // Delete COD Catalog Item(s) by exact name and optional amount check
    async function deleteCodByNameAndAmount(item, locationId) {
      const d = new Date(((item.deliveryDate || '') + 'T00:00:00'));
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      const abbr = (item.storeAbbreviation || 'ST').trim();
      const patient = item.patientName || 'COD';
      const amountNum = Number(item.codAmount) || 0;
      const amountCents = Math.round(amountNum * 100);
      const baseName = `${mm}/${dd}(${abbr})-${patient}`;
      const legacyBaseName = `${mm}-${dd}(${abbr})-${patient}`;
      const nameCandidates = [
        baseName,
        legacyBaseName,
        `${baseName} - $${amountNum.toFixed(2)}`,
        `${legacyBaseName} - $${amountNum.toFixed(2)}`
      ];

      // First, ensure any stray global items are corrected to this location
      try { await enforceItemLocation(baseName, locationId); } catch (_) {}

      // Search for ITEMs by name keywords, include related variations for price match
      const searchPayload = {
        include_deleted_objects: false,
        include_related_objects: true,
        object_types: ['ITEM'],
        query: { text_query: { keywords: [baseName] } }
      };

      const searchRes = await fetch('https://connect.squareup.com/v2/catalog/search', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${SQUARE_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
          'Square-Version': '2023-12-13',
        },
        body: JSON.stringify(searchPayload),
      });

      if (!searchRes.ok) {
        const txt = await searchRes.text();
        throw new Error(`Square search failed: ${searchRes.status} ${txt}`);
      }

      const searchData = await searchRes.json();
      const objects = Array.isArray(searchData?.objects) ? searchData.objects : [];
      const related = Array.isArray(searchData?.related_objects) ? searchData.related_objects : [];

      // Filter exact name matches across possible legacy/new formats
      let candidates = objects.filter(o => o.type === 'ITEM' && nameCandidates.includes(o?.item_data?.name));

      // If multiple, try refine by amount via related variations price
      if (candidates.length > 1 && amountCents > 0 && related.length > 0) {
        const priceMatchedItemIds = new Set(
          related
            .filter(ro => ro.type === 'ITEM_VARIATION' && ro?.item_variation_data?.price_money?.amount === amountCents)
            .map(ro => ro?.item_variation_data?.item_id)
            .filter(Boolean)
        );
        const refined = candidates.filter(c => priceMatchedItemIds.has(c.id));
        if (refined.length > 0) candidates = refined;
      }

      // Restrict deletion to items present at this specific location only
      candidates = candidates.filter(c => {
        const locs = c.present_at_location_ids || c?.item_data?.present_at_location_ids || [];
        return Array.isArray(locs) && locs.includes(locationId);
      });

      if (candidates.length === 0) {
        return { deleted: 0, itemName };
      }

      const objectIds = candidates.map(c => c.id);
      const delRes = await fetch('https://connect.squareup.com/v2/catalog/batch-delete', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${SQUARE_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
          'Square-Version': '2023-12-13',
        },
        body: JSON.stringify({ object_ids: objectIds })
      });

      if (!delRes.ok) {
        const txt = await delRes.text();
        throw new Error(`Square delete failed: ${delRes.status} ${txt}`);
      }

      const delData = await delRes.json();
      return { deleted: objectIds.length, itemName, result: delData };
    }

    const results = [];

    // Build deletions from scan mode if needed
    let scanDeletions = [];
    if (scanMode) {
      try {
        const recent = await base44.entities.Delivery.list('-updated_date', 200);
        const stores = await base44.entities.Store.list();
        const storeMap = Object.fromEntries((stores || []).map(s => [s.id, s.abbreviation || 'ST']));
        for (const d of recent || []) {
          if (!d || !d.store_id || !d.delivery_date || !(d.cod_total_amount_required > 0)) continue;
          const storeAbbr = storeMap[d.store_id] || 'ST';
          const patientName = d.patient_name || 'COD';
          if (d.status === 'failed') {
            scanDeletions.push({
              deliveryId: d.id,
              patientName,
              storeAbbreviation: storeAbbr,
              codAmount: d.cod_total_amount_required,
              deliveryDate: d.delivery_date,
              storeId: d.store_id
            });
          } else if (d.status === 'completed') {
            const hasCard = Array.isArray(d.cod_payments) && d.cod_payments.some(p => p && (p.type === 'Debit' || p.type === 'Credit'));
            if (hasCard) {
              scanDeletions.push({
                deliveryId: d.id,
                patientName,
                storeAbbreviation: storeAbbr,
                codAmount: d.cod_total_amount_required,
                deliveryDate: d.delivery_date,
                storeId: d.store_id
              });
            }
          }
        }
      } catch (_) {}
    }

    const allDeletions = [...(deletions || []), ...scanDeletions];

    // Process deletions first (sequential with retries)
    for (const del of allDeletions) {
      const locationId = await getSquareLocationIdForStore(del.storeId);
      if (!locationId) {
        results.push({ deliveryId: del.deliveryId, action: 'delete', status: 'skipped_no_location' });
        continue;
      }
      let attempts = 0; let lastErr = null;
      while (attempts < 3) {
        attempts += 1;
        try {
          const delData = await deleteCodByNameAndAmount(del, locationId);
          try {
            await base44.entities.SquareTransaction.create({
              type: 'collection',
              status: 'completed',
              amount: Number(del.codAmount) || 0,
              amount_cents: Math.round((Number(del.codAmount) || 0) * 100),
              item_name: `${(del.deliveryDate || '').slice(5).replace('-', '/')}(${del.storeAbbreviation || 'ST'})-${del.patientName || 'COD'}`,
              delivery_id: del.deliveryId,
              store_id: del.storeId,
              raw_square_data: { deletion: delData },
            });
          } catch (_) {}
          results.push({ deliveryId: del.deliveryId, action: 'delete', status: 'ok', deleted: delData?.deleted || 0 });
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
                        amount: Number(del.codAmount) || 0,
                        amount_cents: Math.round((Number(del.codAmount) || 0) * 100),
                        item_name: `${(del.deliveryDate || '').slice(5).replace('-', '/')}(${del.storeAbbreviation || 'ST'})-${del.patientName || 'COD'}`,
            delivery_id: del.deliveryId,
            store_id: del.storeId,
            raw_square_data: { error: String(lastErr?.message || lastErr) },
          });
        } catch (_) {}
        results.push({ deliveryId: del.deliveryId, action: 'delete', status: 'failed', error: String(lastErr?.message || lastErr) });
      }
    }

    // Then process upserts (per-store Square location)
    for (const item of items) {
      const locationId = await getSquareLocationIdForStore(item.storeId);
      if (!locationId) {
        results.push({ deliveryId: item.deliveryId, action: 'upsert', status: 'skipped_no_location' });
        continue;
      }
      let attempts = 0;
      let lastErr = null;
      while (attempts < 3) {
        attempts += 1;
        try {
          const data = await upsertCodItem(item, locationId);
          try {
            await base44.entities.SquareTransaction.create({
              type: 'collection',
              status: 'completed',
              amount: Number(item.codAmount) || 0,
              amount_cents: Math.round((Number(item.codAmount) || 0) * 100),
              item_name: `${(item.deliveryDate || '').slice(5).replace('-', '/')}(${item.storeAbbreviation || 'ST'})-${item.patientName || 'COD'}`,
              delivery_id: item.deliveryId,
              store_id: item.storeId,
              raw_square_data: data,
            });
          } catch (_) {}
          // After upsert, fix any stray global items for this name to this location only
          const itemName = `${(item.deliveryDate || '').slice(5).replace('-', '/') }(${item.storeAbbreviation || 'ST'})-${item.patientName || 'COD'}`;
          try { await enforceItemLocation(itemName, locationId); } catch (_) {}
          results.push({ deliveryId: item.deliveryId, action: 'upsert', status: 'ok' });
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
        results.push({ deliveryId: item.deliveryId, action: 'upsert', status: 'failed', error: String(lastErr?.message || lastErr) });
      }
    }

    return Response.json({ success: true, processed: results.length, results, startedAt, finishedAt: new Date().toISOString() });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});