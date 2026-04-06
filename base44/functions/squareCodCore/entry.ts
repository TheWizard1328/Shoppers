import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

const SQUARE_BASE_URL = 'https://connect.squareup.com';
const SQUARE_VERSION = '2025-01-23';
const CATALOG_LOOKBACK_DAYS = 60;
const TRANSACTION_RETENTION_DAYS = 60;
const MATCH_DATE_OFFSET_DAYS = 2;
const SQUARE_API_MAX_RETRIES = 3;
const SQUARE_RETRY_BASE_DELAY_MS = 400;
const DELIVERY_BULK_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

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
    return {
      ...record.data,
      id: record.data.id || record.id,
      created_date: record.data.created_date || record.created_date,
      updated_date: record.data.updated_date || record.updated_date,
    };
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
  const [, month, day] = String(deliveryDate || '').split('-');
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
  const isoMatch = normalized.match(/^\d{4}-(\d{2})-(\d{2})$/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}`;

  const prefix = normalized.slice(0, 5);
  const itemMatch = prefix.match(/^(\d{2})\/(\d{2})$/);
  if (itemMatch) return `${itemMatch[1]}-${itemMatch[2]}`;

  return '';
}

function parseDateValue(value, referenceDate = new Date()) {
  const normalized = normalizeText(value);
  const isoMatch = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    return new Date(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3]));
  }

  const monthDayKey = extractCatalogMonthDay(normalized);
  if (!monthDayKey) return null;

  const [month, day] = monthDayKey.split('-').map(Number);
  const referenceLocal = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate());
  const candidates = [referenceLocal.getFullYear() - 1, referenceLocal.getFullYear(), referenceLocal.getFullYear() + 1]
    .map((year) => new Date(year, month - 1, day));

  return candidates.sort((a, b) => Math.abs(a.getTime() - referenceLocal.getTime()) - Math.abs(b.getTime() - referenceLocal.getTime()))[0] || null;
}

function getMonthDayKey(value, referenceDate = new Date()) {
  const parsed = parseDateValue(value, referenceDate);
  if (!parsed || Number.isNaN(parsed.getTime())) return '';
  const month = String(parsed.getMonth() + 1).padStart(2, '0');
  const day = String(parsed.getDate()).padStart(2, '0');
  return `${month}-${day}`;
}

function buildLocationDateAmountSignature(locationId, dateValue, amountCents, referenceDate = new Date()) {
  return `${normalizeText(locationId)}::${getMonthDayKey(dateValue, referenceDate) || 'unknown-date'}::${toAmountCents(amountCents)}`;
}

function buildLocationDateAmountSignatureCandidates(locationId, dateValue, amountCents, offsetDays = MATCH_DATE_OFFSET_DAYS, referenceDate = new Date()) {
  const parsed = parseDateValue(dateValue, referenceDate);
  if (!parsed || Number.isNaN(parsed.getTime())) {
    return [buildLocationDateAmountSignature(locationId, dateValue, amountCents, referenceDate)];
  }

  const signatures = [];
  for (let offset = -offsetDays; offset <= offsetDays; offset += 1) {
    const candidate = new Date(parsed.getTime() + offset * 24 * 60 * 60 * 1000);
    const month = String(candidate.getMonth() + 1).padStart(2, '0');
    const day = String(candidate.getDate()).padStart(2, '0');
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
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const cutoff = new Date(today);
  cutoff.setDate(cutoff.getDate() - TRANSACTION_RETENTION_DAYS);
  return cutoff.getTime();
}

function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function shouldRefreshDeliveries(lastRefreshedAt, forceRefresh = false) {
  if (forceRefresh) return true;
  const refreshedAtMs = new Date(lastRefreshedAt || 0).getTime();
  if (!Number.isFinite(refreshedAtMs) || refreshedAtMs <= 0) return true;
  return Date.now() - refreshedAtMs >= DELIVERY_BULK_REFRESH_INTERVAL_MS;
}

function hasCollectedCardPayment(delivery) {
  const codPayments = Array.isArray(delivery?.cod_payments) ? delivery.cod_payments : [];
  return codPayments.some((payment) => ['Debit', 'Credit'].includes(payment?.type) && Number(payment?.amount || 0) > 0)
    || ['Debit', 'Credit'].includes(delivery?.cod_payment_type);
}

function isOfflineCollectedPaymentMethod(paymentMethod) {
  return ['cash', 'check'].includes(String(paymentMethod || '').toLowerCase());
}

function hasCollectedOfflinePayment(delivery) {
  const codPayments = Array.isArray(delivery?.cod_payments) ? delivery.cod_payments : [];
  return codPayments.some((payment) => isOfflineCollectedPaymentMethod(payment?.type) && Number(payment?.amount || 0) > 0)
    || isOfflineCollectedPaymentMethod(delivery?.cod_payment_type);
}

function buildPlaceholderItemNames(deliveryDate, storeAbbreviation) {
  const [, month, day] = String(deliveryDate || '').split('-');
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
      if (result?.ok) {
        deleted.push(objectId);
      } else {
        failed.push({ objectId, result });
      }
    }

    if (failed.length) {
      throw new Error(`Failed to delete Square catalog items: ${failed.map((entry) => entry.objectId).join(', ')}`);
    }

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

  const patientMatches = await base44.asServiceRole.entities.Patient.filter({ patient_id: rawPatientRef }, '-updated_date', 1).catch(() => []);
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
  if (!effectiveStoreId) throw new HttpError(400, 'Store ID is required for Square COD item creation');

  const store = await base44.asServiceRole.entities.Store.get(effectiveStoreId).catch(() => null);
  if (!store) throw new HttpError(400, `Store not found with ID: ${effectiveStoreId}`);
  if (!store.square_location_config_id) throw new HttpError(400, `Store "${store.name}" is not configured for Square COD payments.`);

  const config = await base44.asServiceRole.entities.SquareLocationConfig.get(store.square_location_config_id).catch(() => null);
  if (!config) throw new HttpError(400, `Square location config not found for store "${store.name}"`);
  if (config.status !== 'active') throw new HttpError(400, `Square location "${config.name}" is inactive for store "${store.name}"`);

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

async function getActiveStoreSquareLocationIds(base44) {
  const [stores, locationConfigs] = await Promise.all([
    base44.asServiceRole.entities.Store.list('-updated_date', 500),
    base44.asServiceRole.entities.SquareLocationConfig.filter({ status: 'active' }),
  ]);

  const configById = new Map((locationConfigs || []).map((config) => [config.id, config]));

  return Array.from(new Set(
    (stores || [])
      .map((store) => configById.get(store?.square_location_config_id)?.square_location_id)
      .filter(Boolean)
  ));
}

function toIsoDate(value) {
  const parsed = parseDateValue(value);
  if (!parsed || Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
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
  const lookedUpPatientName = deliveryRecord ? await resolveDeliveryPatientName(base44, deliveryRecord, patientById, patientByPid) : '';
  const usableLookedUpPatientName = lookedUpPatientName === 'Unknown Patient' ? '' : lookedUpPatientName;
  const resolvedPatientName = normalizeText(usableLookedUpPatientName || patientName || deliveryRecord?.patient_name);
  if (!resolvedPatientName || resolvedPatientName === 'COD' || resolvedPatientName === 'Unknown Patient') {
    return { success: true, skipped: true, reason: 'missing_patient_name' };
  }

  const resolvedPatientId = patientRecord?.id || (isValidEntityId(deliveryRecord?.patient_id) ? deliveryRecord.patient_id : null);
  const resolvedStoreAbbr = normalizeText(store?.abbreviation || storeAbbreviation || 'XX');
  const amountCents = Math.round(Number(codAmount) * 100);
  const itemName = formatItemName(resolvedDeliveryDate, resolvedStoreAbbr, resolvedPatientName);

  const existingPending = await base44.asServiceRole.entities.SquareTransaction.filter({ delivery_id: deliveryId, status: 'pending' }).catch(() => []);

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
    const outdatedDeleteResult = await safeDeleteSquareCatalogObject(existingPending[0].square_catalog_object_id, accessToken);
    if (!outdatedDeleteResult?.ok) throw new Error(`Failed to delete outdated Square catalog item for delivery ${deliveryId}`);
  }

  const catalogItem = await createCatalogItem({ itemName, amountCents, locationId, deliveryId, patientName: resolvedPatientName, accessToken });
  const catalogObjectId = catalogItem?.id || null;
  const catalogVersion = catalogItem?.version || null;
  if (!catalogObjectId) throw new Error(`Square did not return a catalog item for delivery ${deliveryId}`);

  const existingTransactions = await base44.asServiceRole.entities.SquareTransaction.filter({ delivery_id: deliveryId, status: 'pending' }).catch(() => []);
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
    transaction = await base44.asServiceRole.entities.SquareTransaction.create({ ...transactionPayload, type: 'collection', status: 'pending', delivery_id: deliveryId });
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

  return { success: true, catalogObjectId, catalogVersion, itemName, transactionId: transaction?.id || existingTransactions[0]?.id };
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
      if (!relatedTransactions.some((item) => item?.id === transaction?.id)) relatedTransactions.push(transaction);
    }
    if (!primaryTransaction && relatedTransactions.length > 0) primaryTransaction = relatedTransactions[0];
  }

  const catalogIdToDelete = catalogObjectId || primaryTransaction?.square_catalog_object_id || relatedTransactions[0]?.square_catalog_object_id || null;
  const squareDeleteResult = await safeDeleteSquareCatalogObject(catalogIdToDelete, accessToken);
  if (catalogIdToDelete && !squareDeleteResult?.ok) throw new Error(`Failed to delete Square catalog item ${catalogIdToDelete}`);

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
  await Promise.all(uniqueCatalogMatches.map((item) => base44.asServiceRole.entities.SquareCatalogItems.delete(item.id).catch(() => null)));

  return {
    success: true,
    deletedCatalogId: catalogIdToDelete,
    transactionCount: relatedTransactions.length,
    deletedCatalogRecordCount: uniqueCatalogMatches.length,
    squareDeleteResult,
    transactionStatus: relatedTransactions.length > 0 ? newStatus : 'deleted_from_square',
  };
}

async function handleFetchPayments(base44, payload) {
  const accessToken = ensureSquareToken();
  const { locationIds: requestedLocationIds, daysBack = 60, maxPerLocation = null, throttleMs = 150 } = payload || {};

  let locationIds = Array.isArray(requestedLocationIds) ? requestedLocationIds.filter(Boolean) : [];
  if (locationIds.length === 0) locationIds = await getActiveStoreSquareLocationIds(base44);
  if (locationIds.length === 0) throw new HttpError(400, 'No Square locations configured');

  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - daysBack);

  const allPayments = [];
  const soldCatalogItems = [];
  const soldCatalogItemKeys = new Set();

  for (const locationId of locationIds) {
    let cursor = null;
    let processedForLocation = 0;
    const locationCap = Number.isFinite(Number(maxPerLocation)) && Number(maxPerLocation) > 0 ? Number(maxPerLocation) : null;

    do {
      const queryParams = new URLSearchParams({
        location_id: locationId,
        begin_time: startDate.toISOString(),
        end_time: endDate.toISOString(),
        sort_order: 'DESC',
        limit: '100',
      });
      if (cursor) queryParams.set('cursor', cursor);

      const paymentsResponse = await fetch(`${SQUARE_BASE_URL}/v2/payments?${queryParams.toString()}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Square-Version': SQUARE_VERSION,
        },
      });

      if (!paymentsResponse.ok) break;
      const paymentsData = await paymentsResponse.json().catch(() => ({}));
      const payments = Array.isArray(paymentsData.payments) ? paymentsData.payments : [];

      for (const payment of payments) {
        if (locationCap && processedForLocation >= locationCap) break;
        if (payment.status !== 'COMPLETED') continue;

        processedForLocation += 1;
        allPayments.push(payment);

        if (payment.order_id) {
          await sleep(throttleMs);
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
                  const dedupeKey = [
                    payment.id,
                    payment.order_id,
                    lineItem.uid || lineItem.catalog_object_id || lineItem.name,
                    lineItem.base_price_money?.amount || 0,
                  ].join('::');
                  if (soldCatalogItemKeys.has(dedupeKey)) continue;
                  soldCatalogItemKeys.add(dedupeKey);

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
          } catch {}
        }
      }

      if (locationCap && processedForLocation >= locationCap) break;
      cursor = paymentsData.cursor || null;
    } while (cursor);
  }

  const existingTransactions = await base44.asServiceRole.entities.SquareTransaction.list('-updated_date', 2000).catch(() => []);
  const existingTransactionBySignature = new Map(
    (existingTransactions || []).map((transaction) => {
      const amountCents = transaction?.amount_cents ?? Math.round(Number(transaction?.amount || 0) * 100);
      return [buildLocationDateAmountSignature(transaction?.location_id, transaction?.item_name, amountCents), transaction];
    })
  );

  const normalizedTransactions = soldCatalogItems.map((item, index) => {
    const amountCents = Math.round(Number(item?.amount || 0) * 100);
    const matchedTransaction = existingTransactionBySignature.get(buildLocationDateAmountSignature(item?.location_id, item?.item_name, amountCents));

    return {
      id: `${item?.square_payment_id || item?.payment_id || 'payment'}-${item?.catalog_object_id || index}`,
      square_transaction_id: item?.square_transaction_id || item?.payment_id || null,
      square_payment_id: item?.square_payment_id || item?.payment_id || null,
      square_catalog_object_id: matchedTransaction?.square_catalog_object_id || item?.catalog_object_id || null,
      order_id: item?.order_id || null,
      item_name: item?.item_name || '',
      amount: Number(item?.amount || 0),
      amount_cents: amountCents,
      type: 'collection',
      status: matchedTransaction?.status === 'refunded' ? 'refunded' : 'completed',
      location_id: item?.location_id || matchedTransaction?.location_id || null,
      store_id: matchedTransaction?.store_id || null,
      driver_id: matchedTransaction?.driver_id || null,
      dispatcher_id: matchedTransaction?.dispatcher_id || null,
      patient_id: matchedTransaction?.patient_id || null,
      delivery_id: matchedTransaction?.delivery_id || null,
      payment_method: String(item?.payment_method || matchedTransaction?.payment_method || 'CARD').toLowerCase(),
      created_date: item?.payment_date || null,
      updated_date: item?.payment_date || null,
      raw_square_data: item,
    };
  });

  const soldItemCounts = new Map();
  soldCatalogItems.forEach((item) => {
    if (!item.catalog_object_id) return;
    soldItemCounts.set(item.catalog_object_id, (soldItemCounts.get(item.catalog_object_id) || 0) + 1);
  });

  const soldItems = Array.from(soldItemCounts.entries()).map(([catalogId, count]) => ({ catalog_object_id: catalogId, times_sold: count }));

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
  } catch {}

  return {
    success: true,
    paymentsCount: allPayments.length,
    transactions: normalizedTransactions,
    soldItems,
    soldCatalogItems,
    catalogItems,
    catalogItemCount,
    dateRange: { start: startDate.toISOString(), end: endDate.toISOString() },
  };
}

