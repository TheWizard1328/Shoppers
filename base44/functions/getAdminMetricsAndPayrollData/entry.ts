// Redeployed on 2026-03-28
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

const isNotFoundError = (error) => error?.status === 404 || error?.response?.status === 404 || String(error?.message || '').toLowerCase().includes('not found');

const CACHE_VERSION = '4';
const SUMMARY_VERSION = '3';
const LIVE_SYNC_WINDOW_DAYS = 7;
const statsCache = new Map();
const CACHE_DISABLED = false;
const SERVER_CACHE_TTL_MS = 5 * 60 * 1000;
const BATCH_LIMIT = 1000;

const pickFields = (record, fields) => {
  const picked = {};
  fields.forEach((field) => {
    picked[field] = record?.[field];
  });
  return picked;
};

const dedupeById = (records) => {
  const recordMap = new Map();
  (records || []).forEach((record) => {
    if (record?.id) recordMap.set(record.id, record);
  });
  return Array.from(recordMap.values());
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

const fetchDateRangeRecords = async (entityApi, dateField, startStr, endStr, sort = '-created_date', extraFilter = {}) => {
  const records = await entityApi.filter({
    ...extraFilter,
    [dateField]: { $gte: startStr, $lte: endStr }
  }, sort, BATCH_LIMIT);

  if (!Array.isArray(records)) return [];
  if (records.length < BATCH_LIMIT || startStr === endStr) return records;

  const midpoint = getMidpointDate(startStr, endStr);
  if (midpoint <= startStr || midpoint >= endStr) return records;

  const leftRecords = await fetchDateRangeRecords(entityApi, dateField, startStr, midpoint, sort, extraFilter);
  const rightRecords = await fetchDateRangeRecords(entityApi, dateField, getNextDate(midpoint), endStr, sort, extraFilter);
  return dedupeById([...leftRecords, ...rightRecords]);
};

const DELIVERY_FIELDS = [
  'id',
  'delivery_date',
  'driver_id',
  'store_id',
  'patient_id',
  'status',
  'after_hours_pickup',
  'paid_km_override',
  'travel_dist',
  'oversized',
  'no_charge',
  'patient_name',
  'address',
  'delivery_notes',
  'actual_delivery_time'
];

const isCompletedStatus = (delivery) => delivery?.status === 'completed';
const isFailedStatus = (delivery) => delivery?.status === 'failed';
const isCancelledStatus = (delivery) => delivery?.status === 'cancelled';
const isAfterHoursPickupDelivery = (delivery) => delivery?.after_hours_pickup === true;
const isPatientOrTransferDelivery = (delivery) => !!delivery?.patient_id;
const isReturnDelivery = (delivery) => String(delivery?.patient_name || '').toUpperCase().includes('(RTN)');
const isInterStoreDelivery = (delivery) => {
  const haystack = [delivery?.patient_name, delivery?.address, delivery?.delivery_notes]
    .map((value) => String(value || '').toUpperCase())
    .join(' ');
  return haystack.includes('INTERSTORE') || haystack.includes('(ISD)') || haystack.includes('(ISP)');
};
const isStandardOrInterStoreDelivery = (delivery) => isPatientOrTransferDelivery(delivery) || isInterStoreDelivery(delivery);
const isRegularPickupDelivery = (delivery) => !isAfterHoursPickupDelivery(delivery) && !isStandardOrInterStoreDelivery(delivery);

const isDriverPayableDelivery = (delivery) => {
  if (!delivery) return false;
  if (isAfterHoursPickupDelivery(delivery)) {
    return isCompletedStatus(delivery) || isCancelledStatus(delivery);
  }
  if (isStandardOrInterStoreDelivery(delivery)) {
    return isCompletedStatus(delivery) || isFailedStatus(delivery);
  }
  return false;
};

const isAdminBillableDelivery = (delivery, storePaysFees) => {
  if (!storePaysFees) return false;
  return isDriverPayableDelivery(delivery);
};

const isAdminNonBillableDelivery = (delivery, storePaysFees) => {
  if (storePaysFees) return false;
  return isDriverPayableDelivery(delivery);
};

const isAppFeePayableDelivery = (delivery) => isDriverPayableDelivery(delivery);

const STORE_FIELDS = [
  'id',
  'name',
  'abbreviation',
  'city_id',
  'sort_order',
  'color',
  'status',
  'pays_app_fees',
  'app_fee_history'
];

const DRIVER_FIELDS = [
  'id',
  'user_id',
  'user_name',
  'full_name',
  'app_roles',
  'status',
  'city_id',
  'sort_order',
  'pay_cycle_type',
  'pay_rate_per_delivery',
  'extra_km_rate',
  'extra_km_limit',
  'oversized_item_rate',
  'gst_hst_enabled',
  'deductions'
];

const PATIENT_FIELDS = ['id', 'full_name', 'distance_from_store', 'address'];
const CITY_FIELDS = ['id', 'name', 'sort_order', 'province_state'];

const getMonthDateRange = (year, month) => {
  const paddedMonth = String(month).padStart(2, '0');
  const start = `${year}-${paddedMonth}-01`;
  const endDate = new Date(Date.UTC(year, month, 0));
  const end = `${year}-${paddedMonth}-${String(endDate.getUTCDate()).padStart(2, '0')}`;
  return { start, end };
};

const getMonthKey = (year, month) => `${year}-${String(month).padStart(2, '0')}`;

const normalizePageMonths = (pageMonths = []) => {
  const uniqueMonths = [...new Set((pageMonths || []).map((month) => Number(month)).filter((month) => month >= 1 && month <= 12))];
  return uniqueMonths.sort((a, b) => a - b);
};

const getPageDateRange = (year, pageMonths = []) => {
  const normalizedMonths = normalizePageMonths(pageMonths);
  if (!normalizedMonths.length) return null;
  const firstRange = getMonthDateRange(year, normalizedMonths[0]);
  const lastRange = getMonthDateRange(year, normalizedMonths[normalizedMonths.length - 1]);
  return { start: firstRange.start, end: lastRange.end, months: normalizedMonths };
};

const toDateOnly = (date) => date.toISOString().split('T')[0];

const getTodayDateString = () => toDateOnly(new Date());

const getLiveWindowStart = () => {
  const date = new Date();
  date.setDate(date.getDate() - (LIVE_SYNC_WINDOW_DAYS - 1));
  return toDateOnly(date);
};

const isCurrentMonth = (year, month) => {
  const now = new Date();
  return now.getFullYear() === year && now.getMonth() + 1 === month;
};

const mergeMetrics = (baseMetrics, incomingMetrics) => {
  if (!baseMetrics) return incomingMetrics;
  if (!incomingMetrics) return baseMetrics;

  const merged = {
  ...baseMetrics,
  monthlyData: Array(12).fill(null).map((_, index) => {
  const billable = (baseMetrics.monthlyData?.[index]?.billable || 0) + (incomingMetrics.monthlyData?.[index]?.billable || 0);
  const nonBillable = (baseMetrics.monthlyData?.[index]?.nonBillable || 0) + (incomingMetrics.monthlyData?.[index]?.nonBillable || 0);
  return {
    month: baseMetrics.monthlyData?.[index]?.month || incomingMetrics.monthlyData?.[index]?.month || MONTH_NAMES[index],
    billable,
    nonBillable,
    total: billable + nonBillable
  };
  }),
    yearTotals: {
      billable: (baseMetrics.yearTotals?.billable || 0) + (incomingMetrics.yearTotals?.billable || 0),
      nonBillable: (baseMetrics.yearTotals?.nonBillable || 0) + (incomingMetrics.yearTotals?.nonBillable || 0),
      activeDrivers: Math.max(baseMetrics.yearTotals?.activeDrivers || 0, incomingMetrics.yearTotals?.activeDrivers || 0)
    },
    storeDataByMonth: {},
    driverDataByMonth: {},
    driverDataByStore: {},
    dailyDriverData: {},
    storeData: [],
    driverData: [],
    dailyDeliveryData: {},
    dailyStoreData: {},
    monthlyStoreData: {},
    storeFeeTotals: {
      total_fees_owed: (baseMetrics.storeFeeTotals?.total_fees_owed || 0) + (incomingMetrics.storeFeeTotals?.total_fees_owed || 0),
      app_fee_rate: incomingMetrics.storeFeeTotals?.app_fee_rate || baseMetrics.storeFeeTotals?.app_fee_rate || 0,
      stores_paying_fees: Math.max(baseMetrics.storeFeeTotals?.stores_paying_fees || 0, incomingMetrics.storeFeeTotals?.stores_paying_fees || 0),
      total_stores: Math.max(baseMetrics.storeFeeTotals?.total_stores || 0, incomingMetrics.storeFeeTotals?.total_stores || 0),
      active_stores: Math.max(baseMetrics.storeFeeTotals?.active_stores || 0, incomingMetrics.storeFeeTotals?.active_stores || 0),
      total_billable_while_paying: (baseMetrics.storeFeeTotals?.total_billable_while_paying || 0) + (incomingMetrics.storeFeeTotals?.total_billable_while_paying || 0),
      monthlyFees: Array(12).fill(0).map((_, index) => (baseMetrics.storeFeeTotals?.monthlyFees?.[index] || 0) + (incomingMetrics.storeFeeTotals?.monthlyFees?.[index] || 0))
    },
    entityCounts: incomingMetrics.entityCounts || baseMetrics.entityCounts || {}
  };

  const mergeArrayByKey = (first = [], second = [], key) => {
    const map = new Map();
    [...first, ...second].forEach((item) => {
      if (!item?.[key]) return;
      const existing = map.get(item[key]);
      if (!existing) {
        map.set(item[key], { ...item });
        return;
      }
      const mergedItem = { ...existing, ...item };
      ['completed', 'failed', 'afterHours', 'cancelled', 'fees', 'billable', 'nonBillable', 'extra_km', 'total', 'totalCompleted', 'totalFailed'].forEach((field) => {
        if (existing[field] != null || item[field] != null) {
          mergedItem[field] = (existing[field] || 0) + (item[field] || 0);
        }
      });
      map.set(item[key], mergedItem);
    });
    return Array.from(map.values());
  };

  for (let month = 1; month <= 12; month++) {
    merged.storeDataByMonth[month] = mergeArrayByKey(baseMetrics.storeDataByMonth?.[month], incomingMetrics.storeDataByMonth?.[month], 'storeId');
    merged.driverDataByMonth[month] = mergeArrayByKey(baseMetrics.driverDataByMonth?.[month], incomingMetrics.driverDataByMonth?.[month], 'driverId');
    merged.monthlyStoreData[month] = mergeArrayByKey(baseMetrics.monthlyStoreData?.[month], incomingMetrics.monthlyStoreData?.[month], 'storeId');
    merged.dailyDeliveryData[month] = mergeArrayByKey(baseMetrics.dailyDeliveryData?.[month], incomingMetrics.dailyDeliveryData?.[month], 'day');

    const baseDailyStore = baseMetrics.dailyStoreData?.[month] || {};
    const incomingDailyStore = incomingMetrics.dailyStoreData?.[month] || {};
    const mergedDailyStore = {};
    [...new Set([...Object.keys(baseDailyStore), ...Object.keys(incomingDailyStore)])].forEach((storeId) => {
      mergedDailyStore[storeId] = mergeArrayByKey(baseDailyStore[storeId], incomingDailyStore[storeId], 'day');
    });
    merged.dailyStoreData[month] = mergedDailyStore;

    const baseDailyDriver = baseMetrics.dailyDriverData?.[month] || {};
    const incomingDailyDriver = incomingMetrics.dailyDriverData?.[month] || {};
    const mergedDailyDriver = {};
    [...new Set([...Object.keys(baseDailyDriver), ...Object.keys(incomingDailyDriver)])].forEach((driverId) => {
      mergedDailyDriver[driverId] = mergeArrayByKey(baseDailyDriver[driverId], incomingDailyDriver[driverId], 'day');
    });
    merged.dailyDriverData[month] = mergedDailyDriver;
  }

  merged.storeData = mergeArrayByKey(baseMetrics.storeData, incomingMetrics.storeData, 'storeId');
  merged.driverData = mergeArrayByKey(baseMetrics.driverData, incomingMetrics.driverData, 'driverId');

  return merged;
};

const mergeEnvelopeMetrics = (baseEnvelopeMetrics, incomingEnvelopeMetrics) => {
  if (!baseEnvelopeMetrics) return incomingEnvelopeMetrics;
  if (!incomingEnvelopeMetrics) return baseEnvelopeMetrics;

  const merged = {
    byStoreAndMonth: {},
    yearTotals: {
      envelopeDeliveriesCount: (baseEnvelopeMetrics.yearTotals?.envelopeDeliveriesCount || 0) + (incomingEnvelopeMetrics.yearTotals?.envelopeDeliveriesCount || 0),
      totalEnvelopeValue: (baseEnvelopeMetrics.yearTotals?.totalEnvelopeValue || 0) + (incomingEnvelopeMetrics.yearTotals?.totalEnvelopeValue || 0),
      adjustedDeliveries: (baseEnvelopeMetrics.yearTotals?.adjustedDeliveries || 0) + (incomingEnvelopeMetrics.yearTotals?.adjustedDeliveries || 0),
      actualDeliveries: (baseEnvelopeMetrics.yearTotals?.actualDeliveries || 0) + (incomingEnvelopeMetrics.yearTotals?.actualDeliveries || 0)
    }
  };

  [...new Set([...Object.keys(baseEnvelopeMetrics.byStoreAndMonth || {}), ...Object.keys(incomingEnvelopeMetrics.byStoreAndMonth || {})])].forEach((storeId) => {
    merged.byStoreAndMonth[storeId] = {};
    [...new Set([...Object.keys(baseEnvelopeMetrics.byStoreAndMonth?.[storeId] || {}), ...Object.keys(incomingEnvelopeMetrics.byStoreAndMonth?.[storeId] || {})])].forEach((month) => {
      const baseMonth = baseEnvelopeMetrics.byStoreAndMonth?.[storeId]?.[month] || {};
      const incomingMonth = incomingEnvelopeMetrics.byStoreAndMonth?.[storeId]?.[month] || {};
      merged.byStoreAndMonth[storeId][month] = {
        envelopeDeliveriesCount: (baseMonth.envelopeDeliveriesCount || 0) + (incomingMonth.envelopeDeliveriesCount || 0),
        totalEnvelopeValue: (baseMonth.totalEnvelopeValue || 0) + (incomingMonth.totalEnvelopeValue || 0),
        actualDeliveries: (baseMonth.actualDeliveries || 0) + (incomingMonth.actualDeliveries || 0),
        adjustedDeliveries: (baseMonth.adjustedDeliveries || 0) + (incomingMonth.adjustedDeliveries || 0)
      };
    });
  });

  return merged;
};

const negateDailyMetricEntries = (entries = []) => {
  return (entries || []).map((entry) => ({
    ...entry,
    completed: -(entry?.completed || 0),
    failed: -(entry?.failed || 0),
    afterHours: -(entry?.afterHours || 0),
    cancelled: -(entry?.cancelled || 0),
    billable: -(entry?.billable || 0),
    nonBillable: -(entry?.nonBillable || 0),
    extra_km: -(entry?.extra_km || 0),
    total: -(entry?.total || 0),
    totalCompleted: -(entry?.totalCompleted || 0),
    totalFailed: -(entry?.totalFailed || 0)
  }));
};

const subtractWindowFromMonthMetrics = (monthMetrics, windowMetrics, month) => {
  if (!monthMetrics) return monthMetrics;
  if (!windowMetrics) return monthMetrics;

  const negativeDailyStoreData = {};
  Object.entries(windowMetrics.dailyStoreData?.[month] || {}).forEach(([storeId, entries]) => {
    negativeDailyStoreData[storeId] = negateDailyMetricEntries(entries);
  });

  const negativeDailyDriverData = {};
  Object.entries(windowMetrics.dailyDriverData?.[month] || {}).forEach(([driverId, entries]) => {
    negativeDailyDriverData[driverId] = negateDailyMetricEntries(entries);
  });

  const mergedNegative = mergeMetrics(monthMetrics, {
    ...windowMetrics,
    monthlyData: Array(12).fill(null).map((_, index) => {
      const item = windowMetrics.monthlyData?.[index] || { month: MONTH_NAMES[index], billable: 0, nonBillable: 0, total: 0 };
      return {
        month: item.month,
        billable: index === month - 1 ? -(item.billable || 0) : 0,
        nonBillable: index === month - 1 ? -(item.nonBillable || 0) : 0,
        total: index === month - 1 ? -(item.total || 0) : 0
      };
    }),
    yearTotals: {
      billable: -(windowMetrics.yearTotals?.billable || 0),
      nonBillable: -(windowMetrics.yearTotals?.nonBillable || 0),
      activeDrivers: monthMetrics.yearTotals?.activeDrivers || 0
    },
    dailyStoreData: {
      [month]: negativeDailyStoreData
    },
    dailyDriverData: {
      [month]: negativeDailyDriverData
    },
    storeFeeTotals: {
      ...(windowMetrics.storeFeeTotals || {}),
      total_fees_owed: -(windowMetrics.storeFeeTotals?.total_fees_owed || 0),
      total_billable_while_paying: -(windowMetrics.storeFeeTotals?.total_billable_while_paying || 0),
      monthlyFees: Array(12).fill(0).map((_, index) => index === month - 1 ? -(windowMetrics.storeFeeTotals?.monthlyFees?.[index] || 0) : 0)
    }
  });

  return mergedNegative;
};

const buildMonthlyDeliveryCounts = (deliveries = []) => {
  const counts = {
    total_deliveries: deliveries.length,
    completed_or_failed_deliveries: 0,
    after_hours_pickups: 0,
    driver_payable_deliveries: 0,
    billable_deliveries: 0,
    non_billable_deliveries: 0,
    regular_pickups: 0,
    by_store: {},
    by_driver: {}
  };

  deliveries.forEach((delivery) => {
    if (!delivery) return;
    const storePaysFees = false;
    const isDriverPayable = isDriverPayableDelivery(delivery);
    const isBillable = isAdminBillableDelivery(delivery, storePaysFees);
    const isNonBillable = isAdminNonBillableDelivery(delivery, storePaysFees);
    const isRegularPickup = isRegularPickupDelivery(delivery);

    if (delivery.patient_id && (delivery.status === 'completed' || delivery.status === 'failed')) {
      counts.completed_or_failed_deliveries++;
    }
    if (delivery.after_hours_pickup && (delivery.status === 'completed' || delivery.status === 'cancelled')) {
      counts.after_hours_pickups++;
    }
    if (isDriverPayable) counts.driver_payable_deliveries++;
    if (isBillable) counts.billable_deliveries++;
    if (isNonBillable) counts.non_billable_deliveries++;
    if (isRegularPickup) counts.regular_pickups++;
    if (delivery.store_id) {
      counts.by_store[delivery.store_id] = (counts.by_store[delivery.store_id] || 0) + 1;
    }
    if (delivery.driver_id) {
      counts.by_driver[delivery.driver_id] = (counts.by_driver[delivery.driver_id] || 0) + 1;
    }
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

  const latestUpdatedAt = getNewestUpdatedAt(deliveries);
  const currentCounts = buildMonthlyDeliveryCounts(deliveries);
  const savedCounts = summaryRecord.delivery_counts || {};

  return JSON.stringify(savedCounts) !== JSON.stringify(currentCounts)
    || (summaryRecord.last_source_delivery_updated_at || null) !== (latestUpdatedAt || null);
};

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);

    let user;
    try {
      user = await base44.auth.me();
    } catch (authError) {
      return Response.json({ error: 'Authentication failed: ' + authError.message }, { status: 401 });
    }
    if (!user) return Response.json({ error: 'Forbidden: Authentication required' }, { status: 403 });

    const appUserList = await base44.asServiceRole.entities.AppUser.filter({ user_id: user.id }).catch((error) => {
      if (isNotFoundError(error)) return [];
      throw error;
    });
    const appUser = appUserList[0];
    const appRoles = appUser?.app_roles || [];
    if (user.role !== 'admin' && !appRoles.includes('admin') && !appRoles.includes('driver')) {
      return Response.json({ error: 'Forbidden: Access denied' }, { status: 403 });
    }

    let body = {};
    try {
      const text = await req.text();
      if (text) body = JSON.parse(text);
    } catch (_) {}

    const {
      adminMetricsYear, adminMetricsCityId,
      payrollYear, payrollCityId,
      payrollPageMonths = [],
      payrollPaginationMode = 'full_year',
      forceRefreshCurrentYear = false,
      refreshCurrentMonthSummary = false
    } = body;

    const isInvalidCitySelection = (value) => value == null || value === '' || value === 'all';

    if (adminMetricsYear && isInvalidCitySelection(adminMetricsCityId)) {
      return Response.json({ error: 'City selection is required for admin metrics.' }, { status: 400 });
    }

    if (payrollYear && isInvalidCitySelection(payrollCityId)) {
      return Response.json({ error: 'City selection is required for payroll.' }, { status: 400 });
    }

    const normalizedCityId = adminMetricsCityId;

    const fetchMonthlySummaryRecord = async (year, month, cityId) => {
      const summaryRecords = await base44.asServiceRole.entities.AdminMetricsSummary.filter({ year, month, city_id: cityId }, '', 10).catch((error) => {
        if (isNotFoundError(error)) return [];
        throw error;
      });
      return summaryRecords?.[0] || null;
    };

    const fetchYearSummaryRecords = async (year, cityId) => {
      const summaryRecords = await base44.asServiceRole.entities.AdminMetricsSummary.filter({ year, city_id: cityId }, '', 100).catch((error) => {
        if (isNotFoundError(error)) return [];
        throw error;
      });
      return dedupeById(summaryRecords || []);
    };

    const upsertMonthlySummaryRecord = async ({ year, month, cityId, cityName, adminMetrics, payrollMetrics, deliveries }) => {
      const existingRecord = await fetchMonthlySummaryRecord(year, month, cityId);
      const { start, end } = getMonthDateRange(year, month);
      const payload = {
        city_id: cityId,
        city_name: cityName || '',
        year,
        month,
        period_start: start,
        period_end: end,
        summary_version: SUMMARY_VERSION,
        delivery_counts: buildMonthlyDeliveryCounts(deliveries),
        admin_metrics: adminMetrics,
        payroll_metrics: payrollMetrics,
        last_source_delivery_updated_at: getNewestUpdatedAt(deliveries),
        calculated_at: new Date().toISOString()
      };

      if (existingRecord?.id) {
        return await base44.asServiceRole.entities.AdminMetricsSummary.update(existingRecord.id, payload);
      }
      return await base44.asServiceRole.entities.AdminMetricsSummary.create(payload);
    };

    const fetchYearData = async (year, cityId, options = {}) => {
      const cacheKey = `${CACHE_VERSION}_${year}_${cityId || 'all'}_${options.startDate || 'full'}_${options.endDate || 'full'}_${options.includePayroll ? 'payroll' : 'admin'}`;
      const cached = statsCache.get(cacheKey);
      if (!CACHE_DISABLED && cached && (Date.now() - cached.timestamp < SERVER_CACHE_TTL_MS)) {
        return cached.data;
      }

      let cityStoreIds = null;
      let cityStores = [];
      let deliveryFilter = {};
      if (cityId && cityId !== 'all') {
        cityStores = await base44.asServiceRole.entities.Store.filter({ city_id: cityId }, '', 5000);
        cityStoreIds = new Set((cityStores || []).map((store) => store.id));
        const cityStoreIdsArray = Array.from(cityStoreIds);
        if (!cityStoreIdsArray.length) {
          const [appSettingsForEmpty, allCitiesRaw] = await Promise.all([
            base44.asServiceRole.entities.AppSettings.filter({ setting_key: 'refresh_intervals' }),
            base44.asServiceRole.entities.City.list('', 500).catch((error) => {
              if (isNotFoundError(error)) return [];
              throw error;
            })
          ]);
          const emptyData = {
            deliveries: [],
            stores: [],
            appUsers: [],
            patients: [],
            cities: (allCitiesRaw || []).map((city) => pickFields(city, CITY_FIELDS)),
            cityName: '',
            appFeeRate: parseFloat(appSettingsForEmpty?.[0]?.setting_value?.app_fees_per_delivery) || 0,
            payrollRecords: []
          };
          statsCache.set(cacheKey, { data: emptyData, timestamp: Date.now() });
          return emptyData;
        }
        deliveryFilter = { store_id: { $in: cityStoreIdsArray } };
      }

      const yearStart = options.startDate || `${year}-01-01`;
      const yearEnd = options.endDate || `${year}-12-31`;

      const [appSettings, allYearDeliveriesRaw, allYearPayrollRaw] = await Promise.all([
        base44.asServiceRole.entities.AppSettings.filter({ setting_key: 'refresh_intervals' }),
        fetchDateRangeRecords(base44.asServiceRole.entities.Delivery, 'delivery_date', yearStart, yearEnd, '-delivery_date', deliveryFilter),
        options.includePayroll ? fetchDateRangeRecords(base44.asServiceRole.entities.Payroll, 'pay_period_start', yearStart, yearEnd, '-pay_period_start') : Promise.resolve([])
      ]);

      const deliveries = dedupeById(allYearDeliveriesRaw || []);

      const relevantStoreIds = Array.from(new Set(deliveries.map((delivery) => delivery.store_id).filter(Boolean)));
      const relevantDriverIds = Array.from(new Set(deliveries.map((delivery) => delivery.driver_id).filter(Boolean)));

      const relevantPatientIds = Array.from(new Set(deliveries.map((delivery) => delivery.patient_id).filter(Boolean)));

      const [storesRaw, appUsersRaw, patientsRaw] = await Promise.all([
        relevantStoreIds.length
          ? (cityStores.length ? cityStores.filter((store) => relevantStoreIds.includes(store.id)) : base44.asServiceRole.entities.Store.filter({ id: { $in: relevantStoreIds } }, '', 5000))
          : (cityStores.length ? cityStores : []),
        base44.asServiceRole.entities.AppUser.list('', 5000),
        relevantPatientIds.length
          ? base44.asServiceRole.entities.Patient.filter({ id: { $in: relevantPatientIds } }, '', 5000)
          : Promise.resolve([])
      ]);

      const stores = (storesRaw || []).map((store) => pickFields(store, STORE_FIELDS));

      const payrollDriverIds = dedupeById(allYearPayrollRaw || []).map((record) => record?.driver_id).filter(Boolean);
      const driverIdsToKeep = new Set([...relevantDriverIds, ...payrollDriverIds]);
      const appUsers = (appUsersRaw || [])
        .filter((appUserRecord) => driverIdsToKeep.size === 0 || driverIdsToKeep.has(appUserRecord.user_id))
        .map((appUserRecord) => pickFields(appUserRecord, DRIVER_FIELDS));

      const patients = (patientsRaw || []).map((patient) => pickFields(patient, PATIENT_FIELDS));

      const relevantCityIds = Array.from(new Set(stores.map((store) => store.city_id).filter(Boolean)));
      const citiesRaw = await base44.asServiceRole.entities.City.list('', 500).catch((error) => {
        if (isNotFoundError(error)) return [];
        throw error;
      });
      const cities = (citiesRaw || []).map((city) => pickFields(city, CITY_FIELDS));
      const cityName = cityId && cityId !== 'all'
        ? (cities.find((city) => city.id === cityId)?.name || '')
        : 'All Cities';

      const payrollRecords = dedupeById(allYearPayrollRaw || []);
      const appFeeRate = parseFloat(appSettings?.[0]?.setting_value?.app_fees_per_delivery) || 0;

      const data = {
        deliveries: deliveries.map((delivery) => pickFields(delivery, DELIVERY_FIELDS)),
        stores,
        appUsers,
        patients,
        cities,
        cityName,
        appFeeRate,
        payrollRecords
      };

      statsCache.set(cacheKey, { data, timestamp: Date.now() });
      return data;
    };

    const buildPayrollData = (yearData) => {
      const drivers = yearData.appUsers.filter((appUserRecord) => appUserRecord.app_roles && appUserRecord.app_roles.includes('driver'));

      const driverStats = {};
      drivers.forEach((driver) => {
        driverStats[driver.user_id] = {
          total_deliveries: 0,
          total_after_hours_pickups: 0
        };
      });

      const storeStats = {};
      yearData.stores.forEach((store) => {
        storeStats[store.id] = {
          total_deliveries: 0,
          total_after_hours_pickups: 0
        };
      });

      const patientMap = new Map((yearData.patients || []).map((patient) => [patient?.id, patient]));

      yearData.deliveries.forEach((delivery) => {
        if (!delivery || !delivery.delivery_date || !delivery.store_id) return;

        const isPayrollPayable = isDriverPayableDelivery(delivery);
        const isPayrollAfterHours = isAdminNonBillableDelivery(delivery);

        if (delivery.driver_id) {
          if (isPayrollPayable) {
            driverStats[delivery.driver_id] = driverStats[delivery.driver_id] || { total_deliveries: 0, total_after_hours_pickups: 0 };
            driverStats[delivery.driver_id].total_deliveries++;
          }
          if (isPayrollAfterHours) {
            driverStats[delivery.driver_id] = driverStats[delivery.driver_id] || { total_deliveries: 0, total_after_hours_pickups: 0 };
            driverStats[delivery.driver_id].total_after_hours_pickups++;
          }
        }

        if (storeStats[delivery.store_id]) {
          if (isPayrollPayable) {
            storeStats[delivery.store_id].total_deliveries++;
          }
          if (isPayrollAfterHours) {
            storeStats[delivery.store_id].total_after_hours_pickups++;
          }
        }
      });

      return {
        deliveries: yearData.deliveries,
        patients: yearData.patients,
        appUsers: yearData.appUsers,
        drivers,
        stores: yearData.stores,
        cities: yearData.cities,
        payrollRecords: yearData.payrollRecords,
        driverStats,
        storeStats,
        totals: {
          deliveries: yearData.deliveries.length,
          drivers: drivers.length,
          stores: yearData.stores.length
        }
      };
    };

    const buildSummaryBackfill = async (year, cityId, options = {}) => {
      const yearData = await fetchYearData(year, cityId, { includePayroll: !!options.includePayroll });
      const summaryRecords = [];
      const currentMonthNumber = new Date().getMonth() + 1;

      for (let month = 1; month <= 12; month++) {
        if (options.refreshCurrentMonthOnly && year === new Date().getFullYear() && month !== currentMonthNumber) continue;
        const { start, end } = getMonthDateRange(year, month);
        const monthDeliveries = (yearData.deliveries || []).filter((delivery) => delivery?.delivery_date >= start && delivery?.delivery_date <= end);
        if (!monthDeliveries.length) continue;

        const existingSummary = await fetchMonthlySummaryRecord(year, month, cityId);
        if (!options.force && !countSummaryNeedsRefresh(existingSummary, monthDeliveries)) {
          summaryRecords.push(existingSummary);
          continue;
        }

        const monthPayrollRecords = (yearData.payrollRecords || []).filter((record) => record?.pay_period_start >= start && record?.pay_period_start <= end);
        const monthData = {
          ...yearData,
          deliveries: monthDeliveries,
          payrollRecords: monthPayrollRecords
        };

        const adminMetricsForMonth = processAdminMetrics(
          monthData.deliveries,
          monthData.stores,
          monthData.appUsers,
          monthData.patients,
          year,
          monthData.appFeeRate
        );
        adminMetricsForMonth.envelopeMetrics = calculateEnvelopeMetrics(monthData.deliveries, monthData.stores);

        const payrollMetricsForMonth = buildPayrollData(monthData);

        const savedRecord = await upsertMonthlySummaryRecord({
          year,
          month,
          cityId,
          cityName: yearData.cityName,
          adminMetrics: adminMetricsForMonth,
          payrollMetrics: payrollMetricsForMonth,
          deliveries: monthDeliveries
        });
        summaryRecords.push(savedRecord);
      }

      return { yearData, summaryRecords };
    };

    const composeMetricsFromSummaries = (summaryRecords = []) => {
      let mergedAdminMetrics = null;
      let mergedPayrollMetrics = null;

      summaryRecords
        .slice()
        .sort((a, b) => (a.month || 0) - (b.month || 0))
        .forEach((record) => {
          mergedAdminMetrics = mergeMetrics(mergedAdminMetrics, record.admin_metrics || null);
          mergedPayrollMetrics = mergedPayrollMetrics ? mergeMetrics(mergedPayrollMetrics, record.payroll_metrics || null) : (record.payroll_metrics || mergedPayrollMetrics);
          if (mergedAdminMetrics) {
            mergedAdminMetrics.envelopeMetrics = mergeEnvelopeMetrics(mergedAdminMetrics.envelopeMetrics, record.admin_metrics?.envelopeMetrics || null);
          }
        });

      return { adminMetrics: mergedAdminMetrics, payrollData: mergedPayrollMetrics };
    };

    let adminMetrics = null;
    let adminMetricsMeta = null;
    if (adminMetricsYear) {
      const currentYear = new Date().getFullYear();
      let summaryRecords = await fetchYearSummaryRecords(adminMetricsYear, normalizedCityId);

      if (!summaryRecords.length || summaryRecords.length < 12 || (forceRefreshCurrentYear && adminMetricsYear === currentYear)) {
        const backfill = await buildSummaryBackfill(adminMetricsYear, normalizedCityId, {
          force: forceRefreshCurrentYear === true,
          includePayroll: false,
          refreshCurrentMonthOnly: false
        });
        summaryRecords = backfill.summaryRecords;
      }

      const composed = composeMetricsFromSummaries(summaryRecords);
      adminMetrics = composed.adminMetrics;
      adminMetricsMeta = {
        liveWindowApplied: false,
        liveWindowDays: LIVE_SYNC_WINDOW_DAYS,
        currentMonthSynced: summaryRecords.length > 0,
        source: 'summary'
      };
    }

    let payrollData = null;
    let payrollPagination = null;
    if (payrollYear) {
      const normalizedPayrollCityId = payrollCityId;
      const shouldPaginatePayroll = payrollPaginationMode === 'paged';
      const pageRange = shouldPaginatePayroll ? getPageDateRange(payrollYear, payrollPageMonths) : null;
      const yearData = await fetchYearData(payrollYear, normalizedPayrollCityId, {
        includePayroll: true,
        startDate: pageRange?.start,
        endDate: pageRange?.end
      });
      payrollData = buildPayrollData(yearData);
      payrollPagination = {
        mode: shouldPaginatePayroll ? 'paged' : 'full_year',
        requestedMonths: pageRange?.months || [],
        rangeStart: pageRange?.start || `${payrollYear}-01-01`,
        rangeEnd: pageRange?.end || `${payrollYear}-12-31`,
        hasMore: shouldPaginatePayroll ? (pageRange?.months?.[pageRange.months.length - 1] || 12) < 12 : false
      };
    }

    return Response.json({ adminMetrics, adminMetricsMeta, payrollData, payrollPagination });
  } catch (error) {
    console.error('❌ CRITICAL ERROR in getAdminMetricsAndPayrollData:', error);
    const isRateLimit = error?.status === 429 || error?.response?.status === 429 || String(error?.message || '').toLowerCase().includes('rate limit');
    return Response.json(
      { error: isRateLimit ? 'Too many requests right now. Please wait a moment and try again.' : error.message || 'Unknown error occurred' },
      { status: isRateLimit ? 429 : 500 }
    );
  }
});

