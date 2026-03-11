import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

const SQUARE_VERSION = '2025-01-23';
const LOOKBACK_DAYS = 14;

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

function getLookbackStartAt() {
  return new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

function normalizeText(value) {
  return String(value || '').trim();
}

function toAmountCents(value) {
  return Math.max(0, Math.round(Number(value || 0)));
}

function buildItemSignature(itemName, amountCents) {
  return `${normalizeText(itemName)}::${toAmountCents(amountCents)}`;
}

function getCatalogItemAmountCents(item) {
  const variations = item?.item_data?.variations || [];
  const variation = variations.find((entry) => entry?.item_variation_data?.price_money?.amount != null) || variations[0];
  return toAmountCents(variation?.item_variation_data?.price_money?.amount);
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

async function listCompletedOrders(locationIds, startAt) {
  if (!locationIds.length) return [];

  const orders = [];
  let cursor = undefined;

  do {
    const json = await squareFetch('/v2/orders/search', 'POST', {
      location_ids: locationIds,
      cursor,
      limit: 500,
      query: {
        filter: {
          state_filter: {
            states: ['COMPLETED'],
          },
          date_time_filter: {
            closed_at: {
              start_at: startAt,
            },
          },
        },
        sort: {
          sort_field: 'CLOSED_AT',
          sort_order: 'DESC',
        },
      },
    });

    orders.push(...(json.orders || []));
    cursor = json.cursor;
  } while (cursor);

  return orders;
}

function flattenPaidOrderItems(orders) {
  const items = [];

  for (const order of orders || []) {
    for (const lineItem of order?.line_items || []) {
      const itemName = normalizeText(lineItem?.name);
      if (!itemName) continue;

      const quantityValue = Number(lineItem?.quantity || 1);
      const quantity = Number.isFinite(quantityValue) && quantityValue > 0 ? Math.round(quantityValue) : 1;
      const explicitUnitAmount = toAmountCents(lineItem?.base_price_money?.amount);
      const grossAmount = toAmountCents(lineItem?.gross_sales_money?.amount || lineItem?.total_money?.amount);
      const amountCents = explicitUnitAmount || (quantity > 0 ? Math.round(grossAmount / quantity) : grossAmount);

      for (let index = 0; index < quantity; index += 1) {
        items.push({
          order_id: order?.id,
          location_id: order?.location_id || null,
          item_name: itemName,
          amount_cents: amountCents,
          catalog_object_id: lineItem?.catalog_object_id || null,
        });
      }
    }
  }

  return items;
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
      base44.asServiceRole.entities.Delivery.list('-updated_date', 2000),
      base44.asServiceRole.entities.Store.list('-updated_date', 200),
      base44.asServiceRole.entities.SquareLocationConfig.list('-updated_date', 200),
      base44.asServiceRole.entities.SquareTransaction.list('-updated_date', 2000),
    ]);

    const activeConfigById = new Map(
      (squareConfigs || [])
        .filter((config) => config?.status === 'active' && config?.square_location_id)
        .map((config) => [config.id, config])
    );

    const storeById = new Map((stores || []).map((store) => [store.id, store]));
    const allSquareLocationIds = Array.from(new Set(
      (squareConfigs || [])
        .map((config) => config?.square_location_id)
        .filter(Boolean)
    ));

    const relevantDeliveries = (deliveries || []).filter((delivery) => {
      return isRecentDelivery(delivery?.delivery_date) && Number(delivery?.cod_total_amount_required || 0) > 0;
    });

    const lookbackStartAt = getLookbackStartAt();

    const [catalogItems, completedOrders] = await Promise.all([
      listActiveCatalogItems(),
      listCompletedOrders(allSquareLocationIds, lookbackStartAt),
    ]);

    console.log(`📋 [Step 1] Found ${catalogItems.length} active catalog items`);
    console.log(`📋 [Step 2] Found ${completedOrders.length} completed Square orders in the last ${LOOKBACK_DAYS} days`);
    console.log(`📋 [Step 3] Found ${relevantDeliveries.length} recent COD deliveries`);

    const catalogBySignature = new Map();
    for (const item of catalogItems) {
      const itemName = normalizeText(item?.item_data?.name);
      if (!itemName) continue;
      const amountCents = getCatalogItemAmountCents(item);
      catalogBySignature.set(buildItemSignature(itemName, amountCents), item);
    }

    const paidOrderItems = flattenPaidOrderItems(completedOrders);
    const paidCatalogObjectIds = new Set(
      paidOrderItems
        .map((item) => item.catalog_object_id)
        .filter(Boolean)
    );
    const paidOrderItemsBySignature = new Map();
    for (const item of paidOrderItems) {
      const signature = buildItemSignature(item.item_name, item.amount_cents);
      if (!paidOrderItemsBySignature.has(signature)) {
        paidOrderItemsBySignature.set(signature, []);
      }
      paidOrderItemsBySignature.get(signature).push(item);
    }

    const transactionsBySignature = new Map();
    for (const transaction of squareTransactions || []) {
      const signature = buildItemSignature(transaction?.item_name, transaction?.amount_cents);
      if (!normalizeText(transaction?.item_name)) continue;
      if (!transactionsBySignature.has(signature)) {
        transactionsBySignature.set(signature, []);
      }
      transactionsBySignature.get(signature).push(transaction);
    }

    const itemsToDelete = [];
    const transactionsToCancel = [];
    const transactionsToComplete = [];
    const deliveriesToCreate = [];

    for (const delivery of relevantDeliveries) {
      const store = storeById.get(delivery.store_id);
      const activeConfig = store?.square_location_config_id ? activeConfigById.get(store.square_location_config_id) : null;
      const itemName = formatItemName(delivery.delivery_date, store?.abbreviation, delivery.patient_name);
      const amountCents = Math.round(Number(delivery.cod_total_amount_required || 0) * 100);
      const signature = buildItemSignature(itemName, amountCents);
      let catalogItem = catalogBySignature.get(signature);
      const paidMatches = paidOrderItemsBySignature.get(signature) || [];
      const isPaidByCatalogObjectId = catalogItem ? paidCatalogObjectIds.has(catalogItem.id) : false;
      const existingTransactions = transactionsBySignature.get(signature) || [];
      const shouldDeleteForInvalidState = !activeConfig || !store?.square_location_config_id || delivery.status === 'failed' || delivery.status === 'cancelled';

      if (shouldDeleteForInvalidState) {
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

      const isCorrectLocation = catalogItem?.present_at_location_ids?.includes(activeConfig.square_location_id);
      if (catalogItem && !isCorrectLocation) {
        itemsToDelete.push(catalogItem.id);
        catalogBySignature.delete(signature);
        catalogItem = null;
      }

      if (paidMatches.length || isPaidByCatalogObjectId) {
        if (catalogItem) {
          itemsToDelete.push(catalogItem.id);
          console.log(`🧾 Matched paid Square item for ${itemName} via ${isPaidByCatalogObjectId ? 'catalog_object_id' : 'name_amount_signature'}`);
        }
        for (const transaction of existingTransactions) {
          if (transaction.status === 'pending') {
            transactionsToComplete.push(transaction.id);
          }
        }
        continue;
      }

      deliveriesToCreate.push({
        delivery,
        itemName,
        amountCents,
        locationId: activeConfig.square_location_id,
      });
    }

    const uniqueItemIdsToDelete = Array.from(new Set(itemsToDelete.filter(Boolean)));
    if (uniqueItemIdsToDelete.length) {
      await deleteCatalogObjects(uniqueItemIdsToDelete);
      console.log(`🗑️ Deleted ${uniqueItemIdsToDelete.length} reconciled catalog items`);
    }

    for (const transactionId of Array.from(new Set(transactionsToCancel.filter(Boolean)))) {
      await base44.asServiceRole.entities.SquareTransaction.update(transactionId, { status: 'cancelled' });
    }

    for (const transactionId of Array.from(new Set(transactionsToComplete.filter(Boolean)))) {
      await base44.asServiceRole.entities.SquareTransaction.update(transactionId, { status: 'completed' });
    }

    let createdCount = 0;
    let updatedPendingCount = 0;

    for (const entry of deliveriesToCreate) {
      const { delivery, itemName, amountCents, locationId } = entry;
      const signature = buildItemSignature(itemName, amountCents);
      let catalogItem = catalogBySignature.get(signature);

      if (!catalogItem || !catalogItem?.present_at_location_ids?.includes(locationId)) {
        catalogItem = await createCatalogItem({
          itemName,
          amountCents,
          locationId,
          deliveryId: delivery.id,
          patientName: delivery.patient_name,
        });
        if (catalogItem) {
          catalogBySignature.set(signature, catalogItem);
          createdCount += 1;
          console.log(`➕ Created ${itemName} @ ${locationId}`);
        }
      }

      const existingPending = (transactionsBySignature.get(signature) || []).find((transaction) => transaction.status === 'pending');
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
        if (!transactionsBySignature.has(signature)) {
          transactionsBySignature.set(signature, []);
        }
        transactionsBySignature.get(signature).push(createdTransaction);
      }
    }

    return Response.json({
      success: true,
      scanned_deliveries: relevantDeliveries.length,
      catalog_items_seen: catalogItems.length,
      paid_order_items_seen: paidOrderItems.length,
      deleted_catalog_items: uniqueItemIdsToDelete.length,
      cancelled_transactions: Array.from(new Set(transactionsToCancel.filter(Boolean))).length,
      completed_transactions: Array.from(new Set(transactionsToComplete.filter(Boolean))).length,
      created_catalog_items: createdCount,
      updated_pending_transactions: updatedPendingCount,
    });
  } catch (error) {
    console.error('❌ squareSyncCatalogItems failed:', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
});