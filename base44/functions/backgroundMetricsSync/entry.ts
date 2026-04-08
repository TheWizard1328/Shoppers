import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

const SUMMARY_VERSION = '2';
const LIVE_SYNC_WINDOW_DAYS = 7;
const BATCH_LIMIT = 1000;

const isNotFoundError = (error) => error?.status === 404 || error?.response?.status === 404 || String(error?.message || '').toLowerCase().includes('not found');
const toDateOnly = (date) => date.toISOString().split('T')[0];
const getTodayDateString = () => toDateOnly(new Date());
const getLiveWindowStart = () => {
  const date = new Date();
  date.setDate(date.getDate() - (LIVE_SYNC_WINDOW_DAYS - 1));
  return toDateOnly(date);
};
const getMonthDateRange = (year, month) => {
  const paddedMonth = String(month).padStart(2, '0');
  const start = `${year}-${paddedMonth}-01`;
  const endDate = new Date(Date.UTC(year, month, 0));
  const end = `${year}-${paddedMonth}-${String(endDate.getUTCDate()).padStart(2, '0')}`;
  return { start, end };
};
const dedupeById = (records) => {
  const map = new Map();
  (records || []).forEach((record) => {
    if (record?.id) map.set(record.id, record);
  });
  return Array.from(map.values());
};
const getMidpointDate = (startStr, endStr) => {
  const start = new Date(`${startStr}T00:00:00`);
  const end = new Date(`${endStr}T00:00:00`);
  const midpoint = new Date(start.getTime() + Math.floor((end.getTime() - start.getTime()) / 2));
  return midpoint.toISOString().split('T')[0];
};
const getNextDate = (dateStr) => {
  const date = new Date(`${dateStr}T00:00:00`);
  date.setDate(date.getDate() + 1);
  return date.toISOString().split('T')[0];
};
const fetchDateRangeRecords = async (entityApi, dateField, startStr, endStr, sort = '-created_date') => {
  const records = await entityApi.filter({ [dateField]: { $gte: startStr, $lte: endStr } }, sort, BATCH_LIMIT);
  if (!Array.isArray(records)) return [];
  if (records.length < BATCH_LIMIT || startStr === endStr) return records;
  const midpoint = getMidpointDate(startStr, endStr);
  if (midpoint <= startStr || midpoint >= endStr) return records;
  const leftRecords = await fetchDateRangeRecords(entityApi, dateField, startStr, midpoint, sort);
  const rightRecords = await fetchDateRangeRecords(entityApi, dateField, getNextDate(midpoint), endStr, sort);
  return dedupeById([...leftRecords, ...rightRecords]);
};
const buildMonthlyDeliveryCounts = (deliveries = []) => {
  const counts = { total_deliveries: deliveries.length, completed_or_failed_deliveries: 0, after_hours_pickups: 0, by_store: {}, by_driver: {} };
  deliveries.forEach((delivery) => {
    if (!delivery) return;
    if (delivery.status === 'completed' || delivery.status === 'failed') counts.completed_or_failed_deliveries++;
    if (delivery.after_hours_pickup && (delivery.status === 'completed' || delivery.status === 'cancelled')) counts.after_hours_pickups++;
    if (delivery.store_id) counts.by_store[delivery.store_id] = (counts.by_store[delivery.store_id] || 0) + 1;
    if (delivery.driver_id) counts.by_driver[delivery.driver_id] = (counts.by_driver[delivery.driver_id] || 0) + 1;
  });
  return counts;
};
const getNewestUpdatedAt = (records = []) => {
  let newest = null;
  records.forEach((record) => {
    const value = record?.updated_date || record?.created_date;
    if (value && (!newest || value > newest)) newest = value;
  });
  return newest;
};
const countSummaryNeedsRefresh = (summaryRecord, deliveries) => {
  if (!summaryRecord) return true;
  if (summaryRecord.summary_version !== SUMMARY_VERSION) return true;
  return JSON.stringify(summaryRecord.delivery_counts || {}) !== JSON.stringify(buildMonthlyDeliveryCounts(deliveries))
    || (summaryRecord.last_source_delivery_updated_at || null) !== (getNewestUpdatedAt(deliveries) || null);
};

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const appUserList = await base44.asServiceRole.entities.AppUser.filter({ user_id: user.id }).catch((error) => {
      if (isNotFoundError(error)) return [];
      throw error;
    });
    const appUser = appUserList[0];
    const appRoles = appUser?.app_roles || [];
    if (user.role !== 'admin' && !appRoles.includes('admin')) {
      return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
    }

    let body = {};
    try {
      const text = await req.text();
      if (text) body = JSON.parse(text);
    } catch (_) {}

    const year = Number(body.year || new Date().getFullYear());
    const cityId = body.cityId || 'all';
    const currentMonth = Number(body.month || (new Date().getMonth() + 1));
    const liveWindowStart = getLiveWindowStart();
    const liveWindowEnd = getTodayDateString();
    const monthRange = getMonthDateRange(year, currentMonth);

    let cityStoreIds = null;
    if (cityId !== 'all') {
      const cityStores = await base44.asServiceRole.entities.Store.filter({ city_id: cityId }, '', 5000);
      cityStoreIds = new Set((cityStores || []).map((store) => store.id));
    }

    let deliveries = await fetchDateRangeRecords(base44.asServiceRole.entities.Delivery, 'delivery_date', monthRange.start, liveWindowEnd, '-delivery_date');
    deliveries = dedupeById(deliveries || []);
    if (cityStoreIds) deliveries = deliveries.filter((delivery) => cityStoreIds.has(delivery.store_id));

    const summaryRecords = await base44.asServiceRole.entities.AdminMetricsSummary.filter({ year, month: currentMonth, city_id: cityId }, '', 10).catch((error) => {
      if (isNotFoundError(error)) return [];
      throw error;
    });
    const summaryRecord = summaryRecords?.[0] || null;
    const needsRefresh = countSummaryNeedsRefresh(summaryRecord, deliveries);

    return Response.json({
      success: true,
      year,
      cityId,
      month: currentMonth,
      liveWindowDays: LIVE_SYNC_WINDOW_DAYS,
      liveWindowStart,
      liveWindowEnd,
      needsRefresh,
      deliveryCountSnapshot: buildMonthlyDeliveryCounts(deliveries),
      lastSourceDeliveryUpdatedAt: getNewestUpdatedAt(deliveries),
      summaryId: summaryRecord?.id || null,
      summaryCalculatedAt: summaryRecord?.calculated_at || null
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});