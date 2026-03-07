import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

const SQUARE_BASE_URL = 'https://connect.squareup.com/v2';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const accessToken = Deno.env.get('SQUARE_ACCESS_TOKEN');
    if (!accessToken) {
      return Response.json({ error: 'Square credentials not configured' }, { status: 500 });
    }

    // Parse optional body params
    let body = {};
    try { body = await req.json(); } catch {}
    const skipLock = body?.skipLock === true;

    // Get all SquareLocationConfigs
    const locationConfigs = await base44.asServiceRole.entities.SquareLocationConfig.filter({ status: 'active' });
    const locationIds = locationConfigs.map(lc => lc.square_location_id).filter(Boolean);
    const defaultLocationId = Deno.env.get('SQUARE_LOCATION_ID');
    if (defaultLocationId && !locationIds.includes(defaultLocationId)) {
      locationIds.push(defaultLocationId);
    }
    if (locationIds.length === 0) {
      return Response.json({ error: 'No Square locations configured' }, { status: 400 });
    }

    // TTL lock (5 minutes) — prevents concurrent runs
    if (!skipLock) {
      try {
        const lockKey = 'square:catalog:lock';
        const now = Date.now();
        const locks = await base44.asServiceRole.entities.AppSettings.filter({ setting_key: lockKey }, '-updated_date', 1);
        const existing = Array.isArray(locks) ? locks[0] : null;
        const expiresAt = existing?.setting_value?.expires_at ? new Date(existing.setting_value.expires_at).getTime() : 0;
        if (expiresAt && expiresAt > now) {
          return Response.json({ success: true, lock_active: true, next_allowed_at: existing.setting_value.expires_at });
        }
        const newExpires = new Date(now + 5 * 60 * 1000).toISOString();
        if (existing) {
          await base44.asServiceRole.entities.AppSettings.update(existing.id, { setting_value: { owner: user.id, expires_at: newExpires } });
        } else {
          await base44.asServiceRole.entities.AppSettings.create({ setting_key: lockKey, setting_value: { owner: user.id, expires_at: newExpires } });
        }
      } catch (_) {}
    }

    // Load stores and build abbreviation → locationId map
    const stores = await base44.asServiceRole.entities.Store.list();
    const storeById = new Map((stores || []).map(s => [s.id, s]));
    const storeAbbrToLocId = new Map();
    for (const s of stores || []) {
      const cfg = locationConfigs.find(lc => lc.id === s.square_location_config_id);
      if (s?.abbreviation && cfg?.square_location_id) {
        storeAbbrToLocId.set(s.abbreviation, cfg.square_location_id);
      }
    }

    const normalizeName = (n) => {
      const s = (n || '').trim();
      const noAmt = s.replace(/\s-\s\$\d+(?:\.\d{2})?$/, '');
      const unified = noAmt.replace(/^(\d{2})-(\d{2})/, '$1/$2');
      return unified.toLowerCase();
    };

    const formatItemName = (deliveryDate, storeAbbreviation, patientName) => {
      const d = new Date(`${deliveryDate}T00:00:00`);
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${m}/${day}(${storeAbbreviation || 'XX'})-${patientName || 'Unknown'}`;
    };

    // ======== STEP 1: Get all deliveries with CODs for last 7 days (any status) ========
    console.log('📋 [Step 1] Loading deliveries with CODs for last 14 days...');
    const codDeliveries = [];
    const today = new Date();
    for (let i = 0; i < 14; i++) {
      const d = new Date();
      d.setDate(today.getDate() - i);
      const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const dayDeliveries = await base44.asServiceRole.entities.Delivery.filter({ delivery_date: dateStr });
      for (const del of dayDeliveries) {
        const codRequired = Number(del.cod_total_amount_required || 0);
        const paymentsArr = Array.isArray(del.cod_payments) ? del.cod_payments : [];
        const codFromPayments = paymentsArr.reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
        const codAmount = codRequired > 0 ? codRequired : (codFromPayments > 0 ? codFromPayments : 0);
        if (codAmount <= 0) continue;

        const store = storeById.get(del.store_id);
        const storeAbbr = store?.abbreviation || 'XX';
        let locId = null;
        if (store?.square_location_config_id) {
          const cfg = locationConfigs.find(lc => lc.id === store.square_location_config_id);
          locId = cfg?.square_location_id || null;
        }
        if (!locId) locId = defaultLocationId;
        if (!locId) continue;

        codDeliveries.push({
          ...del,
          _codAmount: codAmount,
          _storeAbbr: storeAbbr,
          _locId: locId,
          _itemName: formatItemName(del.delivery_date, storeAbbr, del.patient_name || del.patient_id || 'Unknown'),
          _priceCents: Math.round(codAmount * 100),
          _paymentsArr: paymentsArr
        });
      }
    }
    console.log(`📋 [Step 1] Found ${codDeliveries.length} deliveries with CODs`);

    // ======== STEP 2: Get Square transactions (payments) for last 14 days ========
    console.log('💳 [Step 2] Fetching Square transactions (expanding line items by quantity)...');
    const soldItems = [];
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    for (const locationId of locationIds) {
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - 14);
      const queryParams = new URLSearchParams({
        location_id: locationId,
        begin_time: startDate.toISOString(),
        end_time: new Date().toISOString(),
        sort_order: 'DESC',
        limit: '100'
      });

      try {
        const paymentsRes = await fetch(`${SQUARE_BASE_URL}/payments?${queryParams.toString()}`, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${accessToken}`, 'Square-Version': '2024-01-18' }
        });

        if (!paymentsRes.ok) {
          console.warn(`Failed payments fetch for ${locationId}: ${paymentsRes.status}`);
          continue;
        }

        const paymentsData = await paymentsRes.json();
        const payments = (paymentsData.payments || []).filter(p => p.status === 'COMPLETED');

        for (const payment of payments) {
          if (!payment.order_id) continue;
          await sleep(120);

          try {
            const orderRes = await fetch(`${SQUARE_BASE_URL}/orders/${payment.order_id}`, {
              method: 'GET',
              headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'Square-Version': '2024-01-18' }
            });
            if (!orderRes.ok) continue;
            const orderData = await orderRes.json();
            const order = orderData.order;
            if (!order?.line_items) continue;

            for (const lineItem of order.line_items) {
              // Each line item may have quantity > 1, meaning multiple catalog items sold in one transaction
              const quantity = parseInt(lineItem.quantity || '1', 10);
              const unitPriceCents = lineItem.base_price_money?.amount || 0;
              const variationCatalogId = lineItem.catalog_object_id || null;
              // Also check catalog_version and variation data for deeper matching
              const itemName = lineItem.name || 'Unknown';

              // Emit one sold record per unit quantity so the soldLookup correctly counts each sold item
              for (let q = 0; q < quantity; q++) {
                soldItems.push({
                  catalog_object_id: variationCatalogId,
                  location_id: payment.location_id,
                  payment_id: payment.id,
                  square_transaction_id: payment.id,
                  order_id: payment.order_id,
                  item_name: itemName,
                  amount: unitPriceCents / 100,
                  amount_cents: unitPriceCents,
                  payment_date: payment.created_at,
                  payment_method: payment.payment_source_type || 'UNKNOWN',
                  quantity_index: q // track which unit this is within the line item
                });
              }
            }
          } catch (e) {
            console.warn(`Order fetch failed: ${e.message}`);
          }
        }
      } catch (e) {
        console.warn(`Payments fetch failed for ${locationId}: ${e.message}`);
      }
    }
    console.log(`💳 [Step 2] Found ${soldItems.length} sold items across all locations`);

    // Build sold lookup as a Map with counts (to handle multiple units of the same item)
    // Key: location|normalizedName|priceCents → count of how many were sold
    const soldCountMap = new Map();
    // Also build a direct catalog_object_id lookup for variation-level matching
    const soldByCatalogObjId = new Map();

    for (const si of soldItems) {
      const nameKey = `${si.location_id}|${normalizeName(si.item_name)}|${Math.round((Number(si.amount) || 0) * 100)}`;
      soldCountMap.set(nameKey, (soldCountMap.get(nameKey) || 0) + 1);

      // Track by catalog_object_id (variation ID) for direct matching
      if (si.catalog_object_id) {
        const cidKey = `${si.location_id}|${si.catalog_object_id}`;
        soldByCatalogObjId.set(cidKey, (soldByCatalogObjId.get(cidKey) || 0) + 1);
      }
    }

    console.log(`💳 [Step 2] Built sold lookup: ${soldCountMap.size} unique name keys, ${soldByCatalogObjId.size} unique catalog ID keys`);

    // Helper to check if an item has been sold (decrements count to handle duplicates)
    const checkAndConsumeSold = (locationId, name, priceCents, variationId) => {
      // First try direct variation ID match (most reliable)
      if (variationId) {
        const cidKey = `${locationId}|${variationId}`;
        const cidCount = soldByCatalogObjId.get(cidKey) || 0;
        if (cidCount > 0) {
          soldByCatalogObjId.set(cidKey, cidCount - 1);
          // Also decrement the name-based count to stay in sync
          const nameKey = `${locationId}|${normalizeName(name)}|${priceCents}`;
          const nameCount = soldCountMap.get(nameKey) || 0;
          if (nameCount > 0) soldCountMap.set(nameKey, nameCount - 1);
          return true;
        }
      }
      // Fall back to name+price matching
      const nameKey = `${locationId}|${normalizeName(name)}|${priceCents}`;
      const nameCount = soldCountMap.get(nameKey) || 0;
      if (nameCount > 0) {
        soldCountMap.set(nameKey, nameCount - 1);
        return true;
      }
      return false;
    };

    // Non-consuming check for Step 5 (skip creation if already sold)
    const isSold = (locationId, name, priceCents, variationId) => {
      if (variationId) {
        const cidKey = `${locationId}|${variationId}`;
        if ((soldByCatalogObjId.get(cidKey) || 0) > 0) return true;
      }
      const nameKey = `${locationId}|${normalizeName(name)}|${priceCents}`;
      return (soldCountMap.get(nameKey) || 0) > 0;
    };

    // ======== STEP 3: Get all Square catalog items ========
    console.log('📦 [Step 3] Fetching Square catalog items...');
    const catalogItems = [];
    let cursor = null;
    do {
      const searchBody = { object_types: ['ITEM'], include_related_objects: true, limit: 100 };
      if (cursor) searchBody.cursor = cursor;

      const searchRes = await fetch(`${SQUARE_BASE_URL}/catalog/search`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'Square-Version': '2024-01-18' },
        body: JSON.stringify(searchBody)
      });

      if (!searchRes.ok) break;
      const searchData = await searchRes.json();

      if (searchData.objects) {
        for (const item of searchData.objects) {
          if (item.type !== 'ITEM' || !item.item_data) continue;
          const itemVariations = item.item_data.variations || [];
          for (const variation of itemVariations) {
            const presentAtLocations = variation.present_at_location_ids || item.present_at_location_ids || [];
            const isAtOurLocation = locationIds.some(locId => presentAtLocations.includes(locId) || item.present_at_all_locations === true);
            if (!isAtOurLocation) continue;

            let priceCents = 0;
            if (variation.item_variation_data?.price_money) {
              priceCents = variation.item_variation_data.price_money.amount || 0;
            }

            const abbrMatch = (item.item_data.name || '').match(/\(([^)]+)\)/);
            const inferredLocId = abbrMatch ? storeAbbrToLocId.get(abbrMatch[1]) : null;
            let locationId = null;
            if (inferredLocId && (item.present_at_all_locations === true || presentAtLocations.includes(inferredLocId))) {
              locationId = inferredLocId;
            } else if (item.present_at_all_locations) {
              locationId = locationIds[0];
            } else {
              locationId = presentAtLocations.find(locId => locationIds.includes(locId)) || inferredLocId || locationIds[0];
            }

            catalogItems.push({
              catalog_object_id: item.id,
              variation_id: variation.id,
              name: item.item_data.name || 'Unknown',
              description: item.item_data.description || '',
              price_cents: priceCents,
              price_dollars: priceCents / 100,
              location_id: locationId,
              present_at_locations: presentAtLocations,
              present_at_all: item.present_at_all_locations || false,
              updated_at: item.updated_at,
              version: item.version
            });
            break; // one variation per item
          }
        }
      }
      cursor = searchData.cursor;
    } while (cursor);

    // Deduplicate
    const seenIds = new Set();
    const dedupedCatalogItems = [];
    for (const ci of catalogItems) {
      if (!seenIds.has(ci.catalog_object_id)) {
        seenIds.add(ci.catalog_object_id);
        dedupedCatalogItems.push(ci);
      }
    }
    console.log(`📦 [Step 3] Found ${dedupedCatalogItems.length} catalog items (after dedupe)`);

    // Build catalog lookup: location|normalizedName|priceCents
    const catalogLookup = new Set(
      dedupedCatalogItems.map(ci => `${ci.location_id}|${normalizeName(ci.name)}|${ci.price_cents}`)
    );

    // ======== STEP 4: Delete catalog items that have matching transactions ========
    console.log('🗑️ [Step 4] Checking for catalog items to delete (matched transactions)...');
    const deletedItems = [];

    for (const ci of dedupedCatalogItems) {
      // Check by variation_id first (direct match), then by name+price
      if (checkAndConsumeSold(ci.location_id, ci.name, ci.price_cents, ci.variation_id)) {
        // This catalog item has a matching transaction — delete it
        const key = `${ci.location_id}|${normalizeName(ci.name)}|${ci.price_cents}`;
        try {
          await fetch(`${SQUARE_BASE_URL}/catalog/object/${ci.catalog_object_id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${accessToken}`, 'Square-Version': '2024-01-18' }
          });
          deletedItems.push({ catalog_object_id: ci.catalog_object_id, name: ci.name, reason: 'matched_transaction' });
          catalogLookup.delete(key);
          console.log(`  🗑️ Deleted: ${ci.name} (matched sold transaction via ID or name+price)`);
          await sleep(300);
        } catch (e) {
          console.warn(`  Failed to delete ${ci.name}: ${e.message}`);
        }
      }
    }

    // Also delete catalog items for failed/cancelled deliveries
    for (const del of codDeliveries) {
      if (del.status !== 'failed' && del.status !== 'cancelled') continue;
      const key = `${del._locId}|${normalizeName(del._itemName)}|${del._priceCents}`;
      if (!catalogLookup.has(key)) continue;

      const matchingCi = dedupedCatalogItems.find(ci =>
        ci.location_id === del._locId &&
        normalizeName(ci.name) === normalizeName(del._itemName) &&
        ci.price_cents === del._priceCents
      );
      if (!matchingCi) continue;

      try {
        await fetch(`${SQUARE_BASE_URL}/catalog/object/${matchingCi.catalog_object_id}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${accessToken}`, 'Square-Version': '2024-01-18' }
        });
        deletedItems.push({ catalog_object_id: matchingCi.catalog_object_id, name: matchingCi.name, reason: del.status });
        catalogLookup.delete(key);
        console.log(`  🗑️ Deleted: ${matchingCi.name} (delivery ${del.status})`);
        await sleep(300);
      } catch (e) {
        console.warn(`  Failed to delete for ${del.status} delivery: ${e.message}`);
      }
    }

    console.log(`🗑️ [Step 4] Deleted ${deletedItems.length} catalog items`);

    // ======== STEP 5: Create catalog items for deliveries missing from catalog ========
    console.log('➕ [Step 5] Creating missing catalog items...');
    const createdItems = [];

    for (const del of codDeliveries) {
      // Skip failed/cancelled
      if (del.status === 'failed' || del.status === 'cancelled') continue;

      // Skip Debit/Credit payments (processed at terminal)
      const hasDC = del._paymentsArr.some(p => p?.type === 'Debit' || p?.type === 'Credit');
      const hasDCLegacy = del.cod_payment_type === 'Debit' || del.cod_payment_type === 'Credit';
      if (hasDC || hasDCLegacy) continue;

      const key = `${del._locId}|${normalizeName(del._itemName)}|${del._priceCents}`;

      // Skip if already exists in catalog
      if (catalogLookup.has(key)) continue;

      // Skip if already sold in Square
      if (isSold(del._locId, del._itemName, del._priceCents, null)) continue;

      // Create the catalog item directly via Square API (not via function invoke)
      const locationId = del._locId;
      try {
        const upsertRes = await fetch(`${SQUARE_BASE_URL}/catalog/object`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'Square-Version': '2024-01-18'
          },
          body: JSON.stringify({
            idempotency_key: `sync-create-${del.id}-${del._priceCents}-${locationId}`,
            object: {
              type: 'ITEM',
              id: `#${del.id}`,
              present_at_all_locations: false,
              present_at_location_ids: [locationId],
              item_data: {
                name: del._itemName,
                description: `COD for ${del.patient_name || 'Unknown'} | Delivery ${del.id}`,
                variations: [{
                  type: 'ITEM_VARIATION',
                  id: `#${del.id}-var`,
                  present_at_all_locations: false,
                  present_at_location_ids: [locationId],
                  item_variation_data: {
                    name: 'Regular',
                    pricing_type: 'FIXED_PRICING',
                    price_money: {
                      amount: del._priceCents,
                      currency: 'CAD'
                    },
                    location_overrides: [{
                      location_id: locationId,
                      pricing_type: 'FIXED_PRICING',
                      price_money: {
                        amount: del._priceCents,
                        currency: 'CAD'
                      }
                    }]
                  }
                }]
              }
            }
          })
        });

        const upsertData = await upsertRes.json();

        if (upsertData.errors) {
          console.warn(`  ⚠️ Square API error for ${del._itemName}:`, JSON.stringify(upsertData.errors));
          continue;
        }

        const catalogObjectId = upsertData.catalog_object?.id;
        console.log(`  ➕ Created: ${del._itemName} ($${del._codAmount}) → ${catalogObjectId} @ location ${locationId}`);

        createdItems.push({
          delivery_id: del.id,
          item_name: del._itemName,
          amount: del._codAmount,
          location_id: locationId,
          catalog_object_id: catalogObjectId || null
        });
        catalogLookup.add(key);
        await sleep(300);
      } catch (e) {
        console.warn(`  Failed to create for delivery ${del.id}: ${e.message}`);
      }
    }

    console.log(`➕ [Step 5] Created ${createdItems.length} catalog items`);

    // Build final items list (remaining catalog items after deletions)
    const deletedIds = new Set(deletedItems.map(d => d.catalog_object_id));
    const finalItems = dedupedCatalogItems
      .filter(ci => !deletedIds.has(ci.catalog_object_id))
      .map(ci => ({
        ...ci,
        transaction_id: null,
        delivery_id: null,
        patient_id: null,
        store_id: null,
        status: 'active',
        created_date: ci.updated_at,
        is_sold: false
      }));

    // If we created new items, re-fetch catalog to get their real IDs
    if (createdItems.length > 0) {
      // Add created items to the final list with temporary data
      for (const created of createdItems) {
        if (created.catalog_object_id) {
          finalItems.push({
            catalog_object_id: created.catalog_object_id,
            variation_id: null,
            name: created.item_name,
            description: '',
            price_cents: Math.round(created.amount * 100),
            price_dollars: created.amount,
            location_id: created.location_id,
            present_at_locations: [created.location_id],
            present_at_all: false,
            updated_at: new Date().toISOString(),
            version: 0,
            transaction_id: null,
            delivery_id: created.delivery_id,
            patient_id: null,
            store_id: null,
            status: 'active',
            created_date: new Date().toISOString(),
            is_sold: false
          });
        }
      }
    }

    // ======== STEP 6: Sync SquareTransaction entity to match active catalog items ========
    console.log('💾 [Step 6] Syncing SquareTransaction entity with active catalog items...');

    try {
      // Get all existing pending SquareTransaction records
      const existingTxs = await base44.asServiceRole.entities.SquareTransaction.filter({ status: 'pending' });
      const existingByCatalogId = new Map();
      for (const tx of existingTxs) {
        if (tx.square_catalog_object_id) {
          existingByCatalogId.set(tx.square_catalog_object_id, tx);
        }
      }

      // Build set of active catalog object IDs
      const activeCatalogIds = new Set(finalItems.map(fi => fi.catalog_object_id));

      // Delete SquareTransaction records that are no longer in the catalog
      let deletedTxCount = 0;
      for (const tx of existingTxs) {
        if (tx.square_catalog_object_id && !activeCatalogIds.has(tx.square_catalog_object_id)) {
          await base44.asServiceRole.entities.SquareTransaction.delete(tx.id);
          deletedTxCount++;
        }
      }

      // Create/update SquareTransaction records for active catalog items
      let createdTxCount = 0;
      let updatedTxCount = 0;
      for (const item of finalItems) {
        const existing = existingByCatalogId.get(item.catalog_object_id);
        const txData = {
          square_catalog_object_id: item.catalog_object_id,
          item_name: item.name,
          amount: item.price_dollars,
          amount_cents: item.price_cents,
          type: 'collection',
          status: 'pending',
          delivery_id: item.delivery_id || existing?.delivery_id || item.catalog_object_id,
          location_id: item.location_id,
          store_id: item.store_id || existing?.store_id || null
        };

        if (existing) {
          // Update if name or amount changed
          if (existing.item_name !== item.name || existing.amount !== item.price_dollars || existing.location_id !== item.location_id) {
            await base44.asServiceRole.entities.SquareTransaction.update(existing.id, txData);
            updatedTxCount++;
          }
        } else {
          await base44.asServiceRole.entities.SquareTransaction.create(txData);
          createdTxCount++;
        }
      }

      console.log(`💾 [Step 6] SquareTransaction sync: +${createdTxCount} created, ~${updatedTxCount} updated, -${deletedTxCount} removed`);
    } catch (txSyncError) {
      console.warn('⚠️ [Step 6] SquareTransaction sync failed (non-fatal):', txSyncError.message);
    }

    return Response.json({
      success: true,
      itemCount: finalItems.length,
      items: finalItems,
      soldCatalogItems: soldItems,
      locationIds,
      createdCount: createdItems.length,
      createdItems,
      deletedCount: deletedItems.length,
      deletedItems
    });

  } catch (error) {
    console.error('Error syncing Square catalog:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});