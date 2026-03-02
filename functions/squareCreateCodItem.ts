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

    // Early guard: if a pending transaction with a catalog object already exists, skip creating another
    const existingPending = await base44.asServiceRole.entities.SquareTransaction.filter({
      delivery_id: deliveryId,
      status: 'pending'
    });
    if (existingPending?.length && existingPending[0]?.square_catalog_object_id) {
      const tx = existingPending[0];
      return Response.json({
        success: true,
        catalogObjectId: tx.square_catalog_object_id,
        catalogVersion: tx.square_catalog_version,
        itemName: tx.item_name,
        transactionId: tx.id,
        note: 'Skipped create: existing pending Square item found'
      });
    }

    // Get the store's Square location ID from SquareLocationConfig
    let locationId = null;
    
    if (storeId) {
      try {
        // Look up the store to get its square_location_config_id
        const store = await base44.asServiceRole.entities.Store.get(storeId);
        
        if (!store) {
          console.warn(`⚠️ [Square] Store not found: ${storeId}`);
          return Response.json({ 
            error: `Store not found with ID: ${storeId}`,
            storeId 
          }, { status: 400 });
        }
        
        if (!store.square_location_config_id) {
          console.warn(`⚠️ [Square] Store "${store.name}" (${storeAbbreviation}) has no Square location configured`);
          return Response.json({ 
            error: `Store "${store.name}" is not configured for Square COD payments. Please assign a Square Location Config to this store.`,
            storeName: store.name,
            storeId 
          }, { status: 400 });
        }
        
        // Look up the SquareLocationConfig to get the actual Square location ID
        const config = await base44.asServiceRole.entities.SquareLocationConfig.get(store.square_location_config_id);
        
        if (!config) {
          console.warn(`⚠️ [Square] Square location config not found: ${store.square_location_config_id}`);
          return Response.json({ 
            error: `Square location config not found for store "${store.name}"`,
            storeName: store.name 
          }, { status: 400 });
        }
        
        if (config.status !== 'active') {
          console.warn(`⚠️ [Square] Square location config is inactive: ${config.name}`);
          return Response.json({ 
            error: `Square location "${config.name}" is inactive for store "${store.name}"`,
            storeName: store.name,
            configName: config.name 
          }, { status: 400 });
        }
        
        locationId = config.square_location_id;
        console.log(`📍 [Square] Using location: ${locationId} (${config.name}) for store ${storeAbbreviation}`);
        
      } catch (storeError) {
        console.error(`❌ [Square] Failed to lookup store configuration:`, storeError.message);
        return Response.json({ 
          error: `Failed to lookup store configuration: ${storeError.message}`,
          storeId 
        }, { status: 500 });
      }
    } else {
      // No storeId provided, use default location
      locationId = Deno.env.get('SQUARE_LOCATION_ID');
      console.log(`📍 [Square] Using default location: ${locationId}`);
    }

    if (!locationId) {
      return Response.json({ error: 'No Square location configured' }, { status: 500 });
    }

    // Format: MM/DD(Store Abbreviation)-Patient Name - $Amount (force / separator everywhere)
    const date = new Date((deliveryDate || '') + 'T00:00:00');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const storeAbbr = (storeAbbreviation || 'XX').trim();
    const amountFormatted = Number.isFinite(Number(codAmount)) ? (Number(codAmount)).toFixed(2) : '0.00';
    const itemName = `${month}/${day}(${storeAbbr})-${patientName} - $${amountFormatted}`;

    // Convert dollars to cents for Square
    const amountCents = Math.round(codAmount * 100);

    // Use a single upsert operation for creating/updating the catalog item
    const upsertResponse = await fetch(`${SQUARE_BASE_URL}/catalog/object`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Square-Version': '2024-01-18'
      },
      body: JSON.stringify({
        idempotency_key: `upsert-delivery-${deliveryId}-${amountCents}-${locationId}`,
        object: {
          type: 'ITEM',
          id: `#${deliveryId}`, // Client-generated ID for upserting the item
          present_at_all_locations: false,
          present_at_location_ids: [locationId],
          item_data: {
            name: itemName,
            variations: [{
              type: 'ITEM_VARIATION',
              id: `#${deliveryId}-variation`, // Client-generated ID for the item variation
              present_at_all_locations: false,
              present_at_location_ids: [locationId],
              item_variation_data: {
                name: 'Regular',
                pricing_type: 'FIXED_PRICING',
                price_money: {
                  amount: amountCents,
                  currency: 'CAD'
                },
                location_overrides: [{
                  location_id: locationId,
                  pricing_type: 'FIXED_PRICING',
                  price_money: {
                    amount: amountCents,
                    currency: 'CAD'
                  }
                }]
              }
            }]
          }
        }
      })
    });

    const upsertData = await upsertResponse.json();

    if (upsertData.errors) {
      console.error('Square API Error:', upsertData.errors);
      return Response.json({ error: 'Failed to create/update Square catalog item', details: upsertData.errors }, { status: upsertResponse.status });
    }

    const catalogObjectId = upsertData.catalog_object?.id;
    const catalogVersion = upsertData.catalog_object?.version;

    // Create or update SquareTransaction record
    try {
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
    } catch (txError) {
      // Even if transaction record fails, return success if Square item was created
      console.warn('⚠️ [Square] Failed to create/update transaction record:', txError.message);
      return Response.json({
        success: true,
        catalogObjectId,
        catalogVersion,
        itemName,
        warning: 'Square item created but transaction record failed'
      });
    }

  } catch (error) {
    console.error('Error creating Square COD item:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});