function processAdminMetrics(deliveries, stores, appUsers, patients, year, appFeeRate) {
  const patientMap = new Map((patients || []).map((patient) => [patient?.id, patient]));

  const calculateExtraKm = (delivery) => {
    if (!delivery || !delivery.patient_id) return 0;
    const driver = appUsers.find(au => au.user_id === delivery.driver_id);
    const extraKmLimit = Number(driver?.extra_km_limit || 0);
    const overrideDistance = Number(delivery.paid_km_override || 0);
    const patientDistance = Number(patientMap.get(delivery.patient_id)?.distance_from_store || 0);
    const baseDistance = overrideDistance > 0 ? overrideDistance : patientDistance;
    const extraKm = baseDistance - extraKmLimit;
    return extraKm > 0 ? extraKm : 0;
  };

  const metrics = {
    monthlyData: Array(12).fill(null).map((_, i) => ({
      month: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][i],
      billable: 0, nonBillable: 0, total: 0
    })),
    yearTotals: { billable: 0, nonBillable: 0, activeDrivers: 0 },
    storeDataByMonth: {},
    driverDataByMonth: {},
    driverDataByStore: {},
    dailyDriverData: {},
    storeData: [],
    driverData: [],
    dailyDeliveryData: {},
    dailyStoreData: {},
    monthlyStoreData: {},
    storeFeeTotals: {
      total_fees_owed: 0,
      app_fee_rate: appFeeRate,
      stores_paying_fees: 0,
      total_stores: stores.length,
      active_stores: stores.filter(s => s.status === 'active').length,
      total_billable_while_paying: 0,
      monthlyFees: Array(12).fill(0)
    },
    entityCounts: {
      patients: patients.length,
      cities: (new Set(stores.map(s => s.city_id))).size,
      stores: stores.length,
      users: appUsers.length
    }
  };

  const storeMap = new Map(stores.map(s => [s.id, s]));
  const appUserMap = new Map(appUsers.map(au => [au.user_id, au]));

  const sortedHistoryCache = new Map();
  const wasPayingFeesOnDate = (store, dateStr) => {
    if (!store) return false;
    if (!store.app_fee_history || store.app_fee_history.length === 0) {
      return store.pays_app_fees || false;
    }
    if (!sortedHistoryCache.has(store.id)) {
      sortedHistoryCache.set(store.id, [...store.app_fee_history].sort((a, b) => a.effective_date.localeCompare(b.effective_date)));
    }
    const sortedHistory = sortedHistoryCache.get(store.id);
    let payingFees = false;
    for (const entry of sortedHistory) {
      if (entry.effective_date <= dateStr) payingFees = entry.pays_app_fees;
      else break;
    }
    return payingFees;
  };

  stores.forEach(s => {
    metrics.storeData.push({
      abbreviation: s.abbreviation, name: s.name, storeId: s.id,
      completed: 0, failed: 0, afterHours: 0, cancelled: 0, fees: 0,
      color: s.color, sortOrder: s.sort_order
    });
  });

  const uniqueDriverMap = new Map();
  appUsers.filter(au => au.app_roles && au.app_roles.includes('driver')).forEach(driver => {
    if (!uniqueDriverMap.has(driver.user_id)) {
      uniqueDriverMap.set(driver.user_id, {
        name: driver.user_name || driver.full_name,
        driverId: driver.user_id, billable: 0, nonBillable: 0
      });
    }
  });
  metrics.driverData = Array.from(uniqueDriverMap.values());

  const isCountableCompletedDelivery = (d) => d?.no_charge !== true && isStandardOrInterStoreDelivery(d) && isCompletedStatus(d);
  const isCountableFailedDelivery = (d) => d?.no_charge !== true && isStandardOrInterStoreDelivery(d) && isFailedStatus(d);
  const isCountableAfterHoursPickup = (d) => d?.no_charge !== true && isAfterHoursPickupDelivery(d) && (isCompletedStatus(d) || isCancelledStatus(d));

  const isBillableDelivery = (d, storePaysFees) => isAdminBillableDelivery(d, storePaysFees);

  const isNonBillableDelivery = (d, storePaysFees) => isAdminNonBillableDelivery(d, storePaysFees);

  const storeMonthlyFees = new Map();
  const storesPayingFeesSet = new Set();

  for (const delivery of deliveries.filter(d => d && d.delivery_date)) {
    const date = new Date(delivery.delivery_date);
    const monthIndex = date.getMonth();
    const dayOfMonth = date.getDate();
    const store = delivery.store_id ? storeMap.get(delivery.store_id) : null;
    const wasPayingOnDeliveryDate = store ? wasPayingFeesOnDate(store, delivery.delivery_date) : false;

    const isDriverPayable = isDriverPayableDelivery(delivery);
    const isBillable = isBillableDelivery(delivery, wasPayingOnDeliveryDate);
    const isNonBillable = isNonBillableDelivery(delivery, wasPayingOnDeliveryDate);
    const countsTowardMonthlySplit = isDriverPayable && delivery.no_charge !== true;

    if (countsTowardMonthlySplit) {
      metrics.monthlyData[monthIndex].total++;
      if (isBillable) {
        metrics.monthlyData[monthIndex].billable++;
        metrics.yearTotals.billable++;
      } else if (isNonBillable) {
        metrics.monthlyData[monthIndex].nonBillable++;
        metrics.yearTotals.nonBillable++;
      }

      if (!metrics.dailyDeliveryData[monthIndex + 1]) metrics.dailyDeliveryData[monthIndex + 1] = [];
      let dailyEntry = metrics.dailyDeliveryData[monthIndex + 1].find(d => d.day === dayOfMonth);
      if (dailyEntry) {
        if (isBillable) dailyEntry.billable++;
        else if (isNonBillable) dailyEntry.nonBillable++;
      } else {
        metrics.dailyDeliveryData[monthIndex + 1].push({ day: dayOfMonth, billable: isBillable ? 1 : 0, nonBillable: isNonBillable ? 1 : 0 });
      }

      if (delivery.driver_id) {
        const driverAppUser = appUserMap.get(delivery.driver_id);
        const driverName = driverAppUser?.user_name || driverAppUser?.full_name || 'Unknown Driver';
        let annualDriverEntry = metrics.driverData.find(d => d.driverId === delivery.driver_id);
        if (!annualDriverEntry) {
          annualDriverEntry = { name: driverName, driverId: delivery.driver_id, billable: 0, nonBillable: 0 };
          metrics.driverData.push(annualDriverEntry);
        }
        if (isBillable) annualDriverEntry.billable++;
        else annualDriverEntry.nonBillable++;

        if (!metrics.driverDataByMonth[monthIndex + 1]) metrics.driverDataByMonth[monthIndex + 1] = [];
        let monthlyDriverEntry = metrics.driverDataByMonth[monthIndex + 1].find(d => d.driverId === delivery.driver_id);
        if (!monthlyDriverEntry) {
          monthlyDriverEntry = { name: driverName, driverId: delivery.driver_id, billable: 0, nonBillable: 0 };
          metrics.driverDataByMonth[monthIndex + 1].push(monthlyDriverEntry);
        }
        if (isBillable) monthlyDriverEntry.billable++;
        else monthlyDriverEntry.nonBillable++;

        if (!metrics.dailyDriverData[monthIndex + 1]) metrics.dailyDriverData[monthIndex + 1] = {};
        if (!metrics.dailyDriverData[monthIndex + 1][delivery.driver_id]) metrics.dailyDriverData[monthIndex + 1][delivery.driver_id] = [];
        let dailyDriverEntry = metrics.dailyDriverData[monthIndex + 1][delivery.driver_id].find(d => d.day === dayOfMonth);
        if (!dailyDriverEntry) {
          dailyDriverEntry = { day: dayOfMonth, billable: 0, nonBillable: 0 };
          metrics.dailyDriverData[monthIndex + 1][delivery.driver_id].push(dailyDriverEntry);
        }
        if (isBillable) dailyDriverEntry.billable++;
        else dailyDriverEntry.nonBillable++;

        if (delivery.store_id) {
          if (!metrics.driverDataByStore[delivery.store_id]) metrics.driverDataByStore[delivery.store_id] = [];
          let storeDriverEntry = metrics.driverDataByStore[delivery.store_id].find(d => d.driverId === delivery.driver_id);
          if (!storeDriverEntry) {
            storeDriverEntry = { name: driverName, driverId: delivery.driver_id, billable: 0, nonBillable: 0 };
            metrics.driverDataByStore[delivery.store_id].push(storeDriverEntry);
          }
          if (isBillable) storeDriverEntry.billable++;
          else storeDriverEntry.nonBillable++;
        }
      }
    }

    if (delivery.store_id && store?.abbreviation) {
      const annualStoreEntry = metrics.storeData.find(s => s.storeId === delivery.store_id);
      if (annualStoreEntry) {
        if (isCountableCompletedDelivery(delivery)) annualStoreEntry.completed++;
        if (isCountableFailedDelivery(delivery)) annualStoreEntry.failed++;
        if (isCountableAfterHoursPickup(delivery)) annualStoreEntry.afterHours++;
      }

      if (!metrics.storeDataByMonth[monthIndex + 1]) metrics.storeDataByMonth[monthIndex + 1] = [];
      let monthlyStoreEntry = metrics.storeDataByMonth[monthIndex + 1].find(s => s.storeId === delivery.store_id);
      if (!monthlyStoreEntry) {
        monthlyStoreEntry = { abbreviation: store.abbreviation, name: store.name, storeId: delivery.store_id, completed: 0, failed: 0, afterHours: 0, color: store.color, sortOrder: store.sort_order };
        metrics.storeDataByMonth[monthIndex + 1].push(monthlyStoreEntry);
      }
      if (isCountableCompletedDelivery(delivery)) monthlyStoreEntry.completed++;
      if (isCountableFailedDelivery(delivery)) monthlyStoreEntry.failed++;
      if (isCountableAfterHoursPickup(delivery)) monthlyStoreEntry.afterHours++;

      if (!metrics.dailyStoreData[monthIndex + 1]) metrics.dailyStoreData[monthIndex + 1] = {};
      if (!metrics.dailyStoreData[monthIndex + 1][delivery.store_id]) metrics.dailyStoreData[monthIndex + 1][delivery.store_id] = [];
      let dailyStoreEntry = metrics.dailyStoreData[monthIndex + 1][delivery.store_id].find(d => d.day === dayOfMonth);
      if (!dailyStoreEntry) {
        dailyStoreEntry = { day: dayOfMonth, completed: 0, failed: 0, afterHours: 0, extra_km: 0 };
        metrics.dailyStoreData[monthIndex + 1][delivery.store_id].push(dailyStoreEntry);
      }
      if (isCountableCompletedDelivery(delivery)) dailyStoreEntry.completed++;
      if (isCountableFailedDelivery(delivery)) dailyStoreEntry.failed++;
      if (isCountableAfterHoursPickup(delivery)) dailyStoreEntry.afterHours++;
      if (delivery.patient_id && (isCountableCompletedDelivery(delivery) || isCountableFailedDelivery(delivery))) dailyStoreEntry.extra_km += calculateExtraKm(delivery);

      if (appFeeRate > 0 && wasPayingOnDeliveryDate && isAppFeePayableDelivery(delivery)) {
        storesPayingFeesSet.add(store.id);
        if (!storeMonthlyFees.has(store.id)) storeMonthlyFees.set(store.id, Array(12).fill(0));
        storeMonthlyFees.get(store.id)[monthIndex] += appFeeRate;
        metrics.storeFeeTotals.monthlyFees[monthIndex] += appFeeRate;
        metrics.storeFeeTotals.total_fees_owed += appFeeRate;
        metrics.storeFeeTotals.total_billable_while_paying++;
      }
    }
  }

  for (const [storeId, monthlyFeesArray] of storeMonthlyFees.entries()) {
    const store = storeMap.get(storeId);
    if (store) {
      for (let m = 0; m < 12; m++) {
        if (!metrics.monthlyStoreData[m + 1]) metrics.monthlyStoreData[m + 1] = [];
        const existingEntry = metrics.storeDataByMonth[m + 1]?.find(s => s.storeId === storeId);
        if (existingEntry) metrics.monthlyStoreData[m + 1].push({ ...existingEntry, fees: monthlyFeesArray[m] });
        else metrics.monthlyStoreData[m + 1].push({ abbreviation: store.abbreviation, name: store.name, storeId: store.id, fees: monthlyFeesArray[m], completed: 0, color: store.color, sortOrder: store.sort_order });
      }
    }
  }

  for (let m = 1; m <= 12; m++) {
    const existingStores = new Set(metrics.monthlyStoreData[m]?.map(s => s.storeId) || []);
    (metrics.storeDataByMonth[m] || []).forEach(storeData => {
      if (!existingStores.has(storeData.storeId)) {
        if (!metrics.monthlyStoreData[m]) metrics.monthlyStoreData[m] = [];
        metrics.monthlyStoreData[m].push({ ...storeData, fees: 0 });
      }
    });
  }

  metrics.monthlyData = Array(12).fill(null).map((_, index) => {
    const monthStores = metrics.monthlyStoreData[index + 1] || [];
    const billable = monthStores
      .filter((storeEntry) => (storeEntry.fees || 0) > 0)
      .reduce((sum, storeEntry) => sum + (storeEntry.completed || 0) + (storeEntry.failed || 0) + (storeEntry.afterHours || 0), 0);
    const nonBillable = monthStores
      .filter((storeEntry) => (storeEntry.fees || 0) <= 0)
      .reduce((sum, storeEntry) => sum + (storeEntry.completed || 0) + (storeEntry.failed || 0) + (storeEntry.afterHours || 0), 0);

    return {
      month: MONTH_NAMES[index],
      billable,
      nonBillable,
      total: billable + nonBillable
    };
  });

  metrics.yearTotals.billable = metrics.monthlyData.reduce((sum, month) => sum + (month.billable || 0), 0);
  metrics.yearTotals.nonBillable = metrics.monthlyData.reduce((sum, month) => sum + (month.nonBillable || 0), 0);
  metrics.storeFeeTotals.stores_paying_fees = storesPayingFeesSet.size;
  metrics.yearTotals.activeDrivers = new Set(appUsers.filter(au => au.app_roles && au.app_roles.includes('driver') && au.status === 'active').map(au => au.user_id)).size;
  return metrics;
}

