import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

const SQUARE_BASE_URL = 'https://connect.squareup.com';
const SQUARE_VERSION = '2025-01-23';
const LOOKBACK_DAYS = 14;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function normalizeText(value) {
  return String(value || '').trim();
}

function isValidEntityId(value) {
  return /^[a-f0-9]{24}$/i.test(String(value || ''));
}

function toAmountCents(value) {
  return Math.max(0, Math.round(Number(value || 0)));
}

function formatItemName(deliveryDate, storeAbbreviation, patientName) {
  const [_, month, day] = String(deliveryDate || '').split('-');
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

function hasCollectedCardPayment(delivery) {
  const codPayments = Array.isArray(delivery?.cod_payments) ? delivery.cod_payments : [];
  return codPayments.some((payment) => ['Debit', 'Credit'].includes(payment?.type) && Number(payment?.amount || 0) > 0)
    || ['Debit', 'Credit'].includes(delivery?.cod_payment_type);
}

function isOfflineCollectedPaymentMethod(paymentMethod) {
  return ['cash', 'check'].includes(String(paymentMethod || '').toLowerCase());
}

function buildPlaceholderItemNames(deliveryDate, storeAbbreviation) {
  const [_, month, day] = String(deliveryDate || '').split('-');
  const mm = month?.padStart(2, '0') || '00';
  const dd = day?.padStart(2, '0') || '00';
  const abbr = storeAbbreviation || 'NA';
  return [
    `${mm}/${dd}(${abbr})-COD`,
    `${mm}/${dd}(${abbr})-Unknown Patient`,
    `${mm}-${dd}(${abbr})-COD`,
    `${mm}-${dd}(${abbr})-Unknown Patient`,
  ];
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

function ensureSquareToken() {
  const accessToken = Deno.env.get('SQUARE_ACCESS_TOKEN');
  if (!accessToken) throw new HttpError(500, 'Square credentials not configured');
  return accessToken;
}

async function requireUser(base44) {
  const user = await base44.auth.me().catch(() => null);
  if (!user) throw new HttpError(401, 'Unauthorized');
  return user;
}

async function requireAdminIfAuthenticated(base44) {
  const isAuthenticated = await base44.auth.isAuthenticated().catch(() => false);
  if (!isAuthenticated) return null;
  const user = await base44.auth.me().catch(() => null);
  if (user?.role !== 'admin') throw new HttpError(403, 'Forbidden: Admin access required');
  return user;
}

async function squareFetch(path, method, accessToken, body) {
  const response = await fetch(`${SQUARE_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
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

async function safeDeleteSquareCatalogObject(catalogObjectId, accessToken) {
  if (!catalogObjectId) return { attempted: false, ok: false };

  try {
    const response = await fetch(`${SQUARE_BASE_URL}/v2/catalog/object/${catalogObjectId}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Square-Version': SQUARE_VERSION,
      },
    });

    const responseText = await response.text();
    let responseBody = null;
    try {
      responseBody = responseText ? JSON.parse(responseText) : null;
    } catch {
      responseBody = responseText || null;
    }

    if (!response.ok) {
      return { attempted: true, ok: false, status: response.status, body: responseBody };
    }

    return { attempted: true, ok: true, body: responseBody };
  } catch (error) {
    return { attempted: true, ok: false, error: error?.message || String(error) };
  }
}

async function deleteCatalogObjects(objectIds, accessToken) {
  if (!objectIds.length) return;
  await squareFetch('/v2/catalog/batch-delete', 'POST', accessToken, { object_ids: objectIds });
}

async function createCatalogItem({ itemName, amountCents, locationId, deliveryId, patientName, accessToken }) {
  const itemClientId = `#item-${deliveryId}`;
  const variationClientId = `#variation-${deliveryId}`;

  const json = await squareFetch('/v2/catalog/batch-upsert', 'POST', accessToken, {
    idempotency_key: crypto.randomUUID(),
    batches: [{
      objects: [{
        type: 'ITEM',
        id: itemClientId,
        present_at_all_locations: false,
        present_at_location_ids: [locationId],
        item_data: {
          name: itemName,
          description: `COD for ${patientName || 'patient'} | Delivery ${deliveryId}`,
          is_taxable: true,
          product_type: 'REGULAR',
          variations: [{
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
          }],
        },
      }],
    }],
  });

  return (json.objects || []).find((object) => object.type === 'ITEM') || null;
}

