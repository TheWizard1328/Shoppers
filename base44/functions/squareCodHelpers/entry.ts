// squareCodHelpers — shared utilities imported by squareCodCore
// Redeployed on 2026-05-18

export const SQUARE_BASE_URL = 'https://connect.squareup.com';
export const SQUARE_VERSION = '2025-01-23';
export const TRANSACTION_RETENTION_DAYS = 90;
export const MATCH_DATE_OFFSET_DAYS = 2;
export const SQUARE_API_MAX_RETRIES = 3;
export const SQUARE_RETRY_BASE_DELAY_MS = 400;
export const SQUARE_REQUEST_SPACING_MS = 350;
export const SQUARE_BATCH_PAUSE_MS = 1200;
export const SQUARE_BATCH_SIZE = 4;
export const DELIVERY_BULK_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
export const MAX_TRANSACTION_ORDERS = 2000;
export const BASE44_SYNC_CHUNK_DELAY_MS = 300;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function normalizeText(value) {
  return String(value || '').trim();
}

export function unwrapEntityRecord(record) {
  if (!record || typeof record !== 'object') return null;
  if (record.data && typeof record.data === 'object') {
    return { ...record.data, id: record.data.id || record.id, created_date: record.data.created_date || record.created_date, updated_date: record.data.updated_date || record.updated_date };
  }
  return record;
}

export function isValidEntityId(value) {
  return /^[a-f0-9]{24}$/i.test(String(value || ''));
}

export function toAmountCents(value) {
  return Math.max(0, Math.round(Number(value || 0)));
}