async function handleGetCodData(base44, payload = {}) {
  const accessToken = ensureSquareToken();
  const requestedDaysBack = Number(payload?.daysBack || TRANSACTION_RETENTION_DAYS);
  const daysBack = Number.isFinite(requestedDaysBack) && requestedDaysBack > 0 ? requestedDaysBack : CATALOG_LOOKBACK_DAYS;
  const transactionRetentionStartMs = Date.now() - daysBack * 24 * 60 * 60 * 1000;
  const refreshDeliveries = shouldRefreshDeliveries(payload?.lastDeliverySyncAt, payload?.forceDeliveryRefresh === true);

  const [locationConfigs, stores, transactionRecords] = await Promise.all([
    base44.asServiceRole.entities.SquareLocationConfig.filter({ status: 'active' }).catch(() => []),
    base44.asServiceRole.entities.Store.list('-updated_date', 500).catch(() => []),
    base44.asServiceRole.entities.SquareTransaction.list('-updated_date', 2000).catch(() => []),
  ]);

  const safeTransactionRecords = (Array.isArray(transactionRecords) ? transactionRecords : []).map(unwrapEntityRecord).filter(Boolean);
  const recentTransactionRecords = safeTransactionRecords.filter((transaction) => {
    const transactionTime = new Date(transaction?.created_date || transaction?.updated_date || 0).getTime();
    return Number.isFinite(transactionTime) && transactionTime >= transactionRetentionStartMs;
  });

  const safeLocationConfigs = (Array.isArray(locationConfigs) ? locationConfigs : []).map(unwrapEntityRecord).filter(Boolean);
  const safeStores = (Array.isArray(stores) ? stores : []).map(unwrapEntityRecord).filter(Boolean);
  const activeConfigById = new Map(safeLocationConfigs.map((config) => [config.id, config]));
  const storeByLocationId = new Map(
    safeStores
      .map((store) => {
        const config = activeConfigById.get(store?.square_location_config_id);
        return config?.square_location_id ? [config.square_location_id, store] : null;
      })
      .filter(Boolean)
  );
  const locationIds = Array.from(new Set(
    safeStores
      .map((store) => activeConfigById.get(store?.square_location_config_id)?.square_location_id)
      .filter(Boolean)
  ));

  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - TRANSACTION_RETENTION_DAYS);
  const startDateStr = formatLocalDate(startDate);
  const endDateStr = formatLocalDate(endDate);

  let safeDeliveries = [];
  if (refreshDeliveries) {
    const deliveriesResult = await base44.asServiceRole.entities.Delivery.filter({ delivery_date: { $gte: startDateStr, $lte: endDateStr } }, '-updated_date', 5000).catch(() => []);
    safeDeliveries = (Array.isArray(deliveriesResult) ? deliveriesResult : []).map(unwrapEntityRecord).filter(Boolean);
  }

  const liveCatalogItems = await listActiveCatalogItems(accessToken).catch(() => []);
  const catalogRecords = (liveCatalogItems || []).flatMap((item) => {
    const amountCents = getCatalogItemAmountCents(item);
    const locationIdsForItem = Array.from(new Set([
      ...(item?.present_at_location_ids || []),
      ...(item?.item_data?.variations || []).flatMap((variation) => variation?.present_at_location_ids || []),
    ].filter(Boolean)));

    if (locationIdsForItem.length === 0) return [];

    return locationIdsForItem.map((locationId) => {
      const store = storeByLocationId.get(locationId);
      return {
        square_catalog_object_id: item?.id,
        square_catalog_version: item?.version || null,
        item_name: item?.item_data?.name || '',
        description: item?.item_data?.description || '',
        amount: amountCents / 100,
        amount_cents: amountCents,
        delivery_id: null,
        delivery_date: toIsoDate(item?.item_data?.name),
        patient_id: null,
        store_id: store?.id || null,
        location_id: locationId,
        status: 'active',
        created_date: item?.created_at || null,
        updated_date: item?.updated_at || null,
      };
    });
  });

  return {
    success: true,
    deliveries: safeDeliveries,
    shouldRefreshDeliveries: refreshDeliveries,
    deliverySyncWindow: {
      startDate: startDateStr,
      endDate: endDateStr,
      refreshedAt: refreshDeliveries ? new Date().toISOString() : null,
    },
    catalogRecords,
    transactionRecords: recentTransactionRecords,
    locationConfigs: safeLocationConfigs,
    locationIds,
  };
}

