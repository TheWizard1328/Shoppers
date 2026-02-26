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

    return Response.json({
      success: true,
      itemCount: mergedItems.length,
      items: mergedItems,
      locationIds: locationIds
    });

  } catch (error) {
    console.error('Error syncing Square catalog:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});