export function formatItemName(deliveryDate, storeAbbreviation, patientName) {
  const [, month, day] = String(deliveryDate || '').split('-');
  const mm = month?.padStart(2, '0') || '00';
  const dd = day?.padStart(2, '0') || '00';
  return `${mm}/${dd}(${normalizeText(storeAbbreviation) || 'NA'})-${normalizeText(patientName) || 'Unknown Patient'}`;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isRetryableSquareStatus(status) {
  return [408, 409, 429, 500, 502, 503, 504].includes(Number(status));
}

export function extractCatalogMonthDay(value) {
  const normalized = normalizeText(value);
  const isoMatch = normalized.match(/^\d{4}-(\d{2})-(\d{2})$/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}`;
  const prefix = normalized.slice(0, 5);
  const itemMatch = prefix.match(/^(\d{2})\/(\d{2})$/);
  if (itemMatch) return `${itemMatch[1]}-${itemMatch[2]}`;
  return '';
}

export function parseDateValue(value, referenceDate = new Date()) {
  const normalized = normalizeText(value);
  const isoMatch = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) return new Date(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3]));
  const monthDayKey = extractCatalogMonthDay(normalized);
  if (!monthDayKey) return null;
  const [month, day] = monthDayKey.split('-').map(Number);
  const referenceLocal = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate());
  const candidates = [referenceLocal.getFullYear() - 1, referenceLocal.getFullYear(), referenceLocal.getFullYear() + 1].map((year) => new Date(year, month - 1, day));
  return candidates.sort((a, b) => Math.abs(a.getTime() - referenceLocal.getTime()) - Math.abs(b.getTime() - referenceLocal.getTime()))[0] || null;
}

export function getMonthDayKey(value, referenceDate = new Date()) {
  const parsed = parseDateValue(value, referenceDate);
  if (!parsed || Number.isNaN(parsed.getTime())) return '';
  return `${String(parsed.getMonth() + 1).padStart(2, '0')}-${String(parsed.getDate()).padStart(2, '0')}`;
}

export function buildLocationDateAmountSignature(locationId, dateValue, amountCents, referenceDate = new Date()) {
  return `${normalizeText(locationId)}::${getMonthDayKey(dateValue, referenceDate) || 'unknown-date'}::${toAmountCents(amountCents)}`;
}

export function buildLocationDateAmountSignatureCandidates(locationId, dateValue, amountCents, offsetDays = MATCH_DATE_OFFSET_DAYS, referenceDate = new Date()) {
  const parsed = parseDateValue(dateValue, referenceDate);
  if (!parsed || Number.isNaN(parsed.getTime())) return [buildLocationDateAmountSignature(locationId, dateValue, amountCents, referenceDate)];
  const signatures = [];
  for (let offset = -offsetDays; offset <= offsetDays; offset += 1) {
    const candidate = new Date(parsed.getTime() + offset * 24 * 60 * 60 * 1000);
    signatures.push(`${normalizeText(locationId)}::${String(candidate.getMonth() + 1).padStart(2, '0')}-${String(candidate.getDate()).padStart(2, '0')}::${toAmountCents(amountCents)}`);
  }
  return Array.from(new Set(signatures));
}

export function getLookbackStartAt(daysBack) {
  return new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();
}

export function getTransactionRetentionStartMs() {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const cutoff = new Date(today); cutoff.setDate(cutoff.getDate() - TRANSACTION_RETENTION_DAYS);
  return cutoff.getTime();
}

export function formatLocalDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function shouldRefreshDeliveries(lastRefreshedAt, forceRefresh = false) {
  if (forceRefresh) return true;
  const refreshedAtMs = new Date(lastRefreshedAt || 0).getTime();
  if (!Number.isFinite(refreshedAtMs) || refreshedAtMs <= 0) return true;
  return Date.now() - refreshedAtMs >= DELIVERY_BULK_REFRESH_INTERVAL_MS;
}

export function hasCollectedCardPayment(delivery) {
  return (Array.isArray(delivery?.cod_payments) ? delivery.cod_payments : []).some((p) => ['Debit', 'Credit'].includes(p?.type) && Number(p?.amount || 0) > 0);
}

export function isOfflineCollectedPaymentMethod(paymentMethod) {
  return ['cash', 'check', 'other'].includes(String(paymentMethod || '').toLowerCase());
}

export function hasCollectedOfflinePayment(delivery) {
  return (Array.isArray(delivery?.cod_payments) ? delivery.cod_payments : []).some((p) => isOfflineCollectedPaymentMethod(p?.type) && Number(p?.amount || 0) > 0);
}

export function buildPlaceholderItemNames(deliveryDate, storeAbbreviation) {
  const [, month, day] = String(deliveryDate || '').split('-');
  const mm = month?.padStart(2, '0') || '00'; const dd = day?.padStart(2, '0') || '00'; const abbr = storeAbbreviation || 'NA';
  return [`${mm}/${dd}(${abbr})-COD`, `${mm}/${dd}(${abbr})-Unknown Patient`, `${mm}-${dd}(${abbr})-COD`, `${mm}-${dd}(${abbr})-Unknown Patient`];
}

export function buildItemSignature(itemName, amountCents) {
  return `${normalizeText(itemName)}::${toAmountCents(amountCents)}`;
}

export function normalizeMatchName(value) {
  return normalizeText(value).replace(/\s+/g, ' ').replace(/\s-\s\$\d+(?:\.\d{2})?$/, '').replace(/^(\d{2})-(\d{2})/, '$1/$2').toLowerCase();
}

export function tokenizeName(value) {
  return normalizeMatchName(value).replace(/[^a-z0-9\s]/g, ' ').split(' ').map((p) => p.trim()).filter((p) => p.length >= 2);
}

export function levenshteinDistance(a, b) {
  const l = String(a || ''); const r = String(b || '');
  if (!l) return r.length; if (!r) return l.length;
  const m = Array.from({ length: l.length + 1 }, () => Array(r.length + 1).fill(0));
  for (let i = 0; i <= l.length; i++) m[i][0] = i;
  for (let j = 0; j <= r.length; j++) m[0][j] = j;
  for (let i = 1; i <= l.length; i++) for (let j = 1; j <= r.length; j++) { const c = l[i-1] === r[j-1] ? 0 : 1; m[i][j] = Math.min(m[i-1][j]+1, m[i][j-1]+1, m[i-1][j-1]+c); }
  return m[l.length][r.length];
}

export function notesContainPatientName(notesValue, patientName) {
  const nn = normalizeMatchName(notesValue).replace(/[^a-z0-9\s]/g, ' ');
  const np = normalizeMatchName(patientName).replace(/[^a-z0-9\s]/g, ' ');
  if (!nn || !np) return false;
  if (nn.includes(np)) return true;
  const pt = tokenizeName(np); const nt = tokenizeName(nn);
  if (!pt.length || !nt.length) return false;
  if (pt.every((t) => nt.some((n) => n.includes(t) || t.includes(n)))) return true;
  const overlap = pt.filter((t) => nt.some((n) => n.includes(t) || t.includes(n))).length;
  if (pt.length >= 2 && overlap >= Math.min(2, pt.length)) return true;
  return pt.every((t) => nt.some((n) => { const d = levenshteinDistance(t, n); return Math.max(t.length, n.length) >= 4 && d <= 1; }));
}

export function getStoreAbbreviationVariants(store) {
  const variants = new Set();
  const push = (v) => { const n = normalizeText(v); if (!n) return; variants.add(n.toLowerCase()); n.split(/[^a-zA-Z0-9]+/).map((p) => p.trim().toLowerCase()).filter(Boolean).forEach((p) => variants.add(p)); };
  push(store?.abbreviation); push(store?.name);
  return Array.from(variants);
}

export function getPreferredStoreAbbreviation(store) {
  const n = normalizeText(store?.abbreviation); if (n) return n.toUpperCase();
  const tokens = normalizeText(store?.name).split(/[^a-zA-Z0-9]+/).map((p) => p.trim()).filter(Boolean);
  if (!tokens.length) return 'NA'; if (tokens.length === 1) return tokens[0].slice(0, 2).toUpperCase();
  return tokens.map((t) => t[0]).join('').slice(0, 2).toUpperCase();
}

export function itemNameContainsStore(itemName, store) {
  const n = normalizeMatchName(itemName); if (!n) return false;
  return getStoreAbbreviationVariants(store).some((v) => n.includes(v));
}

export function buildComparableLocationSignature(itemName, amountCents, locationId) {
  return `${normalizeText(locationId)}::${normalizeMatchName(itemName)}::${toAmountCents(amountCents)}`;
}

export function shouldIgnoreManualOrderLabel(value) {
  const n = normalizeMatchName(value);
  return n === 'top ups' || n === 'top up' || n === 'topup' || n === 'tip' || n === 'top';
}

export function getCatalogItemAmountCents(item) {
  const variations = item?.item_data?.variations || [];
  const variation = variations.find((e) => e?.item_variation_data?.price_money?.amount != null) || variations[0];
  return toAmountCents(variation?.item_variation_data?.price_money?.amount);
}

export function getCatalogItemLocationIds(item) {
  return Array.from(new Set([...(item?.present_at_location_ids || []), ...(item?.item_data?.variations || []).flatMap((v) => v?.present_at_location_ids || [])].filter(Boolean)));
}

export function isCatalogItemAtLocation(item, locationId) {
  if (!item || !locationId) return false;
  if (item?.present_at_all_locations) return true;
  return getCatalogItemLocationIds(item).includes(locationId);
}

export function toIsoDate(value) {
  const parsed = parseDateValue(value);
  if (!parsed || Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

export function mapSquareOrderStateToTransactionStatus(orderState) {
  if (orderState === 'COMPLETED') return 'completed';
  return 'pending';
}

export function flattenOrderItems(orders) {
  const items = [];
  for (const order of orders || []) {
    for (const lineItem of order?.line_items || []) {
      const itemName = normalizeText(lineItem?.name || lineItem?.note);
      if (!itemName || shouldIgnoreManualOrderLabel(itemName)) continue;
      const qty = Math.round(Number(lineItem?.quantity || 1)) || 1;
      const explicitUnit = toAmountCents(lineItem?.base_price_money?.amount);
      const gross = toAmountCents(lineItem?.gross_sales_money?.amount || lineItem?.total_money?.amount);
      const amountCents = explicitUnit || (qty > 0 ? Math.round(gross / qty) : gross);
      const transactionStatus = mapSquareOrderStateToTransactionStatus(order?.state);
      for (let i = 0; i < qty; i++) {
        items.push({ order_id: order?.id, line_item_uid: lineItem?.uid || `${order?.id}-${lineItem?.catalog_object_id || itemName}-${i}`, location_id: order?.location_id || null, item_name: itemName, amount_cents: amountCents, catalog_object_id: lineItem?.catalog_object_id || null, payment_date: order?.created_at || null, order_created_at: order?.created_at || null, note: order?.note || '', order_state: order?.state || null, transaction_status: transactionStatus });
      }
    }
  }
  return items;
}

export function ensureSquareToken() {
  const t = Deno.env.get('SQUARE_ACCESS_TOKEN');
  if (!t) throw new HttpError(500, 'Square credentials not configured');
  return t;
}

export async function requireUser(base44) {
  const user = await base44.auth.me().catch(() => null);
  if (!user) throw new HttpError(401, 'Unauthorized');
  return user;
}

export async function requireAdminIfAuthenticated(base44) {
  const isAuthenticated = await base44.auth.isAuthenticated().catch(() => false);
  if (!isAuthenticated) return null;
  const user = await base44.auth.me().catch(() => null);
  if (user?.role !== 'admin') throw new HttpError(403, 'Forbidden: Admin access required');
  return user;
}

export async function squareFetch(path, method, accessToken, body, options = {}) {
  const { monitor, queue } = options;
  let lastError = null;
  for (let attempt = 1; attempt <= SQUARE_API_MAX_RETRIES; attempt++) {
    try {
      const doFetch = () => fetch(`${SQUARE_BASE_URL}${path}`, { method, headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'Square-Version': SQUARE_VERSION }, body: body ? JSON.stringify(body) : undefined });
      const response = await (queue ? queue.run(path, doFetch) : doFetch());
      const responseText = await response.text();
      const json = responseText ? JSON.parse(responseText) : {};
      if (!response.ok) {
        const message = json?.errors?.map((e) => e.detail).join(', ') || `Square API error ${response.status}`;
        lastError = new HttpError(response.status, message);
        if (attempt < SQUARE_API_MAX_RETRIES && isRetryableSquareStatus(response.status)) {
          if (monitor) { monitor.state.retryCount++; if (response.status === 429) monitor.state.rateLimitHits++; }
          await sleep(SQUARE_RETRY_BASE_DELAY_MS * attempt); continue;
        }
        throw lastError;
      }
      return json;
    } catch (error) {
      lastError = error;
      if (attempt < SQUARE_API_MAX_RETRIES) { if (monitor) monitor.state.retryCount++; await sleep(SQUARE_RETRY_BASE_DELAY_MS * attempt); continue; }
      if (monitor) monitor.state.errorCount++;
      throw lastError;
    }
  }
  throw lastError || new Error('Square API request failed');
}

export async function safeDeleteSquareCatalogObject(catalogObjectId, accessToken) {
  if (!catalogObjectId) return { attempted: false, ok: false };
  let lastFailure = null;
  for (let attempt = 1; attempt <= SQUARE_API_MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(`${SQUARE_BASE_URL}/v2/catalog/object/${catalogObjectId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}`, 'Square-Version': SQUARE_VERSION } });
      const responseText = await response.text();
      let body = null; try { body = responseText ? JSON.parse(responseText) : null; } catch { body = responseText || null; }
      if (response.ok || response.status === 404) return { attempted: true, ok: true, status: response.status, body };
      lastFailure = { attempted: true, ok: false, status: response.status, body };
      if (attempt < SQUARE_API_MAX_RETRIES && isRetryableSquareStatus(response.status)) { await sleep(SQUARE_RETRY_BASE_DELAY_MS * attempt); continue; }
      return lastFailure;
    } catch (error) {
      lastFailure = { attempted: true, ok: false, error: error?.message || String(error) };
      if (attempt < SQUARE_API_MAX_RETRIES) { await sleep(SQUARE_RETRY_BASE_DELAY_MS * attempt); continue; }
      return lastFailure;
    }
  }
  return lastFailure || { attempted: true, ok: false, error: 'Delete failed' };
}

export async function deleteCatalogObjects(objectIds, accessToken) {
  if (!objectIds.length) return { deleted: [], failed: [] };
  try {
    await squareFetch('/v2/catalog/batch-delete', 'POST', accessToken, { object_ids: objectIds });
    return { deleted: objectIds, failed: [] };
  } catch {
    const deleted = []; const failed = [];
    for (const id of objectIds) { const r = await safeDeleteSquareCatalogObject(id, accessToken); if (r?.ok) deleted.push(id); else failed.push({ objectId: id, result: r }); }
    if (failed.length) throw new Error(`Failed to delete Square catalog items: ${failed.map((e) => e.objectId).join(', ')}`);
    return { deleted, failed: [] };
  }
}

export async function createCatalogItem({ itemName, amountCents, locationId, deliveryId, patientName, accessToken }) {
  const json = await squareFetch('/v2/catalog/batch-upsert', 'POST', accessToken, {
    idempotency_key: crypto.randomUUID(),
    batches: [{ objects: [{ type: 'ITEM', id: `#item-${deliveryId}`, present_at_all_locations: false, present_at_location_ids: [locationId], item_data: { name: itemName, description: `COD for ${patientName || 'patient'} | Delivery ${deliveryId}`, is_taxable: true, product_type: 'REGULAR', variations: [{ type: 'ITEM_VARIATION', id: `#variation-${deliveryId}`, present_at_all_locations: false, present_at_location_ids: [locationId], item_variation_data: { name: 'Default', pricing_type: 'FIXED_PRICING', price_money: { amount: amountCents, currency: 'CAD' }, sellable: true, stockable: true } }] } }] }],
  });
  return (json.objects || []).find((o) => o.type === 'ITEM') || null;
}

