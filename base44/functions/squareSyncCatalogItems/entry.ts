import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

const SQUARE_BASE_URL = 'https://connect.squareup.com';
const SQUARE_VERSION = '2025-01-23';
const CATALOG_LOOKBACK_DAYS = 30;
const TRANSACTION_RETENTION_DAYS = 30;
const MATCH_DATE_OFFSET_DAYS = 2;
const SQUARE_API_MAX_RETRIES = 3;
const SQUARE_RETRY_BASE_DELAY_MS = 400;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function normalizeText(value) {
  return String(value || '').trim();
}

function unwrapEntityRecord(record) {
  if (!record || typeof record !== 'object') return null;
  if (record.data && typeof record.data === 'object') {
    return { ...record.data, id: record.data.id || record.id, created_date: record.data.created_date || record.created_date, updated_date: record.data.updated_date || record.updated_date };
  }
  return record;
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableSquareStatus(status) {
  return [408, 409, 429, 500, 502, 503, 504].includes(Number(status));
}

function extractCatalogMonthDay(value) {
  const normalized = normalizeText(value);
  const isoMatch = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) return `${isoMatch[2]}-${isoMatch[3]}`;

  const prefix = normalized.slice(0, 5);
  const itemMatch = prefix.match(/^(\d{2})\/(\d{2})$/);
  if (itemMatch) return `${itemMatch[1]}-${itemMatch[2]}`;

  return '';
}

function parseDateValue(value, referenceDate = new Date()) {
  const normalized = normalizeText(value);
  const isoMatch = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    return new Date(Date.UTC(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3])));
  }

  const monthDayKey = extractCatalogMonthDay(normalized);
  if (!monthDayKey) return null;

  const [month, day] = monthDayKey.split('-').map(Number);
  const referenceUtc = new Date(Date.UTC(
    referenceDate.getUTCFullYear(),
    referenceDate.getUTCMonth(),
    referenceDate.getUTCDate(),
  ));

  const candidates = [referenceUtc.getUTCFullYear() - 1, referenceUtc.getUTCFullYear(), referenceUtc.getUTCFullYear() + 1]
    .map((year) => new Date(Date.UTC(year, month - 1, day)));

  return candidates.sort((a, b) => Math.abs(a.getTime() - referenceUtc.getTime()) - Math.abs(b.getTime() - referenceUtc.getTime()))[0] || null;
}

function buildLocationDateAmountSignature(locationId, dateValue, amountCents, referenceDate = new Date()) {
  const parsed = parseDateValue(dateValue, referenceDate);
  const month = parsed ? String(parsed.getUTCMonth() + 1).padStart(2, '0') : 'unknown';
  const day = parsed ? String(parsed.getUTCDate()).padStart(2, '0') : 'unknown';
  return `${normalizeText(locationId)}::${month}-${day}::${toAmountCents(amountCents)}`;
}

function buildLocationDateAmountSignatureCandidates(locationId, dateValue, amountCents, offsetDays = MATCH_DATE_OFFSET_DAYS, referenceDate = new Date()) {
  const parsed = parseDateValue(dateValue, referenceDate);
  if (!parsed || Number.isNaN(parsed.getTime())) {
    return [buildLocationDateAmountSignature(locationId, dateValue, amountCents, referenceDate)];
  }

  const signatures = [];
  for (let offset = -offsetDays; offset <= offsetDays; offset += 1) {
    const candidate = new Date(parsed.getTime() + offset * 24 * 60 * 60 * 1000);
    const month = String(candidate.getUTCMonth() + 1).padStart(2, '0');
    const day = String(candidate.getUTCDate()).padStart(2, '0');
    signatures.push(`${normalizeText(locationId)}::${month}-${day}::${toAmountCents(amountCents)}`);
  }

  return Array.from(new Set(signatures));
}

function isRecentDelivery(deliveryDate) {
  const deliveryTime = parseDateValue(deliveryDate)?.getTime();
  const cutoff = Date.now() - CATALOG_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  return Number.isFinite(deliveryTime) && deliveryTime >= cutoff;
}

function isRecentCatalogItemName(itemName) {
  const itemTime = parseDateValue(itemName)?.getTime();
  const cutoff = Date.now() - CATALOG_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  return Number.isFinite(itemTime) && itemTime >= cutoff;
}