async function listActiveCatalogItems(accessToken) {
  const objects = [];
  let cursor = undefined;

  do {
    const json = await squareFetch('/v2/catalog/search', 'POST', accessToken, {
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

async function listCompletedOrders(locationIds, startAt, accessToken) {
  if (!locationIds.length) return [];

  const orders = [];
  let cursor = undefined;

  do {
    const json = await squareFetch('/v2/orders/search', 'POST', accessToken, {
      location_ids: locationIds,
      cursor,
      limit: 500,
      query: {
        filter: {
          state_filter: { states: ['COMPLETED'] },
          date_time_filter: { closed_at: { start_at: startAt } },
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

async function resolveDeliveryPatient(base44, delivery, patientById, patientByPid) {
  const rawPatientRef = normalizeText(delivery?.patient_id);
  if (!rawPatientRef) return null;

  const mappedPatient = patientById.get(rawPatientRef) || patientByPid.get(rawPatientRef);
  if (mappedPatient) return mappedPatient;

  if (isValidEntityId(rawPatientRef)) {
    const patientByEntityId = await base44.asServiceRole.entities.Patient.get(rawPatientRef).catch(() => null);
    if (patientByEntityId) {
      patientById.set(patientByEntityId.id, patientByEntityId);
      const normalizedPid = normalizeText(patientByEntityId.patient_id);
      if (normalizedPid) patientByPid.set(normalizedPid, patientByEntityId);
      return patientByEntityId;
    }
  }

  const patientMatches = await base44.asServiceRole.entities.Patient.filter({
    patient_id: rawPatientRef,
  }, '-updated_date', 1).catch(() => []);
  const patientByPidValue = Array.isArray(patientMatches) ? patientMatches[0] : null;
  if (patientByPidValue) {
    patientById.set(patientByPidValue.id, patientByPidValue);
    const normalizedPid = normalizeText(patientByPidValue.patient_id);
    if (normalizedPid) patientByPid.set(normalizedPid, patientByPidValue);
    return patientByPidValue;
  }

  return null;
}

async function resolveDeliveryPatientName(base44, delivery, patientById, patientByPid) {
  const patient = await resolveDeliveryPatient(base44, delivery, patientById, patientByPid);
  return normalizeText(patient?.full_name || delivery?.patient_name) || 'Unknown Patient';
}

async function getStoreSquareContext(base44, effectiveStoreId) {
  if (!effectiveStoreId) {
    throw new HttpError(400, 'Store ID is required for Square COD item creation');
  }

  const store = await base44.asServiceRole.entities.Store.get(effectiveStoreId).catch(() => null);
  if (!store) {
    throw new HttpError(400, `Store not found with ID: ${effectiveStoreId}`);
  }
  if (!store.square_location_config_id) {
    throw new HttpError(400, `Store "${store.name}" is not configured for Square COD payments.`);
  }

  const config = await base44.asServiceRole.entities.SquareLocationConfig.get(store.square_location_config_id).catch(() => null);
  if (!config) {
    throw new HttpError(400, `Square location config not found for store "${store.name}"`);
  }
  if (config.status !== 'active') {
    throw new HttpError(400, `Square location "${config.name}" is inactive for store "${store.name}"`);
  }

  return { store, config, locationId: config.square_location_id };
}

async function buildPatientMaps(base44, deliveries) {
  const deliveryPatientRefs = Array.from(new Set((deliveries || []).map((delivery) => normalizeText(delivery?.patient_id)).filter(Boolean)));
  const patientEntityIds = deliveryPatientRefs.filter((id) => isValidEntityId(id));
  const patientPidStrings = deliveryPatientRefs.filter((id) => !isValidEntityId(id));

  const [patientsByEntityId, patientsByPid] = await Promise.all([
    patientEntityIds.length ? base44.asServiceRole.entities.Patient.filter({ id: { $in: patientEntityIds } }) : [],
    patientPidStrings.length ? base44.asServiceRole.entities.Patient.filter({ patient_id: { $in: patientPidStrings } }) : [],
  ]);

  const patients = [
    ...(patientsByEntityId || []),
    ...((patientsByPid || []).filter((patient) => !(patientsByEntityId || []).some((existing) => existing.id === patient.id))),
  ];

  return {
    patientById: new Map((patients || []).map((patient) => [patient.id, patient])),
    patientByPid: new Map((patients || []).map((patient) => [normalizeText(patient?.patient_id), patient]).filter(([patientId]) => patientId)),
  };
}

async function handleCreateCodItem(base44, payload) {
  const accessToken = ensureSquareToken();
  const { deliveryId, patientName, storeAbbreviation, codAmount, deliveryDate, storeId } = payload || {};

  if (!deliveryId || codAmount == null || Number(codAmount) <= 0) {
    throw new HttpError(400, 'Missing required fields: deliveryId, codAmount');
  }

  const deliveryRecord = await base44.asServiceRole.entities.Delivery.get(deliveryId).catch(() => null);
  const { patientById, patientByPid } = await buildPatientMaps(base44, deliveryRecord ? [deliveryRecord] : []);
  const patientRecord = deliveryRecord ? await resolveDeliveryPatient(base44, deliveryRecord, patientById, patientByPid) : null;
  const effectiveStoreId = storeId || deliveryRecord?.store_id;
  const { store, locationId } = await getStoreSquareContext(base44, effectiveStoreId);

  const resolvedDeliveryDate = deliveryDate || deliveryRecord?.delivery_date;
  const lookedUpPatientName = deliveryRecord
    ? await resolveDeliveryPatientName(base44, deliveryRecord, patientById, patientByPid)
    : '';
  const usableLookedUpPatientName = lookedUpPatientName === 'Unknown Patient' ? '' : lookedUpPatientName;
  const resolvedPatientName = normalizeText(usableLookedUpPatientName || patientName || deliveryRecord?.patient_name);
  if (!resolvedPatientName || resolvedPatientName === 'COD' || resolvedPatientName === 'Unknown Patient') {
    return { success: true, skipped: true, reason: 'missing_patient_name' };
  }

  const resolvedPatientId = patientRecord?.id || (isValidEntityId(deliveryRecord?.patient_id) ? deliveryRecord.patient_id : null);
  const resolvedStoreAbbr = normalizeText(store?.abbreviation || storeAbbreviation || 'XX');
  const amountCents = Math.round(Number(codAmount) * 100);
  const itemName = formatItemName(resolvedDeliveryDate, resolvedStoreAbbr, resolvedPatientName);

  const existingPending = await base44.asServiceRole.entities.SquareTransaction.filter({
    delivery_id: deliveryId,
    status: 'pending',
  }).catch(() => []);

  if (existingPending?.length && existingPending[0]?.square_catalog_object_id && existingPending[0]?.item_name === itemName && existingPending[0]?.amount_cents === amountCents) {
    const tx = existingPending[0];
    return {
      success: true,
      catalogObjectId: tx.square_catalog_object_id,
      catalogVersion: tx.square_catalog_version,
      itemName: tx.item_name,
      transactionId: tx.id,
      note: 'Skipped create: existing pending Square item found',
    };
  }

  if (existingPending?.length && existingPending[0]?.square_catalog_object_id && (existingPending[0]?.item_name !== itemName || existingPending[0]?.amount_cents !== amountCents)) {
    await safeDeleteSquareCatalogObject(existingPending[0].square_catalog_object_id, accessToken);
  }

  const catalogItem = await createCatalogItem({
    itemName,
    amountCents,
    locationId,
    deliveryId,
    patientName: resolvedPatientName,
    accessToken,
  });

  const catalogObjectId = catalogItem?.id || null;
  const catalogVersion = catalogItem?.version || null;

  const existingTransactions = await base44.asServiceRole.entities.SquareTransaction.filter({
    delivery_id: deliveryId,
    status: 'pending',
  }).catch(() => []);

  let transaction;
  const transactionPayload = {
    square_catalog_object_id: catalogObjectId,
    square_catalog_version: catalogVersion,
    item_name: itemName,
    amount: Number(codAmount),
    amount_cents: amountCents,
    patient_id: resolvedPatientId,
    store_id: effectiveStoreId,
    location_id: locationId,
  };

  if (existingTransactions.length > 0) {
    transaction = await base44.asServiceRole.entities.SquareTransaction.update(existingTransactions[0].id, transactionPayload);
  } else {
    transaction = await base44.asServiceRole.entities.SquareTransaction.create({
      ...transactionPayload,
      type: 'collection',
      status: 'pending',
      delivery_id: deliveryId,
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
    delivery_date: resolvedDeliveryDate || null,
    patient_id: resolvedPatientId,
    store_id: effectiveStoreId || null,
    location_id: locationId,
    status: 'active',
  };

  if (existingCatalogItems.length > 0) {
    await base44.asServiceRole.entities.SquareCatalogItems.update(existingCatalogItems[0].id, catalogPayload);
  } else {
    await base44.asServiceRole.entities.SquareCatalogItems.create(catalogPayload);
  }

  return {
    success: true,
    catalogObjectId,
    catalogVersion,
    itemName,
    transactionId: transaction?.id || existingTransactions[0]?.id,
  };
}

async function handleDeleteCodItem(base44, payload) {
  const accessToken = ensureSquareToken();
  const { deliveryId, transactionId, catalogObjectId, reason } = payload || {};

  if (!deliveryId && !transactionId && !catalogObjectId) {
    throw new HttpError(400, 'Missing required field: deliveryId, transactionId, or catalogObjectId');
  }

  let primaryTransaction = null;
  const relatedTransactions = [];

  if (transactionId) {
    const transaction = await base44.asServiceRole.entities.SquareTransaction.get(transactionId).catch(() => null);
    if (transaction) {
      primaryTransaction = transaction;
      relatedTransactions.push(transaction);
    }
  }

  if (deliveryId) {
    const deliveryTransactions = await base44.asServiceRole.entities.SquareTransaction.filter({ delivery_id: deliveryId }, '-updated_date', 50).catch(() => []);
    for (const transaction of deliveryTransactions || []) {
      if (!relatedTransactions.some((item) => item?.id === transaction?.id)) {
        relatedTransactions.push(transaction);
      }
    }
    if (!primaryTransaction && relatedTransactions.length > 0) {
      primaryTransaction = relatedTransactions[0];
    }
  }

  const catalogIdToDelete = catalogObjectId || primaryTransaction?.square_catalog_object_id || relatedTransactions[0]?.square_catalog_object_id || null;
  const squareDeleteResult = await safeDeleteSquareCatalogObject(catalogIdToDelete, accessToken);

  const newStatus = reason === 'failed' ? 'failed' : 'cancelled';
  await Promise.all(
    relatedTransactions.map((transaction) =>
      base44.asServiceRole.entities.SquareTransaction.update(transaction.id, {
        status: newStatus,
        raw_square_data: {
          ...(transaction.raw_square_data || {}),
          deleted_at: new Date().toISOString(),
          deleted_reason: reason || 'manual_delete',
        },
      }).catch(() => null)
    )
  );

  const catalogMatches = [];
  if (deliveryId) {
    const byDelivery = await base44.asServiceRole.entities.SquareCatalogItems.filter({ delivery_id: deliveryId }, '-updated_date', 50).catch(() => []);
    catalogMatches.push(...(byDelivery || []));
  }
  if (catalogIdToDelete) {
    const byCatalog = await base44.asServiceRole.entities.SquareCatalogItems.filter({ square_catalog_object_id: catalogIdToDelete }, '-updated_date', 50).catch(() => []);
    catalogMatches.push(...(byCatalog || []));
  }

  const uniqueCatalogMatches = Array.from(new Map(catalogMatches.filter(Boolean).map((item) => [item.id, item])).values());
  await Promise.all(
    uniqueCatalogMatches.map((item) =>
      base44.asServiceRole.entities.SquareCatalogItems.delete(item.id).catch(() => null)
    )
  );

  return {
    success: true,
    deletedCatalogId: catalogIdToDelete,
    transactionCount: relatedTransactions.length,
    deletedCatalogRecordCount: uniqueCatalogMatches.length,
    squareDeleteResult,
    transactionStatus: relatedTransactions.length > 0 ? newStatus : 'deleted_from_square',
  };
}

async function handleFetchPayments(payload) {
  const accessToken = ensureSquareToken();
  const { locationIds, daysBack = 14, maxPerLocation = 10, throttleMs = 150 } = payload || {};

  if (!locationIds || locationIds.length === 0) {
    throw new HttpError(400, 'No location IDs provided');
  }

  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - daysBack);

  const allPayments = [];
  const soldCatalogItems = [];

  for (const locationId of locationIds) {
    const queryParams = new URLSearchParams({
      location_id: locationId,
      begin_time: startDate.toISOString(),
      end_time: endDate.toISOString(),
      sort_order: 'DESC',
      limit: '100',
    });

    const paymentsResponse = await fetch(`${SQUARE_BASE_URL}/v2/payments?${queryParams.toString()}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Square-Version': SQUARE_VERSION,
      },
    });

    if (!paymentsResponse.ok) continue;
    const paymentsData = await paymentsResponse.json().catch(() => ({}));

    if (paymentsData.payments) {
      const paymentsToProcess = paymentsData.payments.slice(0, Math.max(1, Math.min(maxPerLocation, 100)));
      for (const payment of paymentsToProcess) {
        if (payment.status !== 'COMPLETED') continue;
        allPayments.push(payment);

        if (payment.order_id) {
          await new Promise((resolve) => setTimeout(resolve, throttleMs));
          try {
            const orderResponse = await fetch(`${SQUARE_BASE_URL}/v2/orders/${payment.order_id}`, {
              method: 'GET',
              headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'Square-Version': SQUARE_VERSION,
              },
            });

            if (orderResponse.ok) {
              const orderData = await orderResponse.json().catch(() => ({}));
              const order = orderData.order;
              if (order?.line_items?.length) {
                for (const lineItem of order.line_items) {
                  soldCatalogItems.push({
                    catalog_object_id: lineItem.catalog_object_id || null,
                    location_id: payment.location_id,
                    payment_id: payment.id,
                    square_transaction_id: payment.id,
                    square_payment_id: payment.id,
                    order_id: payment.order_id,
                    item_name: lineItem.name,
                    amount: lineItem.base_price_money?.amount ? lineItem.base_price_money.amount / 100 : 0,
                    payment_date: payment.created_at,
                    payment_method: payment.payment_source_type || 'UNKNOWN',
                  });
                }
              }
            }
          } catch (_) {}
        }
      }
    }
  }

  const soldItemCounts = new Map();
  soldCatalogItems.forEach((item) => {
    if (!item.catalog_object_id) return;
    soldItemCounts.set(item.catalog_object_id, (soldItemCounts.get(item.catalog_object_id) || 0) + 1);
  });

  const soldItems = Array.from(soldItemCounts.entries()).map(([catalogId, count]) => ({
    catalog_object_id: catalogId,
    times_sold: count,
  }));

  let catalogItems = [];
  let catalogItemCount = 0;
  try {
    const catalogResponse = await fetch(`${SQUARE_BASE_URL}/v2/catalog/list?types=ITEM,ITEM_VARIATION`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Square-Version': SQUARE_VERSION,
      },
    });

    if (catalogResponse.ok) {
      const catalogData = await catalogResponse.json().catch(() => ({}));
      if (catalogData.objects) {
        for (const obj of catalogData.objects) {
          if (obj.type === 'ITEM' && obj.item_data?.variations) {
            for (const variation of obj.item_data.variations) {
              if (!variation.item_variation_data) continue;
              const priceMoney = variation.item_variation_data.price_money;
              const priceDollars = priceMoney ? priceMoney.amount / 100 : 0;
              for (const locationId of locationIds) {
                catalogItems.push({
                  catalog_object_id: variation.id,
                  name: obj.item_data.name || variation.item_variation_data.name || 'Unnamed',
                  description: variation.item_variation_data.name,
                  price_dollars: priceDollars,
                  price_cents: priceMoney ? priceMoney.amount : 0,
                  location_id: locationId,
                  updated_at: obj.updated_at,
                });
                catalogItemCount += 1;
              }
            }
          }
        }
      }
    }
  } catch (_) {}

  return {
    success: true,
    paymentsCount: allPayments.length,
    soldItems,
    soldCatalogItems,
    catalogItems,
    catalogItemCount,
    dateRange: {
      start: startDate.toISOString(),
      end: endDate.toISOString(),
    },
  };
}

async function handleGetCodData(base44) {
  const accessToken = ensureSquareToken();
  const locationConfigs = await base44.asServiceRole.entities.SquareLocationConfig.filter({ status: 'active' });
  const locationIds = locationConfigs.map((lc) => lc.square_location_id).filter(Boolean);

  const defaultLocationId = Deno.env.get('SQUARE_LOCATION_ID');
  if (defaultLocationId && !locationIds.includes(defaultLocationId)) {
    locationIds.push(defaultLocationId);
  }
  if (locationIds.length === 0) {
    throw new HttpError(400, 'No Square locations configured');
  }

  const catalogItems = [];
  let cursor = null;
  let fetchedCount = 0;
  const MAX_ITEMS = 500;

  do {
    const searchBody = { object_types: ['ITEM'], include_related_objects: true, limit: 100 };
    if (cursor) searchBody.cursor = cursor;

    const searchData = await squareFetch('/v2/catalog/search', 'POST', accessToken, searchBody);
    if (searchData.objects) {
      for (const item of searchData.objects) {
        if (item.type === 'ITEM' && item.item_data) {
          for (const variation of item.item_data.variations || []) {
            const presentAtLocations = variation.present_at_location_ids || item.present_at_location_ids || [];
            const isAtOurLocation = locationIds.some((locId) => presentAtLocations.includes(locId) || item.present_at_all_locations === true);
            if (!isAtOurLocation) continue;

            let priceCents = 0;
            if (variation.item_variation_data?.price_money) {
              priceCents = variation.item_variation_data.price_money.amount || 0;
            }

            let locationId = null;
            if (item.present_at_all_locations) {
              locationId = locationIds[0];
            } else {
              locationId = presentAtLocations.find((locId) => locationIds.includes(locId)) || locationIds[0];
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
              version: item.version,
            });
            fetchedCount += 1;
            break;
          }
        }
      }
    }

    cursor = searchData.cursor;
    if (fetchedCount >= MAX_ITEMS) break;
  } while (cursor);

  const existingTransactions = await base44.asServiceRole.entities.SquareTransaction.list('-created_date', 500);
  const transactionMap = new Map();
  const soldCatalogIds = new Set();

  existingTransactions.forEach((tx) => {
    if (tx.square_catalog_object_id) {
      transactionMap.set(tx.square_catalog_object_id, tx);
      if (tx.status === 'completed' || tx.status === 'refunded') {
        soldCatalogIds.add(tx.square_catalog_object_id);
      }
    }
  });

  const mergedItems = catalogItems.map((item) => {
    const existingTx = transactionMap.get(item.catalog_object_id);
    return {
      ...item,
      transaction_id: existingTx?.id || null,
      delivery_id: existingTx?.delivery_id || null,
      patient_id: existingTx?.patient_id || null,
      store_id: existingTx?.store_id || null,
      status: existingTx?.status || 'active',
      created_date: existingTx?.created_date || item.updated_at,
      is_sold: soldCatalogIds.has(item.catalog_object_id),
    };
  });

  return {
    success: true,
    catalogItems: mergedItems,
    transactions: existingTransactions,
    locationIds,
    itemCount: mergedItems.length,
  };
}

async function handleRecordPayment(base44, payload) {
  const { deliveryId, paymentMethod, driverId, patientId, storeId } = payload || {};
  if (!deliveryId || !paymentMethod) {
    throw new HttpError(400, 'Missing required fields: deliveryId, paymentMethod');
  }

  const user = await requireUser(base44);
  const transactions = await base44.asServiceRole.entities.SquareTransaction.filter({
    delivery_id: deliveryId,
    status: 'pending',
  });

  if (transactions.length === 0) {
    throw new HttpError(404, 'No pending Square transaction found for this delivery');
  }

  const transaction = transactions[0];
  await base44.asServiceRole.entities.SquareTransaction.update(transaction.id, {
    status: 'completed',
    payment_method: paymentMethod.toLowerCase(),
    driver_id: driverId || user.id,
    patient_id: patientId,
    store_id: storeId,
    raw_square_data: {
      ...transaction.raw_square_data,
      payment_recorded_at: new Date().toISOString(),
      payment_method: paymentMethod,
    },
  });

  return {
    success: true,
    transactionId: transaction.id,
    itemName: transaction.item_name,
    amount: transaction.amount,
    paymentMethod,
  };
}

async function handleSyncCatalogItems(base44) {
  const accessToken = ensureSquareToken();
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
  const allSquareLocationIds = Array.from(new Set((squareConfigs || []).map((config) => config?.square_location_id).filter(Boolean)));

  const relevantDeliveries = (deliveries || []).filter((delivery) => {
    return isRecentDelivery(delivery?.delivery_date)
      && Number(delivery?.cod_total_amount_required || 0) > 0
      && delivery?.status !== 'pending';
  });

  const { patientById, patientByPid } = await buildPatientMaps(base44, relevantDeliveries);
  const lookbackStartAt = getLookbackStartAt();
  const [catalogItems, completedOrders] = await Promise.all([
    listActiveCatalogItems(accessToken),
    listCompletedOrders(allSquareLocationIds, lookbackStartAt, accessToken),
  ]);

  const catalogBySignature = new Map();
  for (const item of catalogItems) {
    const itemName = normalizeText(item?.item_data?.name);
    if (!itemName) continue;
    const amountCents = getCatalogItemAmountCents(item);
    catalogBySignature.set(buildItemSignature(itemName, amountCents), item);
  }

  const paidOrderItems = flattenPaidOrderItems(completedOrders);
  const paidCatalogObjectIds = new Set(paidOrderItems.map((item) => item.catalog_object_id).filter(Boolean));
  const paidOrderItemsBySignature = new Map();
  const paidOrderItemsByLocationSignature = new Map();
  const paidOrderItemsByComparableLocationSignature = new Map();
  for (const item of paidOrderItems) {
    const signature = buildItemSignature(item.item_name, item.amount_cents);
    const locationSignature = buildLocationSignature(item.item_name, item.amount_cents, item.location_id);
    const comparableLocationSignature = buildComparableLocationSignature(item.item_name, item.amount_cents, item.location_id);
    if (!paidOrderItemsBySignature.has(signature)) paidOrderItemsBySignature.set(signature, []);
    if (!paidOrderItemsByLocationSignature.has(locationSignature)) paidOrderItemsByLocationSignature.set(locationSignature, []);
    if (!paidOrderItemsByComparableLocationSignature.has(comparableLocationSignature)) paidOrderItemsByComparableLocationSignature.set(comparableLocationSignature, []);
    paidOrderItemsBySignature.get(signature).push(item);
    paidOrderItemsByLocationSignature.get(locationSignature).push(item);
    paidOrderItemsByComparableLocationSignature.get(comparableLocationSignature).push(item);
  }

  const transactionsByDeliveryId = new Map();
  const completedTransactionCatalogObjectIds = new Set();
  const completedTransactionLocationSignatures = new Set();
  const completedTransactionComparableLocationSignatures = new Set();
  for (const transaction of squareTransactions || []) {
    const amountCents = transaction?.amount_cents ?? Math.round(Number(transaction?.amount || 0) * 100);
    if (!normalizeText(transaction?.item_name)) continue;
    if (transaction?.delivery_id) {
      if (!transactionsByDeliveryId.has(transaction.delivery_id)) transactionsByDeliveryId.set(transaction.delivery_id, []);
      transactionsByDeliveryId.get(transaction.delivery_id).push(transaction);
    }
    if (['completed', 'refunded'].includes(transaction?.status)) {
      if (transaction?.square_catalog_object_id) completedTransactionCatalogObjectIds.add(transaction.square_catalog_object_id);
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
    const resolvedPatient = await resolveDeliveryPatient(base44, delivery, patientById, patientByPid);
    const resolvedPatientName = await resolveDeliveryPatientName(base44, delivery, patientById, patientByPid);
    const itemName = formatItemName(delivery.delivery_date, store?.abbreviation, resolvedPatientName);
    const amountCents = Math.round(Number(delivery.cod_total_amount_required || 0) * 100);
    const signature = buildItemSignature(itemName, amountCents);
    const locationSignature = buildLocationSignature(itemName, amountCents, activeConfig?.square_location_id);
    const comparableLocationSignature = buildComparableLocationSignature(itemName, amountCents, activeConfig?.square_location_id);
    let catalogItem = catalogBySignature.get(signature);
    const paidMatches = paidOrderItemsBySignature.get(signature) || [];
    const catalogVariationIds = (catalogItem?.item_data?.variations || []).map((variation) => variation?.id).filter(Boolean);
    const isPaidByCatalogObjectId = catalogItem ? paidCatalogObjectIds.has(catalogItem.id) || catalogVariationIds.some((variationId) => paidCatalogObjectIds.has(variationId)) : false;
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
    const shouldDeleteForInvalidState = !activeConfig || !store?.square_location_config_id || !activeConfig?.square_location_id || delivery.status === 'pending' || delivery.status === 'failed' || delivery.status === 'cancelled';

    if (shouldDeleteForInvalidState) {
      if (catalogItem) itemsToDelete.push(catalogItem.id);
      for (const transaction of existingTransactions) {
        if (transaction.status === 'pending') transactionsToCancel.push(transaction.id);
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
        if (catalogItem) itemsToDelete.push(catalogItem.id);
        for (const transaction of existingTransactions) {
          if (transaction.status === 'pending') transactionsToComplete.push(transaction.id);
        }
      }
      continue;
    }

    deliveriesToCreate.push({
      delivery,
      itemName,
      patientName: resolvedPatientName,
      patientId: resolvedPatient?.id || (isValidEntityId(delivery.patient_id) ? delivery.patient_id : null),
      amountCents,
      locationId: activeConfig.square_location_id,
    });
  }

  const uniqueItemIdsToDelete = Array.from(new Set(itemsToDelete.filter(Boolean)));
  if (uniqueItemIdsToDelete.length) {
    await deleteCatalogObjects(uniqueItemIdsToDelete, accessToken);
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
    const { delivery, itemName, patientName, patientId, amountCents, locationId } = entry;
    const signature = buildItemSignature(itemName, amountCents);
    let catalogItem = catalogBySignature.get(signature);

    if (!catalogItem || !catalogItem?.present_at_location_ids?.includes(locationId)) {
      catalogItem = await createCatalogItem({
        itemName,
        amountCents,
        locationId,
        deliveryId: delivery.id,
        patientName,
        accessToken,
      });
      if (catalogItem) {
        catalogBySignature.set(signature, catalogItem);
        createdCount += 1;
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
      patient_id: patientId,
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
      await base44.asServiceRole.entities.SquareTransaction.create(transactionPayload);
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

  const staleIds = new Set(staleTransactions.map((transaction) => transaction.id));
  const syncedCatalogTransactions = (allTransactionsAfterSync || [])
    .filter((transaction) => !staleIds.has(transaction.id))
    .filter((transaction) => transaction?.square_catalog_object_id)
    .filter((transaction) => transaction?.status === 'pending' || (transaction?.status === 'completed' && isOfflineCollectedPaymentMethod(transaction?.payment_method)));
  const existingSquareCatalogItems = await base44.asServiceRole.entities.SquareCatalogItems.list('-updated_date', 2000).catch(() => []);
  for (const record of existingSquareCatalogItems || []) {
    await base44.asServiceRole.entities.SquareCatalogItems.delete(record.id);
  }

  if (syncedCatalogTransactions.length > 0) {
    await base44.asServiceRole.entities.SquareCatalogItems.bulkCreate(syncedCatalogTransactions.map((transaction) => {
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
        status: transaction?.status === 'pending' ? 'active' : 'completed',
      };
    }));
  }

  return {
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
    synced_square_catalog_items: syncedCatalogTransactions.length,
  };
}

async function handleSyncSquareCods(base44, payload) {
  const event = payload?.event;
  if (event?.entity_name === 'Delivery') {
    const delivery = payload?.data || await base44.asServiceRole.entities.Delivery.get(event.entity_id).catch(() => null);
    if (!delivery || Number(delivery?.cod_total_amount_required || 0) <= 0) {
      return { success: true, processed: 0, results: [{ deliveryId: event?.entity_id, action: 'noop', status: 'skipped' }] };
    }

    if (delivery.status === 'pending' || delivery.status === 'failed' || delivery.status === 'cancelled') {
      const result = await handleDeleteCodItem(base44, { deliveryId: delivery.id, reason: delivery.status });
      return { success: true, processed: 1, results: [{ deliveryId: delivery.id, action: 'delete', status: 'ok', result }] };
    }

    const result = await handleCreateCodItem(base44, {
      deliveryId: delivery.id,
      codAmount: delivery.cod_total_amount_required,
      deliveryDate: delivery.delivery_date,
      storeId: delivery.store_id,
      patientName: delivery.patient_name,
    });
    return { success: true, processed: 1, results: [{ deliveryId: delivery.id, action: 'upsert', status: result?.skipped ? 'skipped' : 'ok', result }] };
  }

  const items = Array.isArray(payload?.items) ? payload.items : [];
  const deletions = Array.isArray(payload?.deletions) ? payload.deletions : [];

  if (!items.length && !deletions.length) {
    return handleSyncCatalogItems(base44);
  }

  const results = [];
  for (const deletion of deletions) {
    const result = await handleDeleteCodItem(base44, {
      deliveryId: deletion?.deliveryId,
      catalogObjectId: deletion?.catalogObjectId,
      transactionId: deletion?.transactionId,
      reason: deletion?.status === 'failed' ? 'failed' : deletion?.reason,
    });
    results.push({ deliveryId: deletion?.deliveryId, action: 'delete', status: 'ok', result });
  }

  for (const item of items) {
    const result = await handleCreateCodItem(base44, {
      deliveryId: item?.deliveryId,
      patientName: item?.patientName,
      storeAbbreviation: item?.storeAbbreviation,
      codAmount: item?.codAmount,
      deliveryDate: item?.deliveryDate,
      storeId: item?.storeId,
    });
    results.push({ deliveryId: item?.deliveryId, action: 'upsert', status: result?.skipped ? 'skipped' : 'ok', result });
  }

  return { success: true, processed: results.length, results };
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const payload = await req.json().catch(() => ({}));
    const action = payload?.action;

    if (action === 'createCodItem') {
      await requireUser(base44);
      return Response.json(await handleCreateCodItem(base44, payload));
    }
    if (action === 'deleteCodItem') {
      await requireUser(base44);
      return Response.json(await handleDeleteCodItem(base44, payload));
    }
    if (action === 'fetchPayments') {
      await requireUser(base44);
      return Response.json(await handleFetchPayments(payload));
    }
    if (action === 'getCodData') {
      await requireUser(base44);
      return Response.json(await handleGetCodData(base44));
    }
    if (action === 'recordPayment') {
      return Response.json(await handleRecordPayment(base44, payload));
    }
    if (action === 'syncCatalogItems') {
      await requireAdminIfAuthenticated(base44);
      return Response.json(await handleSyncCatalogItems(base44));
    }
    if (action === 'syncSquareCods') {
      await requireUser(base44);
      return Response.json(await handleSyncSquareCods(base44, payload));
    }

    throw new HttpError(400, 'Missing or invalid action');
  } catch (error) {
    const status = error?.status || 500;
    return Response.json({ error: error?.message || 'Internal Server Error' }, { status });
  }
});