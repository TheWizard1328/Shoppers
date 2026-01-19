import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

const SQUARE_BASE_URL = 'https://connect.squareup.com/v2';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { deliveryId, patientName, storeAbbreviation, codAmount, deliveryDate, storeId } = await req.json();

    if (!deliveryId || !patientName || !codAmount) {
      return Response.json({ error: 'Missing required fields: deliveryId, patientName, codAmount' }, { status: 400 });
    }

    const accessToken = Deno.env.get('SQUARE_ACCESS_TOKEN');

    if (!accessToken) {
      return Response.json({ error: 'Square access token not configured' }, { status: 500 });
    }

    // Get the store's Square location ID from SquareLocationConfig
    let locationId = null;
    
    if (storeId) {
      // Look up the store to get its square_location_config_id
      const stores = await base44.asServiceRole.entities.Store.filter({ id: storeId });
      const store = stores?.[0];
      
      if (store?.square_location_config_id) {
        // Look up the SquareLocationConfig to get the actual Square location ID
        const configs = await base44.asServiceRole.entities.SquareLocationConfig.filter({ 
          id: store.square_location_config_id 
        });
        const config = configs?.[0];
        
        if (config?.square_location_id && config?.status === 'active') {
          locationId = config.square_location_id;
          console.log(`📍 [Square] Using store-specific location: ${locationId} for store ${storeAbbreviation}`);
        }
      }
    }

    // Fallback to default location if no store-specific config found
    if (!locationId) {
      locationId = Deno.env.get('SQUARE_LOCATION_ID');
      console.log(`📍 [Square] Using default location: ${locationId}`);
    }

    if (!locationId) {
      return Response.json({ error: 'No Square location configured for this store' }, { status: 500 });
    }

    // Format: [MM]/[DD](Store Abbreviation)-Patient Name
    const date = new Date(deliveryDate + 'T00:00:00');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const storeAbbr = storeAbbreviation || 'XX';
    const itemName = `${month}/${day}(${storeAbbr})-${patientName}`;

    // Convert dollars to cents for Square
    const amountCents = Math.round(codAmount * 100);

    // First, search for existing catalog item with this name
    const searchResponse = await fetch(`${SQUARE_BASE_URL}/catalog/search`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Square-Version': '2024-01-18'
      },
      body: JSON.stringify({
        object_types: ['ITEM'],
        query: {
          text_query: {
            keywords: [itemName]
          }
        }
      })
    });

    const searchData = await searchResponse.json();
    let catalogObjectId = null;
    let catalogVersion = null;

    if (searchData.objects && searchData.objects.length > 0) {
      // Find exact match
      const existingItem = searchData.objects.find(obj => 
        obj.item_data?.name === itemName
      );

      if (existingItem) {
        catalogObjectId = existingItem.id;
        catalogVersion = existingItem.version;

        // Update existing item with new price
        const variationId = existingItem.item_data?.variations?.[0]?.id;
        
        if (variationId) {
          const updateResponse = await fetch(`${SQUARE_BASE_URL}/catalog/object`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
              'Square-Version': '2024-01-18'
            },
            body: JSON.stringify({
              idempotency_key: `update-${deliveryId}-${Date.now()}`,
              object: {
                type: 'ITEM',
                id: catalogObjectId,
                version: catalogVersion,
                item_data: {
                  name: itemName,
                  variations: [{
                    type: 'ITEM_VARIATION',
                    id: variationId,
                    item_variation_data: {
                      name: 'Regular',
                      pricing_type: 'FIXED_PRICING',
                      price_money: {
                        amount: amountCents,
                        currency: 'CAD'
                      }
                    }
                  }]
                }
              }
            })
          });

          const updateData = await updateResponse.json();
          if (updateData.catalog_object) {
            catalogVersion = updateData.catalog_object.version;
          }
        }
      }
    }

    // Create new catalog item if none exists
    if (!catalogObjectId) {
      const createResponse = await fetch(`${SQUARE_BASE_URL}/catalog/object`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Square-Version': '2024-01-18'
        },
        body: JSON.stringify({
          idempotency_key: `create-${deliveryId}-${Date.now()}`,
          object: {
            type: 'ITEM',
            id: `#${deliveryId}`,
            item_data: {
              name: itemName,
              variations: [{
                type: 'ITEM_VARIATION',
                id: `#${deliveryId}-variation`,
                item_variation_data: {
                  name: 'Regular',
                  pricing_type: 'FIXED_PRICING',
                  price_money: {
                    amount: amountCents,
                    currency: 'CAD'
                  }
                }
              }]
            }
          }
        })
      });

      const createData = await createResponse.json();

      if (createData.errors) {
        console.error('Square API Error:', createData.errors);
        return Response.json({ error: 'Failed to create Square catalog item', details: createData.errors }, { status: 500 });
      }

      catalogObjectId = createData.catalog_object?.id;
      catalogVersion = createData.catalog_object?.version;
    }

    // Create or update SquareTransaction record
    const existingTransactions = await base44.asServiceRole.entities.SquareTransaction.filter({
      delivery_id: deliveryId,
      status: 'pending'
    });

    let transaction;
    if (existingTransactions.length > 0) {
      // Update existing
      transaction = await base44.asServiceRole.entities.SquareTransaction.update(existingTransactions[0].id, {
        square_catalog_object_id: catalogObjectId,
        square_catalog_version: catalogVersion,
        item_name: itemName,
        amount: codAmount,
        amount_cents: amountCents
      });
    } else {
      // Create new
      transaction = await base44.asServiceRole.entities.SquareTransaction.create({
        square_catalog_object_id: catalogObjectId,
        square_catalog_version: catalogVersion,
        item_name: itemName,
        amount: codAmount,
        amount_cents: amountCents,
        type: 'collection',
        status: 'pending',
        delivery_id: deliveryId
      });
    }

    return Response.json({
      success: true,
      catalogObjectId,
      catalogVersion,
      itemName,
      transactionId: transaction?.id || existingTransactions[0]?.id
    });

  } catch (error) {
    console.error('Error creating Square COD item:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});