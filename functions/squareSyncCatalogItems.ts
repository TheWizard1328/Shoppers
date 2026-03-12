import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

const SQUARE_VERSION = '2025-01-23';
const LOOKBACK_DAYS = 14;

function formatItemName(deliveryDate, storeAbbreviation, patientName) {
  const [year, month, day] = String(deliveryDate || '').split('-');
  const mm = month?.padStart(2, '0') || '00';
  const dd = day?.padStart(2, '0') || '00';
  return `${mm}/${dd}(${storeAbbreviation || 'NA'})-${patientName || 'Unknown Patient'}`;
}

function resolveDeliveryPatientName(delivery, patientById) {
  const patient = patientById.get(delivery?.patient_id);
  return normalizeText(patient?.full_name || delivery?.patient_name) || 'Unknown Patient';
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

function hasCollectedCardPayment(delivery) {
  const codPayments = Array.isArray(delivery?.cod_payments) ? delivery.cod_payments : [];
  return codPayments.some((payment) => ['Debit', 'Credit'].includes(payment?.type) && Number(payment?.amount || 0) > 0)
    || ['Debit', 'Credit'].includes(delivery?.cod_payment_type);
}

function buildPlaceholderItemNames(deliveryDate, storeAbbreviation) {
  const [year, month, day] = String(deliveryDate || '').split('-');
  const mm = month?.padStart(2, '0') || '00';
  const dd = day?.padStart(2, '0') || '00';
  const abbr = storeAbbreviation || 'NA';
  return [
    `${mm}/${dd}(${abbr})-COD`,
    `${mm}/${dd}(${abbr})-Unknown Patient`,
    `${mm}-${dd}(${abbr})-COD`,
    `${mm}-${dd}(${abbr})-Unknown Patient`
  ];
}

function toAmountCents(value) {
  return Math.max(0, Math.round(Number(value || 0)));
}

function buildItemSignature(itemName, amountCents) {
  return `${normalizeText(itemName)}::${toAmountCents(amountCents)}`;
}

function buildLocationSignature(itemName, amountCents, locationId) {
  return `${normalizeText(locationId)}::${buildItemSignature(itemName, amountCents)}`;
}

function normalizeMatchName(value) {
  return normalizeText(value)
    .replace(/\s+/g, ' ')
    .replace(/\s-\s\$\d+(?:\.\d{2})?$/, '')
    .replace(/^(\d{2})-(\d{2})/, '$1/$2')
    .toLowerCase();
}

function buildComparableLocationSignature(itemName, amountCents, locationId) {
  return `${normalizeText(locationId)}::${normalizeMatchName(itemName)}::${toAmountCents(amountCents)}`;
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
    const deliveryById = new Map((deliveries || []).map((delivery) => [delivery.id, delivery]));
    const allSquareLocationIds = Array.from(new Set(
      (squareConfigs || [])
        .map((config) => config?.square_location_id)
        .filter(Boolean)
    ));

    const relevantDeliveries = (deliveries || []).filter((delivery) => {
      return isRecentDelivery(delivery?.delivery_date) && Number(delivery?.cod_total_amount_required || 0) > 0;
    });

    const patientEntries = await Promise.all(
      Array.from(new Set(relevantDeliveries.map((delivery) => delivery?.patient_id).filter(Boolean))).map(async (patientId) => {
        const patient = await base44.asServiceRole.entities.Patient.get(patientId).catch(() => null);
        return [patientId, patient];
      })
    );
    const patientById = new Map(patientEntries);

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
    const paidOrderItemsByLocationSignature = new Map();
    const paidOrderItemsByComparableLocationSignature = new Map();
    for (const item of paidOrderItems) {
      const signature = buildItemSignature(item.item_name, item.amount_cents);
      const locationSignature = buildLocationSignature(item.item_name, item.amount_cents, item.location_id);
      const comparableLocationSignature = buildComparableLocationSignature(item.item_name, item.amount_cents, item.location_id);
      if (!paidOrderItemsBySignature.has(signature)) {
        paidOrderItemsBySignature.set(signature, []);
      }
      if (!paidOrderItemsByLocationSignature.has(locationSignature)) {
        paidOrderItemsByLocationSignature.set(locationSignature, []);
      }
      if (!paidOrderItemsByComparableLocationSignature.has(comparableLocationSignature)) {
        paidOrderItemsByComparableLocationSignature.set(comparableLocationSignature, []);
      }
      paidOrderItemsBySignature.get(signature).push(item);
      paidOrderItemsByLocationSignature.get(locationSignature).push(item);
      paidOrderItemsByComparableLocationSignature.get(comparableLocationSignature).push(item);
    }

    const transactionsBySignature = new Map();
    const transactionsByDeliveryId = new Map();
    const completedTransactionCatalogObjectIds = new Set();
    const completedTransactionLocationSignatures = new Set();
    const completedTransactionComparableLocationSignatures = new Set();
    for (const transaction of squareTransactions || []) {
      const amountCents = transaction?.amount_cents ?? Math.round(Number(transaction?.amount || 0) * 100);
      const signature = buildItemSignature(transaction?.item_name, amountCents);
      if (!normalizeText(transaction?.item_name)) continue;
      if (!transactionsBySignature.has(signature)) {
        transactionsBySignature.set(signature, []);
      }
      transactionsBySignature.get(signature).push(transaction);
      if (transaction?.delivery_id) {
        if (!transactionsByDeliveryId.has(transaction.delivery_id)) {
          transactionsByDeliveryId.set(transaction.delivery_id, []);
        }
        transactionsByDeliveryId.get(transaction.delivery_id).push(transaction);
      }

      if (['completed', 'refunded'].includes(transaction?.status)) {
        if (transaction?.square_catalog_object_id) {
          completedTransactionCatalogObjectIds.add(transaction.square_catalog_object_id);
        }
        completedTransactionLocationSignatures.add(buildLocationSignature(transaction?.item_name, amountCents, transaction?.location_id));
        completedTransactionComparableLocationSignatures.add(buildComparableLocationSignature(transaction?.item_name, amountCents, transaction?.location_id));
      }
    }

    const itemsToDelete = [];
    const transactionsToCancel = [];
    const transactionsToComplete = [];
    const deliveriesToCreate = [];
    const directlyMatchedCatalogItemIds = new Set();
    const directlyMatchedLocationSignatures = new Set();
    const directlyMatchedComparableLocationSignatures = new Set();

    for (const item of catalogItems) {
      const itemName = normalizeText(item?.item_data?.name);
      if (!itemName) continue;
      const amountCents = getCatalogItemAmountCents(item);
      const itemLocationIds = Array.from(new Set([
        ...(item?.present_at_location_ids || []),
        ...(item?.item_data?.variations || []).flatMap((variation) => variation?.present_at_location_ids || []),
      ].filter(Boolean)));
      const variationIds = (item?.item_data?.variations || []).map((variation) => variation?.id).filter(Boolean);
      const matchedByCatalogObjectId = paidCatalogObjectIds.has(item.id) || variationIds.some((variationId) => paidCatalogObjectIds.has(variationId));
      const matchedByCompletedTransactionId = completedTransactionCatalogObjectIds.has(item.id) || variationIds.some((variationId) => completedTransactionCatalogObjectIds.has(variationId));
      const matchedByLocationSignature = itemLocationIds.some((locationId) => paidOrderItemsByLocationSignature.has(buildLocationSignature(itemName, amountCents, locationId)));
      const matchedByComparableLocationSignature = itemLocationIds.some((locationId) => paidOrderItemsByComparableLocationSignature.has(buildComparableLocationSignature(itemName, amountCents, locationId)));
      const matchedByCompletedTransactionSignature = itemLocationIds.some((locationId) => completedTransactionLocationSignatures.has(buildLocationSignature(itemName, amountCents, locationId)));
      const matchedByCompletedComparableSignature = itemLocationIds.some((locationId) => completedTransactionComparableLocationSignatures.has(buildComparableLocationSignature(itemName, amountCents, locationId)));

      if (matchedByCatalogObjectId || matchedByCompletedTransactionId || matchedByLocationSignature || matchedByComparableLocationSignature || matchedByCompletedTransactionSignature || matchedByCompletedComparableSignature) {
        directlyMatchedCatalogItemIds.add(item.id);
        itemLocationIds.forEach((locationId) => {
          directlyMatchedLocationSignatures.add(buildLocationSignature(itemName, amountCents, locationId));
          directlyMatchedComparableLocationSignatures.add(buildComparableLocationSignature(itemName, amountCents, locationId));
        });
        itemsToDelete.push(item.id);
        const matchSource = matchedByCatalogObjectId || matchedByCompletedTransactionId
          ? 'catalog_object_id'
          : 'location_name_amount_signature';
        console.log(`🧾 Directly matched paid catalog item ${itemName} via ${matchSource}`);
      }
    }

    for (const transaction of squareTransactions || []) {
      const locationSignature = buildLocationSignature(transaction?.item_name, transaction?.amount_cents, transaction?.location_id);
      const comparableLocationSignature = buildComparableLocationSignature(transaction?.item_name, transaction?.amount_cents, transaction?.location_id);
      if (transaction?.status === 'pending' && (directlyMatchedCatalogItemIds.has(transaction?.square_catalog_object_id) || directlyMatchedLocationSignatures.has(locationSignature) || directlyMatchedComparableLocationSignatures.has(comparableLocationSignature))) {
        transactionsToComplete.push(transaction.id);
      }
    }

    for (const delivery of relevantDeliveries) {
      const store = storeById.get(delivery.store_id);
      const activeConfig = store?.square_location_config_id ? activeConfigById.get(store.square_location_config_id) : null;
      const resolvedPatientName = resolveDeliveryPatientName(delivery, patientById);
      const itemName = formatItemName(delivery.delivery_date, store?.abbreviation, resolvedPatientName);
      const amountCents = Math.round(Number(delivery.cod_total_amount_required || 0) * 100);
      const signature = buildItemSignature(itemName, amountCents);
      const locationSignature = buildLocationSignature(itemName, amountCents, activeConfig?.square_location_id);
      const comparableLocationSignature = buildComparableLocationSignature(itemName, amountCents, activeConfig?.square_location_id);
      let catalogItem = catalogBySignature.get(signature);
      const paidMatches = paidOrderItemsBySignature.get(signature) || [];
      const catalogVariationIds = (catalogItem?.item_data?.variations || [])
        .map((variation) => variation?.id)
        .filter(Boolean);
      const isPaidByCatalogObjectId = catalogItem
        ? paidCatalogObjectIds.has(catalogItem.id) || catalogVariationIds.some((variationId) => paidCatalogObjectIds.has(variationId))
        : false;
      const isPaidByDirectCatalogMatch = (catalogItem && directlyMatchedCatalogItemIds.has(catalogItem.id)) || directlyMatchedLocationSignatures.has(locationSignature) || directlyMatchedComparableLocationSignatures.has(comparableLocationSignature);
      const existingTransactions = transactionsByDeliveryId.get(delivery.id) || [];
      const placeholderNames = new Set(buildPlaceholderItemNames(delivery.delivery_date, store?.abbreviation));
      if (resolvedPatientName !== 'Unknown Patient' && activeConfig?.square_location_id) {
        for (const placeholderItem of catalogItems || []) {
          const placeholderName = normalizeText(placeholderItem?.item_data?.name);
          if (!placeholderNames.has(placeholderName)) continue;
          if (getCatalogItemAmountCents(placeholderItem) !== amountCents) continue;
          const placeholderLocationIds = Array.from(new Set([
            ...(placeholderItem?.present_at_location_ids || []),
            ...(placeholderItem?.item_data?.variations || []).flatMap((variation) => variation?.present_at_location_ids || []),
          ].filter(Boolean)));
          if (placeholderLocationIds.includes(activeConfig.square_location_id)) {
            itemsToDelete.push(placeholderItem.id);
          }
        }
      }
      const existingPending = existingTransactions.find((transaction) => transaction.status === 'pending');
      if (existingPending?.square_catalog_object_id && (existingPending.item_name !== itemName || toAmountCents(existingPending.amount_cents) !== amountCents)) {
        itemsToDelete.push(existingPending.square_catalog_object_id);
      }
      const codPayments = Array.isArray(delivery?.cod_payments) ? delivery.cod_payments : [];
      const hasCollectedPayment = codPayments.some((payment) => ['Cash', 'Debit', 'Credit', 'Check'].includes(payment?.type) && Number(payment?.amount || 0) > 0)
        || ['Cash', 'Debit', 'Credit', 'Check'].includes(delivery?.cod_payment_type);
      const readyToCloseCollectedCard = delivery.status === 'completed' && hasCollectedCardPayment(delivery);
      const shouldDeleteForInvalidState = !activeConfig || !store?.square_location_config_id || !activeConfig?.square_location_id || delivery.status === 'failed' || delivery.status === 'cancelled';

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

      if (paidMatches.length || isPaidByCatalogObjectId || isPaidByDirectCatalogMatch || hasCollectedPayment) {
        if (readyToCloseCollectedCard) {
          if (catalogItem) {
            itemsToDelete.push(catalogItem.id);
            console.log(`🧾 Matched paid Square item for ${itemName} via ${hasCollectedPayment ? 'delivery_payment_record' : isPaidByCatalogObjectId ? 'catalog_object_id' : 'name_amount_signature'}`);
          }
          for (const transaction of existingTransactions) {
            if (transaction.status === 'pending') {
              transactionsToComplete.push(transaction.id);
            }
          }
        }
        continue;
      }

      deliveriesToCreate.push({
        delivery,
        itemName,
        patientName: resolvedPatientName,
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
      const { delivery, itemName, patientName, amountCents, locationId } = entry;
      const signature = buildItemSignature(itemName, amountCents);
      let catalogItem = catalogBySignature.get(signature);

      if (!catalogItem || !catalogItem?.present_at_location_ids?.includes(locationId)) {
        catalogItem = await createCatalogItem({
          itemName,
          amountCents,
          locationId,
          deliveryId: delivery.id,
          patientName,
        });
        if (catalogItem) {
          catalogBySignature.set(signature, catalogItem);
          createdCount += 1;
          console.log(`➕ Created ${itemName} @ ${locationId}`);
        }
      }

      const existingPending = (transactionsByDeliveryId.get(delivery.id) || []).find((transaction) => transaction.status === 'pending');
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

    const allTransactionsAfterSync = await base44.asServiceRole.entities.SquareTransaction.list('-updated_date', 2000);
    const lookbackStartMs = new Date(lookbackStartAt).getTime();
    const staleTransactions = (allTransactionsAfterSync || []).filter((transaction) => {
      const transactionTime = new Date(transaction?.created_date || transaction?.updated_date || 0).getTime();
      return Number.isFinite(transactionTime) && transactionTime < lookbackStartMs;
    });

    for (const transaction of staleTransactions) {
      await base44.asServiceRole.entities.SquareTransaction.delete(transaction.id);
    }

    const activeTransactions = (allTransactionsAfterSync || [])
      .filter((transaction) => !staleTransactions.some((stale) => stale.id === transaction.id))
      .filter((transaction) => transaction?.status === 'pending' && transaction?.square_catalog_object_id);

    const existingSquareCatalogItems = await base44.asServiceRole.entities.SquareCatalogItems.list('-updated_date', 2000).catch(() => []);
    for (const record of existingSquareCatalogItems || []) {
      await base44.asServiceRole.entities.SquareCatalogItems.delete(record.id);
    }

    if (activeTransactions.length > 0) {
      await base44.asServiceRole.entities.SquareCatalogItems.bulkCreate(activeTransactions.map((transaction) => {
        const delivery = deliveryById.get(transaction.delivery_id);
        return {
          square_catalog_object_id: transaction.square_catalog_object_id,
          square_catalog_version: transaction.square_catalog_version || null,
          item_name: transaction.item_name,
          description: '',
          amount: Number(transaction.amount || 0),
          amount_cents: transaction.amount_cents || Math.round(Number(transaction.amount || 0) * 100),
          delivery_id: transaction.delivery_id,
          delivery_date: delivery?.delivery_date || null,
          patient_id: transaction.patient_id || null,
          store_id: transaction.store_id || null,
          location_id: transaction.location_id || null,
          status: 'active',
        };
      }));
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
      pruned_transactions: staleTransactions.length,
      synced_square_catalog_items: activeTransactions.length,
    });
  } catch (error) {
    console.error('❌ squareSyncCatalogItems failed:', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
});