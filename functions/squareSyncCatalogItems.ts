import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

const SQUARE_VERSION = '2025-01-23';
const LOOKBACK_DAYS = 14;
const ACTIVE_DELIVERY_STATUSES = new Set(['pending', 'in_transit', 'en_route']);
const INACTIVE_DELIVERY_STATUSES = new Set(['completed', 'failed', 'cancelled']);

function formatItemName(deliveryDate, storeAbbreviation, patientName) {
  const [year, month, day] = String(deliveryDate || '').split('-');
  const mm = month?.padStart(2, '0') || '00';
  const dd = day?.padStart(2, '0') || '00';
  return `${mm}/${dd}(${storeAbbreviation || 'NA'})-${patientName || 'Unknown Patient'}`;
}

function isRecentDelivery(deliveryDate) {
  if (!deliveryDate) return false;
  const deliveryTime = new Date(`${deliveryDate}T00:00:00Z`).getTime();
  const cutoff = Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  return Number.isFinite(deliveryTime) && deliveryTime >= cutoff;
}

async function squareFetch(path, method, body) {
  const response = await fetch(`https://connect.squareup.com${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${Deno.env.get('SQUARE_ACCESS_TOKEN')}`,
      'Content-Type': 'application/json',
      'Square-Version': SQUARE_VERSION,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(json?.errors?.map((error) => error.detail).join(', ') || `Square API error ${response.status}`);
  }

  return json;
}

async function listActiveCatalogItems() {
  const objects = [];
  let cursor = undefined;

  do {
    const json = await squareFetch('/v2/catalog/search', 'POST', {
      object_types: ['ITEM'],
      include_deleted_objects: false,
      archived_state: 'ARCHIVED_STATE_NOT_ARCHIVED',
      cursor,
    });

    objects.push(...(json.objects || []));
    cursor = json.cursor;
  } while (cursor);

  return objects;
}

async function deleteCatalogObjects(objectIds) {
  if (!objectIds.length) return;
  await squareFetch('/v2/catalog/batch-delete', 'POST', { object_ids: objectIds });
}

