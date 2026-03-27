import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';


const CACHE_VERSION = Date.now().toString();
const statsCache = new Map();
const CACHE_DISABLED = true;
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

const fetchDateRangeRecords = async (entityApi, dateField, startStr, endStr, sort = '-created_date') => {
  const records = await entityApi.filter({
    [dateField]: { $gte: startStr, $lte: endStr }
  }, sort, BATCH_LIMIT);

  if (!Array.isArray(records)) return [];
  if (records.length < BATCH_LIMIT || startStr === endStr) return records;

  const midpoint = getMidpointDate(startStr, endStr);
  if (midpoint <= startStr || midpoint >= endStr) return records;

  const leftRecords = await fetchDateRangeRecords(entityApi, dateField, startStr, midpoint, sort);
  const rightRecords = await fetchDateRangeRecords(entityApi, dateField, getNextDate(midpoint), endStr, sort);
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
  'delivery_notes',
  'actual_delivery_time'
];

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

    const appUserList = await base44.asServiceRole.entities.AppUser.filter({ user_id: user.id });
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
    } = body;

    const fetchYearData = async (year, cityId) => {
      const cacheKey = `${CACHE_VERSION}_${year}_${cityId || 'all'}`;
      const cached = statsCache.get(cacheKey);
      if (!CACHE_DISABLED && cached && (Date.now() - cached.timestamp < 300000)) {
        return cached.data;
      }

      let cityStoreIds = null;
      if (cityId && cityId !== 'all') {
        const cityStores = await base44.asServiceRole.entities.Store.filter({ city_id: cityId }, '', 50000);
        cityStoreIds = new Set((cityStores || []).map((store) => store.id));
      }

      const yearStart = `${year}-01-01`;
      const yearEnd = `${year}-12-31`;

      const [appSettings, allYearDeliveriesRaw, allYearPayrollRaw] = await Promise.all([
        base44.asServiceRole.entities.AppSettings.filter({ setting_key: 'refresh_intervals' }),
        fetchDateRangeRecords(base44.asServiceRole.entities.Delivery, 'delivery_date', yearStart, yearEnd, '-delivery_date'),
        fetchDateRangeRecords(base44.asServiceRole.entities.Payroll, 'pay_period_start', yearStart, yearEnd, '-pay_period_start')
      ]);

      let deliveries = dedupeById(allYearDeliveriesRaw || []);
      if (cityStoreIds) {
        deliveries = deliveries.filter((delivery) => cityStoreIds.has(delivery.store_id));
      }

      const relevantStoreIds = Array.from(new Set(deliveries.map((delivery) => delivery.store_id).filter(Boolean)));
      const relevantPatientIds = Array.from(new Set(deliveries.map((delivery) => delivery.patient_id).filter(Boolean)));
      const relevantDriverIds = Array.from(new Set(deliveries.map((delivery) => delivery.driver_id).filter(Boolean)));

      const [storesRaw, appUsersRaw, patientsRaw] = await Promise.all([
        relevantStoreIds.length ? base44.asServiceRole.entities.Store.filter({ id: { $in: relevantStoreIds } }, '', 5000) : [],
        base44.asServiceRole.entities.AppUser.filter({ app_roles: { $in: ['driver'] } }, '', 5000),
        relevantPatientIds.length ? base44.asServiceRole.entities.Patient.filter({ id: { $in: relevantPatientIds } }, '', 5000) : []
      ]);

      const stores = (storesRaw || []).map((store) => pickFields(store, STORE_FIELDS));

      const payrollDriverIds = dedupeById(allYearPayrollRaw || []).map((record) => record?.driver_id).filter(Boolean);
      const driverIdsToKeep = new Set([...relevantDriverIds, ...payrollDriverIds]);
      const appUsers = (appUsersRaw || [])
        .filter((appUserRecord) => driverIdsToKeep.size === 0 || driverIdsToKeep.has(appUserRecord.user_id))
        .map((appUserRecord) => pickFields(appUserRecord, DRIVER_FIELDS));

      const patients = (patientsRaw || []).map((patient) => pickFields(patient, PATIENT_FIELDS));

      const relevantCityIds = Array.from(new Set(stores.map((store) => store.city_id).filter(Boolean)));
      const citiesRaw = relevantCityIds.length
        ? await base44.asServiceRole.entities.City.filter({ id: { $in: cityId && cityId !== 'all' ? Array.from(new Set([...relevantCityIds, cityId])) : relevantCityIds } }, '', 500)
        : (cityId && cityId !== 'all')
          ? await base44.asServiceRole.entities.City.filter({ id: cityId }, '', 1)
          : [];
      const cities = (citiesRaw || []).map((city) => pickFields(city, CITY_FIELDS));

      const payrollRecords = dedupeById(allYearPayrollRaw || []);
      const appFeeRate = parseFloat(appSettings?.[0]?.setting_value?.app_fees_per_delivery) || 0;

      const data = {
        deliveries: deliveries.map((delivery) => pickFields(delivery, DELIVERY_FIELDS)),
        stores,
        appUsers,
        patients,
        cities,
        appFeeRate,
        payrollRecords
      };

      statsCache.set(cacheKey, { data, timestamp: Date.now() });
      return data;
    };

    let adminMetrics = null;
    if (adminMetricsYear) {
      const yearData = await fetchYearData(adminMetricsYear, adminMetricsCityId);
      adminMetrics = processAdminMetrics(
        yearData.deliveries,
        yearData.stores,
        yearData.appUsers,
        yearData.patients,
        adminMetricsYear,
        yearData.appFeeRate
      );
      adminMetrics.envelopeMetrics = calculateEnvelopeMetrics(yearData.deliveries, yearData.stores);
    }

    let payrollData = null;
    if (payrollYear) {
      const yearData = await fetchYearData(payrollYear, payrollCityId);
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

      yearData.deliveries.forEach((delivery) => {
        if (!delivery || !delivery.delivery_date || !delivery.store_id) return;

        const isValidDelivery = (delivery.status === 'completed' || delivery.status === 'failed') && delivery.patient_id;
        const isAfterHoursPickup = delivery.after_hours_pickup && (delivery.status === 'completed' || delivery.status === 'cancelled');

        if (delivery.driver_id) {
          if (isValidDelivery) {
            driverStats[delivery.driver_id] = driverStats[delivery.driver_id] || { total_deliveries: 0, total_after_hours_pickups: 0 };
            driverStats[delivery.driver_id].total_deliveries++;
          }
          if (isAfterHoursPickup) {
            driverStats[delivery.driver_id] = driverStats[delivery.driver_id] || { total_deliveries: 0, total_after_hours_pickups: 0 };
            driverStats[delivery.driver_id].total_after_hours_pickups++;
          }
        }

        if (storeStats[delivery.store_id]) {
          if (isValidDelivery) {
            storeStats[delivery.store_id].total_deliveries++;
          }
          if (isAfterHoursPickup) {
            storeStats[delivery.store_id].total_after_hours_pickups++;
          }
        }
      });

      payrollData = {
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
    }

    return Response.json({ adminMetrics, payrollData });
  } catch (error) {
    console.error('❌ CRITICAL ERROR in getAdminMetricsAndPayrollData:', error);
    return Response.json({ error: error.message || 'Unknown error occurred' }, { status: 500 });
  }
});