function calculateEnvelopeMetrics(deliveries, stores) {
  const envelopeMetrics = { byStoreAndMonth: {}, yearTotals: { envelopeDeliveriesCount: 0, totalEnvelopeValue: 0, adjustedDeliveries: 0, actualDeliveries: 0 } };
  const envelopeRegex = /(\d{1,2})\s*Envelope/i;

  for (const delivery of deliveries) {
    if (!delivery || !delivery.store_id || !delivery.delivery_date) continue;
    const month = new Date(delivery.delivery_date).getMonth() + 1;
    const storeId = delivery.store_id;
    if (!envelopeMetrics.byStoreAndMonth[storeId]) envelopeMetrics.byStoreAndMonth[storeId] = {};
    if (!envelopeMetrics.byStoreAndMonth[storeId][month]) {
      envelopeMetrics.byStoreAndMonth[storeId][month] = { envelopeDeliveriesCount: 0, totalEnvelopeValue: 0, actualDeliveries: 0, adjustedDeliveries: 0 };
    }
    envelopeMetrics.byStoreAndMonth[storeId][month].actualDeliveries++;
    envelopeMetrics.yearTotals.actualDeliveries++;
    const match = (delivery.delivery_notes || '').match(envelopeRegex);
    if (match) {
      const val = parseInt(match[1], 10);
      if (!isNaN(val)) {
        envelopeMetrics.byStoreAndMonth[storeId][month].envelopeDeliveriesCount++;
        envelopeMetrics.byStoreAndMonth[storeId][month].totalEnvelopeValue += val;
        envelopeMetrics.yearTotals.envelopeDeliveriesCount++;
        envelopeMetrics.yearTotals.totalEnvelopeValue += val;
      }
    }
  }

  for (const storeId in envelopeMetrics.byStoreAndMonth) {
    for (const month in envelopeMetrics.byStoreAndMonth[storeId]) {
      const d = envelopeMetrics.byStoreAndMonth[storeId][month];
      d.adjustedDeliveries = d.actualDeliveries - d.envelopeDeliveriesCount + d.totalEnvelopeValue;
    }
  }
  envelopeMetrics.yearTotals.adjustedDeliveries = envelopeMetrics.yearTotals.actualDeliveries - envelopeMetrics.yearTotals.envelopeDeliveriesCount + envelopeMetrics.yearTotals.totalEnvelopeValue;
  return envelopeMetrics;
}