// Updates an existing Square catalog item's name and/or price in-place
export async function updateCatalogItem({ catalogObjectId, catalogVersion, itemName, amountCents, locationId, deliveryId, patientName, accessToken }) {
  const existingJson = await squareFetch(`/v2/catalog/object/${catalogObjectId}`, 'GET', accessToken, null).catch(() => null);
  const existingItem = existingJson?.object;
  if (!existingItem) return createCatalogItem({ itemName, amountCents, locationId, deliveryId, patientName, accessToken });

  const existingVariations = existingItem?.item_data?.variations || [];
  const updatedVariations = existingVariations.length > 0
    ? existingVariations.map((v) => ({ type: 'ITEM_VARIATION', id: v.id, version: v.version, present_at_all_locations: false, present_at_location_ids: [locationId], item_variation_data: { ...v.item_variation_data, name: 'Default', pricing_type: 'FIXED_PRICING', price_money: { amount: amountCents, currency: 'CAD' } } }))
    : [{ type: 'ITEM_VARIATION', id: `#variation-${deliveryId}`, present_at_all_locations: false, present_at_location_ids: [locationId], item_variation_data: { name: 'Default', pricing_type: 'FIXED_PRICING', price_money: { amount: amountCents, currency: 'CAD' }, sellable: true, stockable: true } }];

  const json = await squareFetch('/v2/catalog/batch-upsert', 'POST', accessToken, {
    idempotency_key: crypto.randomUUID(),
    batches: [{ objects: [{ type: 'ITEM', id: catalogObjectId, version: catalogVersion || existingItem.version, present_at_all_locations: false, present_at_location_ids: [locationId], item_data: { name: itemName, description: `COD for ${patientName || 'patient'} | Delivery ${deliveryId}`, is_taxable: true, product_type: 'REGULAR', variations: updatedVariations } }] }],
  });
  return (json.objects || []).find((o) => o.type === 'ITEM') || null;
}