async function handleRecordPayment(base44, payload) {
  const { deliveryId, paymentMethod, driverId, patientId, storeId } = payload || {};
  if (!deliveryId || !paymentMethod) throw new HttpError(400, 'Missing required fields: deliveryId, paymentMethod');

  const user = await requireUser(base44);
  const transactions = await base44.asServiceRole.entities.SquareTransaction.filter({ delivery_id: deliveryId, status: 'pending' });
  if (transactions.length === 0) throw new HttpError(404, 'No pending Square transaction found for this delivery');

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

  return { success: true, transactionId: transaction.id, itemName: transaction.item_name, amount: transaction.amount, paymentMethod };
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
    (squareConfigs || []).filter((config) => config?.status === 'active' && config?.square_location_id).map((config) => [config.id, config])
  );
  const storeById = new Map((stores || []).map((store) => [store.id, store]));
  const deliveryById = new Map((deliveries || []).map((delivery) => [delivery.id, delivery]));
  const allSquareLocationIds = Array.from(new Set(
    (stores || []).map((store) => activeConfigById.get(store?.square_location_config_id)?.square_location_id).filter(Boolean)
  ));
  const transactionRetentionStartMs = getTransactionRetentionStartMs();
  const recentCodDeliveries = (deliveries || []).filter((delivery) => isRecentDelivery(delivery?.delivery_date) && Number(delivery?.cod_total_amount_required || 0) > 0);

  const { patientById, patientByPid } = await buildPatientMaps(base44, recentCodDeliveries);
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

  const isCatalogItemAtLocation = (item, locationId) => {
    if (!item || !locationId) return false;
    if (item?.present_at_all_locations) return true;
    return getCatalogItemLocationIds(item).includes(locationId);
  };

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

  const transactionsByDeliveryId = new Map();
  const settledTransactionCatalogObjectIds = new Set();
  const settledTransactionItemSignatures = new Set();
  const settledTransactionComparableSignatures = new Set();
  const settledTransactionDateLocationAmountSignatures = new Set();
  for (const transaction of recentSquareTransactions) {
    const amountCents = transaction?.amount_cents ?? Math.round(Number(transaction?.amount || 0) * 100);
    if (transaction?.delivery_id) {
      if (!transactionsByDeliveryId.has(transaction.delivery_id)) transactionsByDeliveryId.set(transaction.delivery_id, []);
      transactionsByDeliveryId.get(transaction.delivery_id).push(transaction);
    }

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
  const transactionsToCancel = [];
  const transactionsToComplete = [];
  const deliveriesToSync = [];
  const directlyMatchedCatalogItemIds = new Set();
  const directlyMatchedDateLocationAmountSignatures = new Set();

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

    if (matchedByPaidOrder || matchedBySettledTransaction) {
      directlyMatchedCatalogItemIds.add(item.id);
      itemDateSignatures.forEach((signature) => directlyMatchedDateLocationAmountSignatures.add(signature));
      itemsToDelete.push(item.id);
    }
  }

  for (const transaction of recentSquareTransactions) {
    if (transaction?.status !== 'pending') continue;
    const candidateSignatures = buildLocationDateAmountSignatureCandidates(
      transaction?.location_id,
      deliveryById.get(transaction?.delivery_id)?.delivery_date || transaction?.item_name,
      transaction?.amount_cents ?? Math.round(Number(transaction?.amount || 0) * 100),
    );
    if (directlyMatchedCatalogItemIds.has(transaction?.square_catalog_object_id) || candidateSignatures.some((signature) => directlyMatchedDateLocationAmountSignatures.has(signature))) {
      transactionsToComplete.push(transaction.id);
    }
  }

  for (const delivery of recentCodDeliveries) {
    const store = storeById.get(delivery.store_id);
    const activeConfig = store?.square_location_config_id ? activeConfigById.get(store.square_location_config_id) : null;
    const resolvedPatient = await resolveDeliveryPatient(base44, delivery, patientById, patientByPid);
    const resolvedPatientName = await resolveDeliveryPatientName(base44, delivery, patientById, patientByPid);
    const itemName = formatItemName(delivery.delivery_date, store?.abbreviation, resolvedPatientName);
    const amountCents = Math.round(Number(delivery.cod_total_amount_required || 0) * 100);
    const signature = buildItemSignature(itemName, amountCents);
    const deliveryDateSignatures = buildLocationDateAmountSignatureCandidates(activeConfig?.square_location_id, delivery.delivery_date, amountCents);
    let catalogItem = catalogBySignature.get(signature) || deliveryDateSignatures.map((entry) => catalogByDateLocationAmount.get(entry)).find(Boolean) || null;
    const existingTransactions = transactionsByDeliveryId.get(delivery.id) || [];
    const settledTransactions = existingTransactions.filter((transaction) => transaction?.status && transaction.status !== 'pending');
    const placeholderNames = new Set(buildPlaceholderItemNames(delivery.delivery_date, store?.abbreviation));

    if (resolvedPatientName !== 'Unknown Patient' && activeConfig?.square_location_id) {
      for (const placeholderItem of recentCatalogItems) {
        const placeholderName = normalizeText(placeholderItem?.item_data?.name);
        if (!placeholderNames.has(placeholderName)) continue;
        if (getCatalogItemAmountCents(placeholderItem) !== amountCents) continue;
        if (isCatalogItemAtLocation(placeholderItem, activeConfig.square_location_id)) itemsToDelete.push(placeholderItem.id);
      }
    }

    const existingPending = existingTransactions.find((transaction) => transaction.status === 'pending');
    if (existingPending?.square_catalog_object_id && (existingPending.item_name !== itemName || toAmountCents(existingPending.amount_cents) !== amountCents)) {
      itemsToDelete.push(existingPending.square_catalog_object_id);
      if (catalogItem?.id === existingPending.square_catalog_object_id) catalogItem = null;
    }

    const hasCollectedCard = hasCollectedCardPayment(delivery);
    const hasCollectedOffline = hasCollectedOfflinePayment(delivery);
    const hasSquareConfirmedPayment = paidOrderItemSignatures.has(signature)
      || paidOrderComparableSignatures.has(buildComparableLocationSignature(itemName, amountCents, activeConfig?.square_location_id))
      || deliveryDateSignatures.some((signatureKey) => paidOrderItemsByDateLocationAmountSignature.has(signatureKey))
      || settledTransactions.length > 0
      || settledTransactionItemSignatures.has(signature)
      || settledTransactionComparableSignatures.has(buildComparableLocationSignature(itemName, amountCents, activeConfig?.square_location_id))
      || deliveryDateSignatures.some((signatureKey) => settledTransactionDateLocationAmountSignatures.has(signatureKey));
    const shouldDeleteForInvalidState = !activeConfig || !store?.square_location_config_id || !activeConfig?.square_location_id || ['pending', 'failed', 'cancelled'].includes(delivery?.status);
    const shouldDeleteCatalogItem = shouldDeleteForInvalidState || hasSquareConfirmedPayment;

    if (catalogItem && !isCatalogItemAtLocation(catalogItem, activeConfig?.square_location_id)) {
      itemsToDelete.push(catalogItem.id);
      catalogItem = null;
    }

    if (shouldDeleteCatalogItem) {
      if (catalogItem?.id) itemsToDelete.push(catalogItem.id);
      for (const transaction of existingTransactions) {
        if (transaction.status !== 'pending') continue;
        if (shouldDeleteForInvalidState) transactionsToCancel.push(transaction.id);
        else if (hasSquareConfirmedPayment) transactionsToComplete.push(transaction.id);
      }
      continue;
    }

    deliveriesToSync.push({
      delivery,
      itemName,
      patientName: resolvedPatientName,
      patientId: resolvedPatient?.id || (isValidEntityId(delivery.patient_id) ? delivery.patient_id : null),
      amountCents,
      locationId: activeConfig.square_location_id,
      existingCatalogItem: catalogItem,
    });
  }

  const uniqueItemIdsToDelete = Array.from(new Set(itemsToDelete.filter(Boolean)));
  const deleteResult = uniqueItemIdsToDelete.length ? await deleteCatalogObjects(uniqueItemIdsToDelete, accessToken) : { deleted: [], failed: [] };

  for (const transactionId of Array.from(new Set(transactionsToCancel.filter(Boolean)))) {
    await base44.asServiceRole.entities.SquareTransaction.update(transactionId, { status: 'cancelled' });
  }
  for (const transactionId of Array.from(new Set(transactionsToComplete.filter(Boolean)))) {
    await base44.asServiceRole.entities.SquareTransaction.update(transactionId, { status: 'completed' });
  }

  let createdCount = 0;
  let updatedPendingCount = 0;

  for (const entry of deliveriesToSync) {
    const { delivery, itemName, patientName, patientId, amountCents, locationId, existingCatalogItem } = entry;
    const signature = buildItemSignature(itemName, amountCents);
    let catalogItem = existingCatalogItem || catalogBySignature.get(signature) || null;

    if (!catalogItem?.id) {
      catalogItem = await createCatalogItem({ itemName, amountCents, locationId, deliveryId: delivery.id, patientName, accessToken });
      if (!catalogItem?.id) throw new Error(`Square did not return a catalog item for delivery ${delivery.id}`);
      catalogBySignature.set(signature, catalogItem);
      catalogByDateLocationAmount.set(buildLocationDateAmountSignature(locationId, delivery.delivery_date, amountCents), catalogItem);
      createdCount += 1;
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
      square_catalog_object_id: catalogItem.id,
      square_catalog_version: catalogItem.version || null,
    };

    if (existingPending) {
      await base44.asServiceRole.entities.SquareTransaction.update(existingPending.id, transactionPayload);
      updatedPendingCount += 1;
    } else {
      await base44.asServiceRole.entities.SquareTransaction.create(transactionPayload);
    }
  }

  const allTransactionsAfterSync = await base44.asServiceRole.entities.SquareTransaction.list('-updated_date', 2000);
  const transactionsToRemoveFromCatalog = (allTransactionsAfterSync || [])
    .filter((transaction) => transaction?.square_catalog_object_id)
    .filter((transaction) => transaction?.status && transaction.status !== 'pending');
  const extraCatalogIdsToDelete = Array.from(new Set(transactionsToRemoveFromCatalog.map((transaction) => transaction.square_catalog_object_id).filter(Boolean)))
    .filter((catalogId) => !deleteResult.deleted.includes(catalogId));
  const extraDeleteResult = extraCatalogIdsToDelete.length ? await deleteCatalogObjects(extraCatalogIdsToDelete, accessToken) : { deleted: [], failed: [] };

  const staleTransactions = (allTransactionsAfterSync || []).filter((transaction) => {
    const transactionTime = new Date(transaction?.created_date || transaction?.updated_date || 0).getTime();
    return Number.isFinite(transactionTime) && transactionTime < transactionRetentionStartMs;
  });

  for (const transaction of staleTransactions) {
    await base44.asServiceRole.entities.SquareTransaction.delete(transaction.id);
  }

  const staleIds = new Set(staleTransactions.map((transaction) => transaction.id));
  const syncedCatalogTransactions = (allTransactionsAfterSync || [])
    .filter((transaction) => !staleIds.has(transaction.id))
    .filter((transaction) => transaction?.square_catalog_object_id)
    .filter((transaction) => transaction?.status === 'pending')
    .filter((transaction) => {
      const delivery = deliveryById.get(transaction.delivery_id);
      return isRecentDelivery(delivery?.delivery_date || transaction?.item_name);
    });
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
        delivery_date: delivery?.delivery_date || toIsoDate(transaction.item_name),
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
    deleted_catalog_items: deleteResult.deleted.length + extraDeleteResult.deleted.length,
    cancelled_transactions: Array.from(new Set(transactionsToCancel.filter(Boolean))).length,
    completed_transactions: Array.from(new Set(transactionsToComplete.filter(Boolean))).length,
    created_catalog_items: createdCount,
    updated_pending_transactions: updatedPendingCount,
    pruned_transactions: staleTransactions.length,
    synced_square_catalog_items: syncedCatalogTransactions.length,
  };
}

