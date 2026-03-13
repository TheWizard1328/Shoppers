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

    if (!deliveryId || codAmount == null || Number(codAmount) <= 0) {
      return Response.json({ error: 'Missing required fields: deliveryId, codAmount' }, { status: 400 });
    }

    const accessToken = Deno.env.get('SQUARE_ACCESS_TOKEN');

    if (!accessToken) {
      return Response.json({ error: 'Square access token not configured' }, { status: 500 });
    }

    const deliveryRecord = await base44.asServiceRole.entities.Delivery.get(deliveryId).catch(() => null);
    let patientRecord = null;
    if (deliveryRecord?.patient_id) {
      patientRecord = await base44.asServiceRole.entities.Patient.get(deliveryRecord.patient_id).catch(() => null);
      if (!patientRecord) {
        const patientMatches = await base44.asServiceRole.entities.Patient.filter({
          patient_id: deliveryRecord.patient_id
        }, '-updated_date', 1).catch(() => []);
        patientRecord = Array.isArray(patientMatches) ? patientMatches[0] : null;
      }
    }
    const effectiveStoreId = storeId || deliveryRecord?.store_id;

    // Get the store's Square location ID from SquareLocationConfig
    if (!effectiveStoreId) {
      return Response.json({ error: 'Store ID is required for Square COD item creation' }, { status: 400 });
    }

    let locationId = null;
    let store = null;

    try {
      store = await base44.asServiceRole.entities.Store.get(effectiveStoreId);

      if (!store) {
        console.warn(`⚠️ [Square] Store not found: ${effectiveStoreId}`);
        return Response.json({
          error: `Store not found with ID: ${effectiveStoreId}`,
          storeId: effectiveStoreId
        }, { status: 400 });
      }

      if (!store.square_location_config_id) {
        console.warn(`⚠️ [Square] Store "${store.name}" (${store.abbreviation || storeAbbreviation || 'XX'}) has no Square location configured`);
        return Response.json({
          error: `Store "${store.name}" is not configured for Square COD payments. Please assign a Square Location Config to this store.`,
          storeName: store.name,
          storeId: effectiveStoreId
        }, { status: 400 });
      }

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
      console.log(`📍 [Square] Using location: ${locationId} (${config.name}) for store ${store.abbreviation || storeAbbreviation || 'XX'}`);
    } catch (storeError) {
      console.error(`❌ [Square] Failed to lookup store configuration:`, storeError.message);
      return Response.json({
        error: `Failed to lookup store configuration: ${storeError.message}`,
        storeId: effectiveStoreId
      }, { status: 500 });
    }

    if (!locationId) {
      return Response.json({ error: 'No Square location configured' }, { status: 500 });
    }

    const resolvedDeliveryDate = deliveryDate || deliveryRecord?.delivery_date;
    const resolvedPatientName = String(patientRecord?.full_name || patientName || deliveryRecord?.patient_name || '').trim();
    if (!resolvedPatientName || resolvedPatientName === 'COD' || resolvedPatientName === 'Unknown Patient') {
      return Response.json({ success: true, skipped: true, reason: 'missing_patient_name' });
    }
    const resolvedPatientId = patientRecord?.id || deliveryRecord?.patient_id || null;
    const resolvedStoreAbbr = (store?.abbreviation || storeAbbreviation || 'XX').trim();
    const amountCents = Math.round(Number(codAmount) * 100);

    const date = new Date(`${resolvedDeliveryDate || ''}T00:00:00`);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const itemName = `${month}/${day}(${resolvedStoreAbbr})-${resolvedPatientName}`;

    const existingPending = await base44.asServiceRole.entities.SquareTransaction.filter({
      delivery_id: deliveryId,
      status: 'pending'
    });
    if (existingPending?.length && existingPending[0]?.square_catalog_object_id && existingPending[0]?.item_name === itemName && existingPending[0]?.amount_cents === amountCents) {
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

    if (existingPending?.length && existingPending[0]?.square_catalog_object_id && (existingPending[0]?.item_name !== itemName || existingPending[0]?.amount_cents !== amountCents)) {
      try {
        await fetch(`${SQUARE_BASE_URL}/catalog/object/${existingPending[0].square_catalog_object_id}`, {
          method: 'DELETE',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Square-Version': '2024-01-18'
          }
        });
      } catch (deleteError) {
        console.warn('Failed to delete stale Square placeholder item:', deleteError.message);
      }
    }

    // Convert dollars to cents for Square

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
          amount_cents: amountCents,
          patient_id: resolvedPatientId,
          store_id: effectiveStoreId,
          location_id: locationId
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
          delivery_id: deliveryId,
          patient_id: resolvedPatientId,
          store_id: effectiveStoreId,
          location_id: locationId
        });
      }

      const existingCatalogItems = await base44.asServiceRole.entities.SquareCatalogItems.filter({ delivery_id: deliveryId }).catch(() => []);
      const catalogPayload = {
        square_catalog_object_id: catalogObjectId,
        square_catalog_version: catalogVersion,
        item_name: itemName,
        description: '',
        amount: Number(codAmount || 0),
        amount_cents: amountCents,
        delivery_id: deliveryId,
        delivery_date: deliveryDate || null,
        patient_id: resolvedPatientId,
        store_id: effectiveStoreId || null,
        location_id: locationId,
        status: 'active'
      };

      if (existingCatalogItems.length > 0) {
        await base44.asServiceRole.entities.SquareCatalogItems.update(existingCatalogItems[0].id, catalogPayload);
      } else {
        await base44.asServiceRole.entities.SquareCatalogItems.create(catalogPayload);
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