export async function listActiveCatalogItems(accessToken, options = {}) {
  const objects = []; let cursor; let page = 0;
  do {
    page++;
    const json = await squareFetch('/v2/catalog/search', 'POST', accessToken, { object_types: ['ITEM'], include_deleted_objects: false, archived_state: 'ARCHIVED_STATE_NOT_ARCHIVED', cursor }, options);
    objects.push(...(json.objects || [])); cursor = json.cursor;
    if (cursor) await sleep(SQUARE_BATCH_PAUSE_MS);
  } while (cursor);
  return objects;
}

export async function listOrders(locationIds, startAt, accessToken, maxOrders = 1000, states = ['COMPLETED', 'OPEN'], options = {}) {
  if (!locationIds.length) return [];
  const orders = []; let cursor = null;
  do {
    const json = await squareFetch('/v2/orders/search', 'POST', accessToken, { location_ids: locationIds, cursor, limit: 500, query: { filter: { state_filter: { states }, date_time_filter: { created_at: { start_at: startAt } } }, sort: { sort_field: 'CREATED_AT', sort_order: 'DESC' } } }, options);
    orders.push(...(json.orders || [])); cursor = json.cursor || null;
    if (cursor && orders.length < maxOrders) await sleep(SQUARE_BATCH_PAUSE_MS);
  } while (cursor && orders.length < maxOrders);
  return orders.slice(0, maxOrders);
}