function getLookbackStartAt() {
  return new Date(Date.now() - CATALOG_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

function getTransactionRetentionStartMs() {
  return Date.now() - TRANSACTION_RETENTION_DAYS * 24 * 60 * 60 * 1000;
}

async function requireAdminIfAuthenticated(base44) {
  const isAuthenticated = await base44.auth.isAuthenticated().catch(() => false);
  if (!isAuthenticated) return null;
  const user = await base44.auth.me().catch(() => null);
  if (user?.role !== 'admin') throw new HttpError(403, 'Forbidden: Admin access required');
  return user;
}

function ensureSquareToken() {
  const accessToken = Deno.env.get('SQUARE_ACCESS_TOKEN');
  if (!accessToken) throw new HttpError(500, 'Square credentials not configured');
  return accessToken;
}

async function squareFetch(path, method, accessToken, body) {
  let lastError = null;
  for (let attempt = 1; attempt <= SQUARE_API_MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetch(`${SQUARE_BASE_URL}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Square-Version': SQUARE_VERSION,
        },
        body: body ? JSON.stringify(body) : undefined,
      });

      const responseText = await response.text();
      const json = responseText ? JSON.parse(responseText) : {};
      if (!response.ok) {
        const message = json?.errors?.map((error) => error.detail).join(', ') || `Square API error ${response.status}`;
        lastError = new Error(message);
        if (attempt < SQUARE_API_MAX_RETRIES && isRetryableSquareStatus(response.status)) {
          await sleep(SQUARE_RETRY_BASE_DELAY_MS * attempt);
          continue;
        }
        throw lastError;
      }
      return json;
    } catch (error) {
      lastError = error;
      if (attempt < SQUARE_API_MAX_RETRIES) {
        await sleep(SQUARE_RETRY_BASE_DELAY_MS * attempt);
        continue;
      }
      throw lastError;
    }
  }
  throw lastError || new Error('Square API request failed');
}

async function safeDeleteSquareCatalogObject(catalogObjectId, accessToken) {
  if (!catalogObjectId) return { attempted: false, ok: false };
  let lastFailure = null;
  for (let attempt = 1; attempt <= SQUARE_API_MAX_RETRIES; attempt += 1) {
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
      if (response.ok || response.status === 404) {
        return { attempted: true, ok: true, status: response.status, body: responseBody };
      }
      lastFailure = { attempted: true, ok: false, status: response.status, body: responseBody };
      if (attempt < SQUARE_API_MAX_RETRIES && isRetryableSquareStatus(response.status)) {
        await sleep(SQUARE_RETRY_BASE_DELAY_MS * attempt);
        continue;
      }
      return lastFailure;
    } catch (error) {
      lastFailure = { attempted: true, ok: false, error: error?.message || String(error) };
      if (attempt < SQUARE_API_MAX_RETRIES) {
        await sleep(SQUARE_RETRY_BASE_DELAY_MS * attempt);
        continue;
      }
      return lastFailure;
    }
  }
  return lastFailure || { attempted: true, ok: false, error: 'Delete failed' };
}

async function deleteCatalogObjects(objectIds, accessToken) {
  if (!objectIds.length) return { deleted: [], failed: [] };
  try {
    await squareFetch('/v2/catalog/batch-delete', 'POST', accessToken, { object_ids: objectIds });
    return { deleted: objectIds, failed: [] };
  } catch {
    const deleted = [];
    const failed = [];
    for (const objectId of objectIds) {
      const result = await safeDeleteSquareCatalogObject(objectId, accessToken);
      if (result?.ok) deleted.push(objectId);
      else failed.push({ objectId, result });
    }
    if (failed.length) throw new Error(`Failed to delete Square catalog items: ${failed.map((entry) => entry.objectId).join(', ')}`);
    return { deleted, failed: [] };
  }
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
              price_money: { amount: amountCents, currency: 'CAD' },
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
        sort: { sort_field: 'CLOSED_AT', sort_order: 'DESC' },
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
  const allSquareLocationIds = Array.from(new Set(
    (stores || [])
      .map((store) => activeConfigById.get(store?.square_location_config_id)?.square_location_id)
      .filter(Boolean)
  ));
  const transactionRetentionStartMs = getTransactionRetentionStartMs();
  const recentCodDeliveries = (deliveries || []).filter((delivery) => isRecentDelivery(delivery?.delivery_date) && Number(delivery?.cod_total_amount_required || 0) > 0);

  await buildPatientMaps(base44, recentCodDeliveries);
  const lookbackStartAt = getLookbackStartAt();
  const [allCatalogItems, completedOrders] = await Promise.all([
    listActiveCatalogItems(accessToken),
    listCompletedOrders(allSquareLocationIds, lookbackStartAt, accessToken),
  ]);

  const recentCatalogItems = (allCatalogItems || []).filter((item) => isRecentCatalogItemName(item?.item_data?.name));
  const paidOrderItems = flattenPaidOrderItems(completedOrders).filter((item) => isRecentCatalogItemName(item?.item_name));
  const recentSquareTransactions = (squareTransactions || []).filter((transaction) => {
    const transactionTime = new Date(transaction?.created_date || transaction?.updated_date || 0).getTime();
    return Number.isFinite(transactionTime) && transactionTime >= transactionRetentionStartMs;
  });

  const getCatalogItemLocationIds = (item) => Array.from(new Set([
    ...(item?.present_at_location_ids || []),
    ...(item?.item_data?.variations || []).flatMap((variation) => variation?.present_at_location_ids || []),
  ].filter(Boolean)));

  const getCatalogItemAmountCents = (item) => {
    const variations = item?.item_data?.variations || [];
    const variation = variations.find((entry) => entry?.item_variation_data?.price_money?.amount != null) || variations[0];
    return toAmountCents(variation?.item_variation_data?.price_money?.amount);
  };

  const buildItemSignature = (itemName, amountCents) => `${normalizeText(itemName)}::${toAmountCents(amountCents)}`;
  const normalizeMatchName = (value) => normalizeText(value).replace(/\s+/g, ' ').replace(/\s-\s\$\d+(?:\.\d{2})?$/, '').replace(/^(\d{2})-(\d{2})/, '$1/$2').toLowerCase();
  const buildComparableLocationSignature = (itemName, amountCents, locationId) => `${normalizeText(locationId)}::${normalizeMatchName(itemName)}::${toAmountCents(amountCents)}`;

  const catalogBySignature = new Map();
  const catalogByDateLocationAmount = new Map();
  for (const item of recentCatalogItems) {
    const itemName = normalizeText(item?.item_data?.name);
    if (!itemName) continue;
    const amountCents = getCatalogItemAmountCents(item);
    catalogBySignature.set(buildItemSignature(itemName, amountCents), item);
    for (const locationId of getCatalogItemLocationIds(item)) {
      const signature = buildLocationDateAmountSignature(locationId, itemName, amountCents);
      if (!catalogByDateLocationAmount.has(signature)) catalogByDateLocationAmount.set(signature, item);
    }
  }

  const paidCatalogObjectIds = new Set(paidOrderItems.map((item) => item.catalog_object_id).filter(Boolean));
  const paidOrderItemSignatures = new Set();
  const paidOrderComparableSignatures = new Set();
  const paidOrderItemsByDateLocationAmountSignature = new Map();
  for (const item of paidOrderItems) {
    const signature = buildLocationDateAmountSignature(item.location_id, item.item_name, item.amount_cents);
    paidOrderItemSignatures.add(buildItemSignature(item.item_name, item.amount_cents));
    paidOrderComparableSignatures.add(buildComparableLocationSignature(item.item_name, item.amount_cents, item.location_id));
    if (!paidOrderItemsByDateLocationAmountSignature.has(signature)) paidOrderItemsByDateLocationAmountSignature.set(signature, []);
    paidOrderItemsByDateLocationAmountSignature.get(signature).push(item);
  }

  const settledTransactionCatalogObjectIds = new Set();
  const settledTransactionItemSignatures = new Set();
  const settledTransactionComparableSignatures = new Set();
  const settledTransactionDateLocationAmountSignatures = new Set();
  for (const transaction of recentSquareTransactions) {
    const amountCents = transaction?.amount_cents ?? Math.round(Number(transaction?.amount || 0) * 100);
    if (transaction?.status && transaction.status !== 'pending') {
      if (transaction?.square_catalog_object_id) settledTransactionCatalogObjectIds.add(transaction.square_catalog_object_id);
      settledTransactionItemSignatures.add(buildItemSignature(transaction?.item_name, amountCents));
      settledTransactionComparableSignatures.add(buildComparableLocationSignature(transaction?.item_name, amountCents, transaction?.location_id));
      for (const signature of buildLocationDateAmountSignatureCandidates(transaction?.location_id, transaction?.item_name, amountCents)) {
        settledTransactionDateLocationAmountSignatures.add(signature);
      }
    }
  }

  const itemsToDelete = [];
  for (const item of recentCatalogItems) {
    const itemName = normalizeText(item?.item_data?.name);
    if (!itemName) continue;
    const amountCents = getCatalogItemAmountCents(item);
    const itemSignature = buildItemSignature(itemName, amountCents);
    const itemLocationIds = getCatalogItemLocationIds(item);
    const itemComparableSignatures = itemLocationIds.map((locationId) => buildComparableLocationSignature(itemName, amountCents, locationId));
    const variationIds = (item?.item_data?.variations || []).map((variation) => variation?.id).filter(Boolean);
    const itemDateSignatures = itemLocationIds.map((locationId) => buildLocationDateAmountSignature(locationId, itemName, amountCents));
    const matchedByPaidOrder = paidCatalogObjectIds.has(item.id)
      || variationIds.some((variationId) => paidCatalogObjectIds.has(variationId))
      || paidOrderItemSignatures.has(itemSignature)
      || itemComparableSignatures.some((signature) => paidOrderComparableSignatures.has(signature))
      || itemDateSignatures.some((signature) => paidOrderItemsByDateLocationAmountSignature.has(signature));
    const matchedBySettledTransaction = settledTransactionCatalogObjectIds.has(item.id)
      || variationIds.some((variationId) => settledTransactionCatalogObjectIds.has(variationId))
      || settledTransactionItemSignatures.has(itemSignature)
      || itemComparableSignatures.some((signature) => settledTransactionComparableSignatures.has(signature))
      || itemDateSignatures.some((signature) => settledTransactionDateLocationAmountSignatures.has(signature));
    if (matchedByPaidOrder || matchedBySettledTransaction) itemsToDelete.push(item.id);
  }

  const uniqueItemIdsToDelete = Array.from(new Set(itemsToDelete.filter(Boolean)));
  const deleteResult = uniqueItemIdsToDelete.length ? await deleteCatalogObjects(uniqueItemIdsToDelete, accessToken) : { deleted: [], failed: [] };

  const staleTransactions = (recentSquareTransactions || []).filter((transaction) => {
    const delivery = deliveryById.get(transaction.delivery_id);
    return !delivery && transaction?.status === 'pending';
  });
  for (const transaction of staleTransactions) {
    await base44.asServiceRole.entities.SquareTransaction.update(transaction.id, { status: 'cancelled' }).catch(() => null);
  }

  const existingSquareCatalogItems = await base44.asServiceRole.entities.SquareCatalogItems.list('-updated_date', 2000).catch(() => []);
  for (const record of existingSquareCatalogItems || []) {
    await base44.asServiceRole.entities.SquareCatalogItems.delete(record.id).catch(() => null);
  }

  const syncedCatalogTransactions = (recentSquareTransactions || [])
    .filter((transaction) => transaction?.square_catalog_object_id)
    .filter((transaction) => transaction?.status === 'pending')
    .filter((transaction) => {
      const delivery = deliveryById.get(transaction.delivery_id);
      return isRecentDelivery(delivery?.delivery_date || transaction?.item_name);
    });

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
        status: 'active',
      };
    }));
  }

  return {
    success: true,
    scanned_deliveries: recentCodDeliveries.length,
    catalog_items_seen: recentCatalogItems.length,
    paid_order_items_seen: paidOrderItems.length,
    deleted_catalog_items: deleteResult.deleted.length,
    cancelled_transactions: staleTransactions.length,
    completed_transactions: 0,
    created_catalog_items: 0,
    updated_pending_transactions: 0,
    pruned_transactions: 0,
    synced_square_catalog_items: syncedCatalogTransactions.length,
  };
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    await req.text().catch(() => '');
    await requireAdminIfAuthenticated(base44);
    return Response.json(await handleSyncCatalogItems(base44));
  } catch (error) {
    const status = error?.status || 500;
    return Response.json({ error: error?.message || 'Internal Server Error' }, { status });
  }
});