function processAdminMetrics(deliveries, stores, appUsers, patients, year, appFeeRate) {
  const calculateExtraKm = (delivery, patientList) => {
    if (!delivery) return 0;
    let distance = delivery.paid_km_override;
    if (distance === undefined || distance === null) {
      const patient = patientList?.find(p => p.id === delivery.patient_id);
      distance = patient?.distance_from_store || 0;
    }
    const driver = appUsers.find(au => au.user_id === delivery.driver_id);
    const extraKmLimit = driver?.extra_km_limit || 0;
    const extraKm = distance - extraKmLimit;
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

  const patientMap = new Map((patients || []).map((patient) => [patient?.id, patient]));

  const isReturn = (d) => {
    if (!d?.patient_id) return false;
    const patient = patientMap.get(d.patient_id);
    return String(patient?.address || '').toUpperCase().includes('(RTN)');
  };

  const isCompletedPatientDelivery = (d) => d && d.status === 'completed' && !isReturn(d) && d.patient_id;
  const isFailedPatientDelivery = (d) => d && d.status === 'failed' && !isReturn(d) && d.patient_id;
  const isCompletedAfterHoursPickup = (d) => d && d.after_hours_pickup && d.status === 'completed';
  const isCancelledAfterHoursPickup = (d) => d && d.after_hours_pickup && d.status === 'cancelled';
  const isCompletedPatientForStore = (d) => d && d.status === 'completed' && d.patient_id;
  const isFailedPatientForStore = (d) => d && d.status === 'failed' && d.patient_id;

  const isBillableDelivery = (d) => {
    if (!d) return false;
    if (isCompletedAfterHoursPickup(d) || isCancelledAfterHoursPickup(d)) return true;
    if (d.patient_id && (isCompletedPatientDelivery(d) || isFailedPatientDelivery(d) || isReturn(d))) return true;
    return false;
  };

  const storeMonthlyFees = new Map();
  const storesPayingFeesSet = new Set();

  for (const delivery of deliveries.filter(d => d && d.delivery_date)) {
    const date = new Date(delivery.delivery_date);
    const monthIndex = date.getMonth();
    const dayOfMonth = date.getDate();
    const store = delivery.store_id ? storeMap.get(delivery.store_id) : null;
    const wasPayingOnDeliveryDate = store ? wasPayingFeesOnDate(store, delivery.delivery_date) : false;

    if (isBillableDelivery(delivery)) {
      metrics.monthlyData[monthIndex].total++;
      if (wasPayingOnDeliveryDate) {
        metrics.monthlyData[monthIndex].billable++;
        metrics.yearTotals.billable++;
      } else {
        metrics.monthlyData[monthIndex].nonBillable++;
        metrics.yearTotals.nonBillable++;
      }

      if (!metrics.dailyDeliveryData[monthIndex + 1]) metrics.dailyDeliveryData[monthIndex + 1] = [];
      let dailyEntry = metrics.dailyDeliveryData[monthIndex + 1].find(d => d.day === dayOfMonth);
      if (dailyEntry) {
        if (wasPayingOnDeliveryDate) dailyEntry.billable++;
        else dailyEntry.nonBillable++;
      } else {
        metrics.dailyDeliveryData[monthIndex + 1].push({ day: dayOfMonth, billable: wasPayingOnDeliveryDate ? 1 : 0, nonBillable: wasPayingOnDeliveryDate ? 0 : 1 });
      }

      if (delivery.driver_id) {
        const driverAppUser = appUserMap.get(delivery.driver_id);
        const driverName = driverAppUser?.user_name || driverAppUser?.full_name || 'Unknown Driver';
        let annualDriverEntry = metrics.driverData.find(d => d.driverId === delivery.driver_id);
        if (!annualDriverEntry) {
          annualDriverEntry = { name: driverName, driverId: delivery.driver_id, billable: 0, nonBillable: 0 };
          metrics.driverData.push(annualDriverEntry);
        }
        if (wasPayingOnDeliveryDate) annualDriverEntry.billable++;
        else annualDriverEntry.nonBillable++;

        if (!metrics.driverDataByMonth[monthIndex + 1]) metrics.driverDataByMonth[monthIndex + 1] = [];
        let monthlyDriverEntry = metrics.driverDataByMonth[monthIndex + 1].find(d => d.driverId === delivery.driver_id);
        if (!monthlyDriverEntry) {
          monthlyDriverEntry = { name: driverName, driverId: delivery.driver_id, billable: 0, nonBillable: 0 };
          metrics.driverDataByMonth[monthIndex + 1].push(monthlyDriverEntry);
        }
        if (wasPayingOnDeliveryDate) monthlyDriverEntry.billable++;
        else monthlyDriverEntry.nonBillable++;

        if (!metrics.dailyDriverData[monthIndex + 1]) metrics.dailyDriverData[monthIndex + 1] = {};
        if (!metrics.dailyDriverData[monthIndex + 1][delivery.driver_id]) metrics.dailyDriverData[monthIndex + 1][delivery.driver_id] = [];
        let dailyDriverEntry = metrics.dailyDriverData[monthIndex + 1][delivery.driver_id].find(d => d.day === dayOfMonth);
        if (!dailyDriverEntry) {
          dailyDriverEntry = { day: dayOfMonth, billable: 0, nonBillable: 0 };
          metrics.dailyDriverData[monthIndex + 1][delivery.driver_id].push(dailyDriverEntry);
        }
        if (wasPayingOnDeliveryDate) dailyDriverEntry.billable++;
        else dailyDriverEntry.nonBillable++;

        if (delivery.store_id) {
          if (!metrics.driverDataByStore[delivery.store_id]) metrics.driverDataByStore[delivery.store_id] = [];
          let storeDriverEntry = metrics.driverDataByStore[delivery.store_id].find(d => d.driverId === delivery.driver_id);
          if (!storeDriverEntry) {
            storeDriverEntry = { name: driverName, driverId: delivery.driver_id, billable: 0, nonBillable: 0 };
            metrics.driverDataByStore[delivery.store_id].push(storeDriverEntry);
          }
          if (wasPayingOnDeliveryDate) storeDriverEntry.billable++;
          else storeDriverEntry.nonBillable++;
        }
      }
    }

    if (delivery.store_id && store?.abbreviation) {
      const annualStoreEntry = metrics.storeData.find(s => s.storeId === delivery.store_id);
      if (annualStoreEntry) {
        if (isCompletedPatientForStore(delivery)) annualStoreEntry.completed++;
        if (isFailedPatientForStore(delivery)) annualStoreEntry.failed++;
        if (isCompletedAfterHoursPickup(delivery) || isCancelledAfterHoursPickup(delivery)) annualStoreEntry.afterHours++;
      }

      if (!metrics.storeDataByMonth[monthIndex + 1]) metrics.storeDataByMonth[monthIndex + 1] = [];
      let monthlyStoreEntry = metrics.storeDataByMonth[monthIndex + 1].find(s => s.storeId === delivery.store_id);
      if (!monthlyStoreEntry) {
        monthlyStoreEntry = { abbreviation: store.abbreviation, name: store.name, storeId: delivery.store_id, completed: 0, failed: 0, afterHours: 0, color: store.color, sortOrder: store.sort_order };
        metrics.storeDataByMonth[monthIndex + 1].push(monthlyStoreEntry);
      }
      if (isCompletedPatientForStore(delivery)) monthlyStoreEntry.completed++;
      if (isFailedPatientForStore(delivery)) monthlyStoreEntry.failed++;
      if (isCompletedAfterHoursPickup(delivery) || isCancelledAfterHoursPickup(delivery)) monthlyStoreEntry.afterHours++;

      if (!metrics.dailyStoreData[monthIndex + 1]) metrics.dailyStoreData[monthIndex + 1] = {};
      if (!metrics.dailyStoreData[monthIndex + 1][delivery.store_id]) metrics.dailyStoreData[monthIndex + 1][delivery.store_id] = [];
      let dailyStoreEntry = metrics.dailyStoreData[monthIndex + 1][delivery.store_id].find(d => d.day === dayOfMonth);
      if (!dailyStoreEntry) {
        dailyStoreEntry = { day: dayOfMonth, completed: 0, failed: 0, afterHours: 0, extra_km: 0 };
        metrics.dailyStoreData[monthIndex + 1][delivery.store_id].push(dailyStoreEntry);
      }
      if (isCompletedPatientForStore(delivery)) dailyStoreEntry.completed++;
      if (isFailedPatientForStore(delivery)) dailyStoreEntry.failed++;
      if (isCompletedAfterHoursPickup(delivery) || isCancelledAfterHoursPickup(delivery)) dailyStoreEntry.afterHours++;
      if (delivery.patient_id && (isCompletedPatientForStore(delivery) || isFailedPatientForStore(delivery))) dailyStoreEntry.extra_km += calculateExtraKm(delivery, patients);

      if (wasPayingOnDeliveryDate && appFeeRate > 0) {
        storesPayingFeesSet.add(store.id);
        if (isBillableDelivery(delivery)) {
          if (!storeMonthlyFees.has(store.id)) storeMonthlyFees.set(store.id, Array(12).fill(0));
          storeMonthlyFees.get(store.id)[monthIndex] += appFeeRate;
          metrics.storeFeeTotals.monthlyFees[monthIndex] += appFeeRate;
          metrics.storeFeeTotals.total_fees_owed += appFeeRate;
          metrics.storeFeeTotals.total_billable_while_paying++;
        }
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