async function createCatalogItem({ itemName, amountCents, locationId, deliveryId, patientName }) {
  const itemClientId = `#item-${deliveryId}`;
  const variationClientId = `#variation-${deliveryId}`;

  const json = await squareFetch('/v2/catalog/batch-upsert', 'POST', {
    idempotency_key: crypto.randomUUID(),
    batches: [{
      objects: [
        {
          type: 'ITEM',
          id: itemClientId,
          present_at_all_locations: false,
          present_at_location_ids: [locationId],
          item_data: {
            name: itemName,
            description: `COD for ${patientName || 'patient'} | Delivery ${deliveryId}`,
            is_taxable: true,
            product_type: 'REGULAR',
            variations: [
              {
                type: 'ITEM_VARIATION',
                id: variationClientId,
                present_at_all_locations: false,
                present_at_location_ids: [locationId],
                item_variation_data: {
                  name: 'Default',
                  pricing_type: 'FIXED_PRICING',
                  price_money: {
                    amount: amountCents,
                    currency: 'CAD',
                  },
                  sellable: true,
                  stockable: true,
                },
              },
            ],
          },
        },
      ],
    }],
  });

  const createdItem = (json.objects || []).find((object) => object.type === 'ITEM');
  return createdItem || null;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const isAuthenticated = await base44.auth.isAuthenticated().catch(() => false);

    if (isAuthenticated) {
      const user = await base44.auth.me();
      if (user?.role !== 'admin') {
        return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
      }
    }

    const [deliveries, stores, squareConfigs, squareTransactions] = await Promise.all([
      base44.asServiceRole.entities.Delivery.list('-updated_date', 500),
      base44.asServiceRole.entities.Store.list('-updated_date', 100),
      base44.asServiceRole.entities.SquareLocationConfig.list('-updated_date', 100),
      base44.asServiceRole.entities.SquareTransaction.list('-updated_date', 500),
    ]);

    const activeConfigById = new Map(
      (squareConfigs || [])
        .filter((config) => config?.status === 'active' && config?.square_location_id)
        .map((config) => [config.id, config])
    );

    const storeById = new Map((stores || []).map((store) => [store.id, store]));

    const relevantDeliveries = (deliveries || []).filter((delivery) => {
      return isRecentDelivery(delivery?.delivery_date) && Number(delivery?.cod_total_amount_required || 0) > 0;
    });

    console.log(`📋 [Step 1] Found ${relevantDeliveries.length} recent COD deliveries`);

    const catalogItems = await listActiveCatalogItems();
    const catalogByName = new Map();
    for (const item of catalogItems) {
      const itemName = item?.item_data?.name;
      if (itemName) catalogByName.set(itemName, item);
    }

    const pendingTransactions = (squareTransactions || []).filter((transaction) => transaction?.status === 'pending');
    const transactionsByItemName = new Map();
    const completedTransactionsByItemName = new Map();

    for (const transaction of squareTransactions || []) {
      if (!transaction?.item_name) continue;
      if (transaction.status === 'completed') completedTransactionsByItemName.set(transaction.item_name, transaction);
      if (!transactionsByItemName.has(transaction.item_name)) transactionsByItemName.set(transaction.item_name, []);
      transactionsByItemName.get(transaction.item_name).push(transaction);
    }

    const itemsToDelete = [];
    const transactionsToCancel = [];
    const deliveriesToCreate = [];

    for (const delivery of relevantDeliveries) {
      const store = storeById.get(delivery.store_id);
      const itemName = formatItemName(delivery.delivery_date, store?.abbreviation, delivery.patient_name);
      const amountCents = Math.round(Number(delivery.cod_total_amount_required || 0) * 100);
      const activeConfig = store?.square_location_config_id ? activeConfigById.get(store.square_location_config_id) : null;
      const catalogItem = catalogByName.get(itemName);
      const existingTransactions = transactionsByItemName.get(itemName) || [];
      const hasCompletedTransaction = completedTransactionsByItemName.has(itemName);
      const isInactiveDelivery = INACTIVE_DELIVERY_STATUSES.has(delivery.status);

      if (!activeConfig || !store?.square_location_config_id || isInactiveDelivery) {
        if (catalogItem) {
          itemsToDelete.push(catalogItem.id);
        }
        for (const transaction of existingTransactions) {
          if (transaction.status === 'pending') {
            transactionsToCancel.push(transaction.id);
          }
        }

        if (!activeConfig || !store?.square_location_config_id) {
          console.log(`⏭️ Skipping ${itemName} - store has no active Square config`);
        }
        continue;
      }

      if (hasCompletedTransaction) {
        continue;
      }

      const isCorrectLocation = catalogItem?.present_at_location_ids?.includes(activeConfig.square_location_id);
      if (catalogItem && !isCorrectLocation) {
        itemsToDelete.push(catalogItem.id);
        for (const transaction of existingTransactions) {
          if (transaction.status === 'pending') {
            transactionsToCancel.push(transaction.id);
          }
        }
      }

      deliveriesToCreate.push({
        delivery,
        store,
        itemName,
        amountCents,
        locationId: activeConfig.square_location_id,
      });
    }

    const uniqueItemIdsToDelete = Array.from(new Set(itemsToDelete.filter(Boolean)));
    if (uniqueItemIdsToDelete.length) {
      await deleteCatalogObjects(uniqueItemIdsToDelete);
      console.log(`🗑️ Deleted ${uniqueItemIdsToDelete.length} invalid catalog items`);
    }

    for (const transactionId of Array.from(new Set(transactionsToCancel.filter(Boolean)))) {
      await base44.asServiceRole.entities.SquareTransaction.update(transactionId, { status: 'cancelled' });
    }

    let createdCount = 0;
    let updatedPendingCount = 0;

    for (const entry of deliveriesToCreate) {
      const { delivery, store, itemName, amountCents, locationId } = entry;
      const existingCatalogItem = catalogByName.get(itemName);
      let catalogItem = existingCatalogItem;

      if (!catalogItem || !catalogItem?.present_at_location_ids?.includes(locationId)) {
        catalogItem = await createCatalogItem({
          itemName,
          amountCents,
          locationId,
          deliveryId: delivery.id,
          patientName: delivery.patient_name,
        });
        if (catalogItem) {
          catalogByName.set(itemName, catalogItem);
          createdCount += 1;
          console.log(`➕ Created ${itemName} @ ${locationId}`);
        }
      }

      const existingPending = (transactionsByItemName.get(itemName) || []).find((transaction) => transaction.status === 'pending');
      const transactionPayload = {
        item_name: itemName,
        amount: Number(delivery.cod_total_amount_required || 0),
        amount_cents: amountCents,
        type: 'collection',
        status: 'pending',
        delivery_id: delivery.id,
        patient_id: delivery.patient_id || null,
        store_id: delivery.store_id,
        location_id: locationId,
        driver_id: delivery.driver_id || null,
        dispatcher_id: delivery.dispatcher_id || null,
        square_catalog_object_id: catalogItem?.id || null,
        square_catalog_version: catalogItem?.version || null,
      };

      if (existingPending) {
        await base44.asServiceRole.entities.SquareTransaction.update(existingPending.id, transactionPayload);
        updatedPendingCount += 1;
      } else {
        const createdTransaction = await base44.asServiceRole.entities.SquareTransaction.create(transactionPayload);
        if (!transactionsByItemName.has(itemName)) transactionsByItemName.set(itemName, []);
        transactionsByItemName.get(itemName).push(createdTransaction);
      }
    }

    return Response.json({
      success: true,
      scanned_deliveries: relevantDeliveries.length,
      deleted_catalog_items: uniqueItemIdsToDelete.length,
      cancelled_transactions: Array.from(new Set(transactionsToCancel.filter(Boolean))).length,
      created_catalog_items: createdCount,
      updated_pending_transactions: updatedPendingCount,
    });
  } catch (error) {
    console.error('❌ squareSyncCatalogItems failed:', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
});