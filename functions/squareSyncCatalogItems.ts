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

    // Get all SquareLocationConfigs to get all location IDs
    const locationConfigs = await base44.asServiceRole.entities.SquareLocationConfig.filter({ status: 'active' });
    const locationIds = locationConfigs.map(lc => lc.square_location_id).filter(Boolean);

    // Also include the default location if set
    const defaultLocationId = Deno.env.get('SQUARE_LOCATION_ID');
    if (defaultLocationId && !locationIds.includes(defaultLocationId)) {
      locationIds.push(defaultLocationId);
    }

    // Build store abbreviation → locationId map
    const stores = await base44.asServiceRole.entities.Store.list();
    const storeAbbrToLocId = new Map();
    for (const s of stores || []) {
      const cfg = locationConfigs.find(lc => lc.id === s.square_location_config_id);
      if (s?.abbreviation && cfg?.square_location_id) {
        storeAbbrToLocId.set(s.abbreviation, cfg.square_location_id);
      }
    }

    if (locationIds.length === 0) {
      return Response.json({ error: 'No Square locations configured' }, { status: 400 });
    }

    // Fetch catalog items from Square (limit to 500 items max to prevent timeout)
    const catalogItems = [];
    let cursor = null;
    let fetchedCount = 0;
    const MAX_ITEMS = 500;

    do {
      const searchBody = {
        object_types: ['ITEM'],
        include_related_objects: true,
        limit: 100
      };

      if (cursor) {
        searchBody.cursor = cursor;
      }

      const searchResponse = await fetch(`${SQUARE_BASE_URL}/catalog/search`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Square-Version': '2024-01-18'
        },
        body: JSON.stringify(searchBody)
      });

      if (!searchResponse.ok) {
        const errorData = await searchResponse.json();
        console.error('Square search error:', errorData);
        return Response.json({ error: 'Failed to fetch from Square', details: errorData }, { status: 500 });
      }

      const searchData = await searchResponse.json();
      
      if (searchData.objects) {
        for (const item of searchData.objects) {
          if (item.type === 'ITEM' && item.item_data) {
            const itemVariations = item.item_data.variations || [];
            for (const variation of itemVariations) {
              const presentAtLocations = variation.present_at_location_ids || item.present_at_location_ids || [];
              
              const isAtOurLocation = locationIds.some(locId => 
                presentAtLocations.includes(locId) || 
                item.present_at_all_locations === true
              );

              if (isAtOurLocation) {
                let priceCents = 0;
                if (variation.item_variation_data?.price_money) {
                  priceCents = variation.item_variation_data.price_money.amount || 0;
                }

                // Prefer location inferred from item name store abbreviation
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
                fetchedCount++;
                break;
              }
            }
          }
        }
      }

      cursor = searchData.cursor;
      
      // Stop if we've hit the limit to prevent timeouts
      if (fetchedCount >= MAX_ITEMS) {
        console.warn(`Reached max items limit (${MAX_ITEMS}), stopping fetch`);
        break;
      }
    } while (cursor);

    // Deduplicate catalog items by catalog_object_id
    const seenIds = new Set();
    const dedupedCatalogItems = [];
    for (const ci of catalogItems) {
      if (!seenIds.has(ci.catalog_object_id)) {
        seenIds.add(ci.catalog_object_id);
        dedupedCatalogItems.push(ci);
      }
    }
    console.log(`📦 [SquareSync] Catalog items: ${catalogItems.length} → ${dedupedCatalogItems.length} after dedupe`);

    // Get our existing transactions to match up and identify sold items
    const existingTransactions = await base44.asServiceRole.entities.SquareTransaction.list('-created_date', 500);
    const transactionMap = new Map();
    const soldCatalogIds = new Set();
    
    existingTransactions.forEach(tx => {
      if (tx.square_catalog_object_id) {
        transactionMap.set(tx.square_catalog_object_id, tx);
        // Mark items with completed or refunded status as sold
        if (tx.status === 'completed' || tx.status === 'refunded') {
          soldCatalogIds.add(tx.square_catalog_object_id);
        }
      }
    });

    // Merge catalog items with our transaction data
    const mergedItems = catalogItems
      .filter(item => !soldCatalogIds.has(item.catalog_object_id))
      .map(item => {
        const existingTx = transactionMap.get(item.catalog_object_id);
        return {
          ...item,
          transaction_id: existingTx?.id || null,
          delivery_id: existingTx?.delivery_id || null,
          patient_id: existingTx?.patient_id || null,
          store_id: existingTx?.store_id || null,
          status: existingTx?.status || 'active',
          created_date: existingTx?.created_date || item.updated_at
        };
      });

    // Build quick lookup for existing catalog items by location|normalized_name|price
    const normalizeName = (n) => {
      const s = (n || '').trim();
      const noAmt = s.replace(/\s-\s\$\d+(?:\.\d{2})?$/, '');
      const unified = noAmt.replace(/^(\d{2})-(\d{2})/, '$1/$2'); // keep legacy normalize

      return unified.toLowerCase();
    };
    const catalogLookup = new Set(
      dedupedCatalogItems.map(ci => `${ci.location_id}|${normalizeName(ci.name)}|${ci.price_cents || Math.round((ci.price_dollars || 0) * 100)}`)
    );

    // Fetch recent sold items via existing function (last 7 days) — include all line items even without catalog IDs
    let soldCatalogItems = [];
    try {
      const fpRes = await base44.asServiceRole.functions.invoke('squareFetchPayments', { locationIds, daysBack: 14 });
      const fpData = fpRes?.data || fpRes;
      soldCatalogItems = fpData?.soldCatalogItems || [];
    } catch (e) {
      console.warn('squareFetchPayments invoke failed:', e.message);
    }
    // Build sold lookup by location|name+amount to support orders with multiple items of same name but different prices
    const soldLookup = new Set(
      soldCatalogItems.map(si => `${si.location_id}|${normalizeName(si.item_name)}|${Math.round((Number(si.amount) || 0) * 100)}`)
    );

    // Helper to format item name per spec [MM]/[DD](StoreAbbrev)-Patient Name (no amount)
    const formatItemName = (deliveryDate, storeAbbreviation, patientName) => {
      const d = new Date(`${deliveryDate}T00:00:00`);
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      const abbr = storeAbbreviation || 'XX';
      return `${m}/${day}(${abbr})-${patientName || 'Unknown'}`;
    };


    // Map stores by id for quick lookup
    const storeById = new Map((stores || []).map(s => [s.id, s]));

    // Gather deliveries in the past 7 days that have COD
    const createdItems = [];
    const deletedItems = [];
    const today = new Date();
    for (let i = 0; i < 7; i++) {
      const d = new Date();
      d.setDate(today.getDate() - i);
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      const dateStr = `${y}-${m}-${day}`;

      const dayDeliveries = await base44.asServiceRole.entities.Delivery.filter({ delivery_date: dateStr });
      for (const del of dayDeliveries) {
        const codRequired = Number(del.cod_total_amount_required || 0);
        const paymentsArr = Array.isArray(del.cod_payments) ? del.cod_payments : [];
        const codFromPayments = paymentsArr.reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
        const codAmount = codRequired > 0 ? codRequired : (codFromPayments > 0 ? codFromPayments : 0);
        if (codAmount <= 0) continue;
        const allowCreate = !['completed','failed','cancelled'].includes(del.status);

        const store = storeById.get(del.store_id);
        const storeAbbr = store?.abbreviation || 'XX';

        // Derive Square location ID from store config or fallback to default env location
        let locId = null;
        if (store?.square_location_config_id) {
          try {
            const cfg = await base44.asServiceRole.entities.SquareLocationConfig.get(store.square_location_config_id);
            locId = cfg?.square_location_id || null;
          } catch {}
        }
        if (!locId) {
          const defLoc = Deno.env.get('SQUARE_LOCATION_ID');
          if (defLoc) locId = defLoc;
        }
        if (!locId) continue; // Skip if we cannot determine location

        const itemName = formatItemName(del.delivery_date, storeAbbr, del.patient_name || del.patient_id || 'Unknown');
        const priceCents = Math.round(codAmount * 100);
        const normalizedName = normalizeName(itemName);
        const key = `${locId}|${normalizedName}|${priceCents}`;
        const soldKey = `${locId}|${normalizedName}|${priceCents}`;

        // Detect Debit/Credit from both sources (array + legacy field)
        const hasDCInArray = paymentsArr.some(p => (p?.type === 'Debit' || p?.type === 'Credit'));
        const hasDCInLegacy = (del.cod_payment_type === 'Debit' || del.cod_payment_type === 'Credit');
        const isDebitOrCredit = hasDCInArray || hasDCInLegacy;

        const existsInCatalog = catalogLookup.has(key);
        const existsInSales = soldLookup.has(soldKey);

        if (isDebitOrCredit) {
          // For Debit/Credit deliveries: delete matching catalog item(s) and skip creation
          if (existsInCatalog) {
            const matches = dedupedCatalogItems.filter(ci =>
              ci.location_id === locId &&
              normalizeName(ci.name) === normalizedName &&
              (ci.price_cents || Math.round((ci.price_dollars || 0) * 100)) === priceCents
            );
            for (const ci of matches) {
              try {
                await base44.asServiceRole.functions.invoke('squareDeleteCodItem', {
                  catalogObjectId: ci.catalog_object_id,
                  deliveryId: del.id,
                  reason: 'debit_or_credit'
                });
                deletedItems.push({
                  delivery_id: del.id,
                  item_name: ci.name,
                  catalog_object_id: ci.catalog_object_id,
                  location_id: ci.location_id
                });
                catalogLookup.delete(key);
              } catch (e) {
                console.warn('Failed to delete Square COD item for delivery', del.id, e.message);
              }
            }
          }
          continue; // Do not create catalog items for Debit/Credit
        }

        const hasPendingTx = existingTransactions.some(tx => tx.delivery_id === del.id && tx.status === 'pending');
        if (allowCreate && !existsInCatalog && !existsInSales && !hasPendingTx) {
          // Create missing catalog item via existing function
          try {
            const createRes = await base44.asServiceRole.functions.invoke('squareCreateCodItem', {
              deliveryId: del.id,
              patientName: del.patient_name || del.patient_id || 'Unknown',
              storeAbbreviation: storeAbbr,
              codAmount,
              deliveryDate: del.delivery_date,
              storeId: del.store_id
            });
            const result = createRes?.data || createRes;
            createdItems.push({
              delivery_id: del.id,
              item_name: result?.itemName || itemName,
              amount: codAmount,
              location_id: locId,
              catalog_object_id: result?.catalogObjectId || null
            });
            // Update lookup so we don't attempt duplicates within this run
            catalogLookup.add(key);
          } catch (e) {
            console.warn('Failed to create Square COD item for delivery', del.id, e.message);
          }
        }
      }
    }

    return Response.json({
      success: true,
      itemCount: mergedItems.length,
      items: mergedItems,
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