async function handleSyncOnlineSquareEntities(base44, payload) {
  const catalogRecords = Array.isArray(payload?.catalogRecords) ? payload.catalogRecords : [];
  const transactionRecords = Array.isArray(payload?.transactionRecords) ? payload.transactionRecords : [];

  const existingCatalogRecords = await base44.asServiceRole.entities.SquareCatalogItems.list('-updated_date', 5000).catch(() => []);
  const existingTransactions = await base44.asServiceRole.entities.SquareTransaction.list('-updated_date', 5000).catch(() => []);

  await Promise.all([
    ...existingCatalogRecords.map((record) => base44.asServiceRole.entities.SquareCatalogItems.delete(record.id).catch(() => null)),
    ...existingTransactions.map((record) => base44.asServiceRole.entities.SquareTransaction.delete(record.id).catch(() => null)),
  ]);

  if (catalogRecords.length > 0) {
    await base44.asServiceRole.entities.SquareCatalogItems.bulkCreate(catalogRecords);
  }

  if (transactionRecords.length > 0) {
    await base44.asServiceRole.entities.SquareTransaction.bulkCreate(transactionRecords);
  }

  return {
    success: true,
    processed: catalogRecords.length + transactionRecords.length,
    catalogCount: catalogRecords.length,
    transactionCount: transactionRecords.length,
  };
}