export async function resolveDeliveryPatient(base44, delivery, patientById, patientByPid) {
  const rawRef = normalizeText(delivery?.patient_id); if (!rawRef) return null;
  const mapped = patientById.get(rawRef) || patientByPid.get(rawRef); if (mapped) return mapped;
  if (isValidEntityId(rawRef)) {
    const p = await base44.asServiceRole.entities.Patient.get(rawRef).catch(() => null);
    if (p) { patientById.set(p.id, p); const pid = normalizeText(p.patient_id); if (pid) patientByPid.set(pid, p); return p; }
  }
  const matches = await base44.asServiceRole.entities.Patient.filter({ patient_id: rawRef }, '-updated_date', 1).catch(() => []);
  const p = Array.isArray(matches) ? matches[0] : null;
  if (p) { patientById.set(p.id, p); const pid = normalizeText(p.patient_id); if (pid) patientByPid.set(pid, p); return p; }
  return null;
}

export async function resolveDeliveryPatientName(base44, delivery, patientById, patientByPid) {
  const patient = await resolveDeliveryPatient(base44, delivery, patientById, patientByPid);
  return normalizeText(patient?.full_name || delivery?.patient_name) || 'Unknown Patient';
}

export async function getStoreSquareContext(base44, effectiveStoreId) {
  if (!effectiveStoreId) throw new HttpError(400, 'Store ID is required for Square COD item creation');
  const store = await base44.asServiceRole.entities.Store.get(effectiveStoreId).catch(() => null);
  if (!store) throw new HttpError(400, `Store not found with ID: ${effectiveStoreId}`);
  if (!store.square_location_config_id) throw new HttpError(400, `Store "${store.name}" is not configured for Square COD payments.`);
  const config = await base44.asServiceRole.entities.SquareLocationConfig.get(store.square_location_config_id).catch(() => null);
  if (!config) throw new HttpError(400, `Square location config not found for store "${store.name}"`);
  if (config.status !== 'active') throw new HttpError(400, `Square location "${config.name}" is inactive for store "${store.name}"`);
  return { store, config, locationId: config.square_location_id };
}

