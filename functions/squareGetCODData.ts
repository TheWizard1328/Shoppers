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

    // Fetch catalog items from Square
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

                let locationId = null;
                if (item.present_at_all_locations) {
                  locationId = locationIds[0];
                } else {
                  locationId = presentAtLocations.find(locId => locationIds.includes(locId)) || locationIds[0];
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
      if (fetchedCount >= MAX_ITEMS) {
        console.warn(`Reached max items limit (${MAX_ITEMS}), stopping fetch`);
        break;
      }
    } while (cursor);

    // Get existing transactions and identify sold items
    const existingTransactions = await base44.asServiceRole.entities.SquareTransaction.list('-created_date', 500);
    const transactionMap = new Map();
    const soldCatalogIds = new Set();
    
    existingTransactions.forEach(tx => {
      if (tx.square_catalog_object_id) {
        transactionMap.set(tx.square_catalog_object_id, tx);
        if (tx.status === 'completed' || tx.status === 'refunded') {
          soldCatalogIds.add(tx.square_catalog_object_id);
        }
      }
    });

    // Merge catalog items with transaction data
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
      catalogItems: mergedItems,
      transactions: existingTransactions,
      locationIds: locationIds,
      itemCount: mergedItems.length
    });

  } catch (error) {
    console.error('Error fetching Square COD data:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});