async function handleSyncSquareCods(base44, payload) {
  const event = payload?.event;
  if (event?.entity_name === 'Delivery') {
    const delivery = payload?.data || await base44.asServiceRole.entities.Delivery.get(event.entity_id).catch(() => null);
    if (!delivery || Number(delivery?.cod_total_amount_required || 0) <= 0) {
      return { success: true, processed: 0, results: [{ deliveryId: event?.entity_id, action: 'noop', status: 'skipped' }] };
    }

    try {
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
    } catch (error) {
      return { success: false, processed: 1, results: [{ deliveryId: delivery.id, action: delivery.status === 'pending' || delivery.status === 'failed' || delivery.status === 'cancelled' ? 'delete' : 'upsert', status: 'error', error: error?.message || 'Square COD sync failed' }] };
    }
  }

  const items = Array.isArray(payload?.items) ? payload.items : [];
  const deletions = Array.isArray(payload?.deletions) ? payload.deletions : [];
  const purgeCatalogFirst = payload?.purgeCatalogFirst === true;

  if (!items.length && !deletions.length && !purgeCatalogFirst) {
    return await handleSyncCatalogItems(base44);
  }

  const results = [];

  if (purgeCatalogFirst) {
    const accessToken = ensureSquareToken();
    const allCatalogItems = await listActiveCatalogItems(accessToken);
    const allCatalogIds = Array.from(new Set((allCatalogItems || []).map((item) => item?.id).filter(Boolean)));
    const purgeDeleteResult = allCatalogIds.length ? await deleteCatalogObjects(allCatalogIds, accessToken) : { deleted: [], failed: [] };

    const existingCatalogRecords = await base44.asServiceRole.entities.SquareCatalogItems.list('-updated_date', 2000).catch(() => []);
    await Promise.all((existingCatalogRecords || []).map((record) => base44.asServiceRole.entities.SquareCatalogItems.delete(record.id).catch(() => null)));

    const existingTransactions = await base44.asServiceRole.entities.SquareTransaction.list('-updated_date', 2000).catch(() => []);
    await Promise.all(
      (existingTransactions || [])
        .filter((transaction) => transaction?.status === 'pending')
        .map((transaction) =>
          base44.asServiceRole.entities.SquareTransaction.update(transaction.id, {
            status: 'cancelled',
            raw_square_data: {
              ...(transaction.raw_square_data || {}),
              deleted_at: new Date().toISOString(),
              deleted_reason: 'purge_catalog_before_sync',
            },
          }).catch(() => null)
        )
    );

    results.push({ action: 'purge', status: 'ok', result: { deletedCatalogItems: purgeDeleteResult.deleted.length } });
  }

  for (const deletion of deletions) {
    try {
      const result = await handleDeleteCodItem(base44, {
        deliveryId: deletion?.deliveryId,
        catalogObjectId: deletion?.catalogObjectId,
        transactionId: deletion?.transactionId,
        reason: deletion?.status === 'failed' ? 'failed' : deletion?.reason,
      });
      results.push({ deliveryId: deletion?.deliveryId, action: 'delete', status: 'ok', result });
    } catch (error) {
      results.push({ deliveryId: deletion?.deliveryId, action: 'delete', status: 'error', error: error?.message || 'Delete failed' });
    }
  }

  for (const item of items) {
    try {
      const result = await handleCreateCodItem(base44, {
        deliveryId: item?.deliveryId,
        patientName: item?.patientName,
        storeAbbreviation: item?.storeAbbreviation,
        codAmount: item?.codAmount,
        deliveryDate: item?.deliveryDate,
        storeId: item?.storeId,
      });
      results.push({ deliveryId: item?.deliveryId, action: 'upsert', status: result?.skipped ? 'skipped' : 'ok', result });
    } catch (error) {
      results.push({ deliveryId: item?.deliveryId, action: 'upsert', status: 'error', error: error?.message || 'Upsert failed' });
    }
  }

  return { success: !results.some((entry) => entry.status === 'error'), processed: results.length, results };
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
      return Response.json(await handleFetchPayments(base44, payload));
    }
    if (action === 'getCodData') {
      return Response.json(await handleGetCodData(base44, payload));
    }
    if (action === 'recordPayment') {
      return Response.json(await handleRecordPayment(base44, payload));
    }
    if (action === 'syncCatalogItems') {
      await requireAdminIfAuthenticated(base44);
      return Response.json(await handleSyncCatalogItems(base44));
    }
    if (action === 'syncOnlineSquareEntities') {
      await requireAdminIfAuthenticated(base44);
      return Response.json(await handleSyncOnlineSquareEntities(base44, payload));
    }
    if (action === 'syncSquareCods') {
      await requireAdminIfAuthenticated(base44);
      return Response.json(await handleSyncSquareCods(base44, payload));
    }

    throw new HttpError(400, 'Missing or invalid action');
  } catch (error) {
    const status = error?.status || 500;
    return Response.json({ error: error?.message || 'Internal Server Error' }, { status });
  }
});