export async function buildPatientMaps(base44, deliveries) {
  const refs = Array.from(new Set((deliveries || []).map((d) => normalizeText(d?.patient_id)).filter(Boolean)));
  const entityIds = refs.filter((id) => isValidEntityId(id));
  const pidStrings = refs.filter((id) => !isValidEntityId(id));
  const [byEntityId, byPid] = await Promise.all([
    entityIds.length ? base44.asServiceRole.entities.Patient.filter({ id: { $in: entityIds } }) : [],
    pidStrings.length ? base44.asServiceRole.entities.Patient.filter({ patient_id: { $in: pidStrings } }) : [],
  ]);
  const patients = [...(byEntityId || []), ...((byPid || []).filter((p) => !(byEntityId || []).some((e) => e.id === p.id)))];
  return {
    patientById: new Map(patients.map((p) => [p.id, p])),
    patientByPid: new Map(patients.map((p) => [normalizeText(p?.patient_id), p]).filter(([id]) => id)),
  };
}

export function createSquareSyncMonitor(base44, syncName = 'square_sync') {
  const state = { runId: null, requestCount: 0, retryCount: 0, rateLimitHits: 0, errorCount: 0 };
  const writeLog = async (level, step, message, details = {}) => {
    console.log(`[SquareSync][${level}] ${step}: ${message}`, JSON.stringify(details));
    await base44.asServiceRole.entities.SquareSyncLog.create({ sync_run_id: state.runId, level, step, message, details, logged_at: new Date().toISOString() }).catch(() => null);
  };
  return {
    state,
    async start(meta = {}) { const run = await base44.asServiceRole.entities.SquareSyncHealth.create({ sync_name: syncName, status: 'running', started_at: new Date().toISOString(), request_count: 0, retry_count: 0, rate_limit_hits: 0, error_count: 0, summary: 'Sync started', meta }).catch(() => null); state.runId = run?.id || null; await writeLog('info', 'start', 'Square sync started', meta); },
    async finish(status, summary, meta = {}) { if (state.runId) await base44.asServiceRole.entities.SquareSyncHealth.update(state.runId, { status, finished_at: new Date().toISOString(), request_count: state.requestCount, retry_count: state.retryCount, rate_limit_hits: state.rateLimitHits, error_count: state.errorCount, summary, meta }).catch(() => null); await writeLog(status === 'error' ? 'error' : status === 'warning' ? 'warn' : 'info', 'finish', summary, meta); },
    async log(level, step, message, details = {}) { await writeLog(level, step, message, details); },
  };
}

export function createSquareRequestQueue(monitor) {
  let counter = 0;
  return {
    async run(step, task) {
      const idx = counter++;
      if (idx > 0) await sleep(SQUARE_REQUEST_SPACING_MS);
      if (idx > 0 && idx % SQUARE_BATCH_SIZE === 0) await sleep(SQUARE_BATCH_PAUSE_MS);
      monitor.state.requestCount++;
      return task();
    },
  };
}

export async function paginatedDeleteAll(entityApi, pageSize = 50) {
  while (true) {
    const records = await entityApi.list('-updated_date', pageSize).catch(() => []);
    if (!records?.length) break;
    for (let i = 0; i < records.length; i += 5) { const chunk = records.slice(i, i + 5); await Promise.all(chunk.map((r) => entityApi.delete(r.id).catch(() => null))); if (i + 5 < records.length) await sleep(BASE44_SYNC_CHUNK_DELAY_MS * 4); }
    if (records.length < pageSize) break;
    await sleep(BASE44_SYNC_CHUNK_DELAY_MS * 4);
  }
}