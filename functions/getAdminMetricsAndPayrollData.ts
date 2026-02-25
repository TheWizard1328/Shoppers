import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

// In-memory cache keyed by year+cityId — busted on new deploy
const CACHE_VERSION = Date.now().toString();
const statsCache = new Map();

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
    if (!user.role === 'admin' && !appRoles.includes('admin') && !appRoles.includes('driver')) {
      return Response.json({ error: 'Forbidden: Access denied' }, { status: 403 });
    }

    let body = {};
    try {
      const text = await req.text();
      if (text) body = JSON.parse(text);
    } catch (_) {}

    const {
      // Admin Metrics request
      adminMetricsYear, adminMetricsCityId,
      // Payroll request
      payrollYear, payrollCityId,
    } = body;

    // ─── Shared data fetch (year + optional city filter) ───────────────────────
    // Both admin metrics and payroll use the same underlying year data.
    // We fetch once per year+city combination and cache it.

    const fetchYearData = async (year, cityId) => {
      const cacheKey = `${CACHE_VERSION}_${year}_${cityId || 'all'}`;
      const cached = statsCache.get(cacheKey);
      if (cached && (Date.now() - cached.timestamp < 300000)) {  // 5 min cache TTL
        console.log(`📊 Using CACHED year data for ${year} city=${cityId || 'all'}`);
        return cached.data;
      }

      console.log(`📥 Fetching year data for ${year} city=${cityId || 'all'}`);

      // Build optional store filter when a city is selected
      let storeIds = null;
      if (cityId && cityId !== 'all') {
        const cityStores = await base44.asServiceRole.entities.Store.filter({ city_id: cityId }, '', 50000);
        storeIds = cityStores.map(s => s.id);
      }

      // Fetch all reference data in parallel (including deliveries)
      // Note: Using list() with limit to get deliveries; filter() may return non-array buffers depending on environment
      const [rawDeliveries, stores, appUsers, patients, cities, appSettings, rawPayrollRecords] = await Promise.all([
        base44.asServiceRole.entities.Delivery.list('-delivery_date', 50000),  // latest first to ensure current-year data
        base44.asServiceRole.entities.Store.list('', 50000),
        base44.asServiceRole.entities.AppUser.list('', 50000),
        base44.asServiceRole.entities.Patient.list('', 50000),
        base44.asServiceRole.entities.City.list('', 50000),
        base44.asServiceRole.entities.AppSettings.list(),
        base44.asServiceRole.entities.Payroll.list('-pay_period_start', 50000)
      ]);

      const appFeeRate = parseFloat(appSettings[0]?.setting_value?.app_fees_per_delivery) || 0;
      
      // Filter deliveries and payroll records by year and optional city filter
      let deliveries = Array.isArray(rawDeliveries) ? rawDeliveries : [];
      let payrollRecords = Array.isArray(rawPayrollRecords) ? rawPayrollRecords : [];
      
      // Filter by year (robust; fallback to actual_delivery_time/arrival_time)
      deliveries = deliveries.filter(d => {
        if (!d) return false;
        const raw = d.delivery_date || (d.actual_delivery_time ? String(d.actual_delivery_time).slice(0,10) : null) || (d.arrival_time ? String(d.arrival_time).slice(0,10) : null);
        if (!raw) return false;
        const parsed = new Date(raw);
        const y = !isNaN(parsed.getTime()) ? parsed.getFullYear() : parseInt(String(raw).slice(0, 4), 10);
        return y === Number(year);
      });
      
      // Filter by stores if city is specified
      if (storeIds && storeIds.length > 0) {
        deliveries = deliveries.filter(d => d && storeIds.includes(d.store_id));
      }
      
      payrollRecords = payrollRecords.filter(p => p && p.pay_period_start && p.pay_period_start.startsWith(`${year}`));

      console.log(`📦 Raw deliveries returned: ${(rawDeliveries || []).length}, filtered to ${deliveries.length} for year ${year}`);
      if (deliveries.length > 0) {
        console.log(`🔍 Sample delivery:`, JSON.stringify(deliveries[0], null, 2).substring(0, 500));
      }

      const data = {
        deliveries,
        stores,
        appUsers,
        patients,
        cities,
        appFeeRate,
        payrollRecords
      };

      statsCache.set(cacheKey, { data, timestamp: Date.now() });
      console.log(`✅ Cached year data for ${year}: ${data.deliveries.length} deliveries`);
      return data;
    };

    // ─── Admin Metrics ──────────────────────────────────────────────────────────
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
      console.log(`✅ AdminMetrics processed for ${adminMetricsYear}`);
    }

    // ─── Payroll Data ───────────────────────────────────────────────────────────
    // Calculate aggregated totals per driver and store
    let payrollData = null;
    if (payrollYear) {
      const yearData = await fetchYearData(payrollYear, payrollCityId);
      const drivers = yearData.appUsers.filter(au => au.app_roles && au.app_roles.includes('driver'));

      // Pre-calculate driver stats
      const driverStats = {};
      drivers.forEach(driver => {
        driverStats[driver.user_id] = {
          total_deliveries: 0,
          total_after_hours_pickups: 0
        };
      });

      // Pre-calculate store stats
      const storeStats = {};
      yearData.stores.forEach(store => {
        storeStats[store.id] = {
          total_deliveries: 0,
          total_after_hours_pickups: 0
        };
      });

      // Aggregate from deliveries
      yearData.deliveries.forEach(d => {
        if (!d || !d.delivery_date || !d.store_id) return;

        const isValidDelivery = (d.status === 'completed' || d.status === 'failed') && d.patient_id;
        const isAfterHoursPickup = d.after_hours_pickup && (d.status === 'completed' || d.status === 'cancelled');

        // Count by driver
        if (d.driver_id) {
          if (isValidDelivery) {
            driverStats[d.driver_id] = driverStats[d.driver_id] || { total_deliveries: 0, total_after_hours_pickups: 0 };
            driverStats[d.driver_id].total_deliveries++;
          }
          if (isAfterHoursPickup) {
            driverStats[d.driver_id] = driverStats[d.driver_id] || { total_deliveries: 0, total_after_hours_pickups: 0 };
            driverStats[d.driver_id].total_after_hours_pickups++;
          }
        }

        // Count by store
        if (isValidDelivery) {
          storeStats[d.store_id].total_deliveries++;
        }
        if (isAfterHoursPickup) {
          storeStats[d.store_id].total_after_hours_pickups++;
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
        storeStats
      };
      console.log(`✅ PayrollData for ${payrollYear}: ${payrollData.deliveries.length} deliveries, ${payrollData.payrollRecords.length} payroll records, driver stats calculated`);
    }

    return Response.json({ adminMetrics, payrollData });

  } catch (error) {
    console.error('❌ CRITICAL ERROR in getAdminMetricsAndPayrollData:', error);
    return Response.json({ error: error.message || 'Unknown error occurred' }, { status: 500 });
  }
});


// ─── Admin Metrics Processing ─────────────────────────────────────────────────

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

  const isReturn = (d) => {
    if (!d) return false;
    const notes = (d.delivery_notes || '');
    const patientName = (d.patient_name || '');
    if (notes.toLowerCase().includes('(rtn)') || patientName.toLowerCase().includes('(rtn)')) return true;
    const returnRegex = /\breturn\b/i;
    return returnRegex.test(notes) || returnRegex.test(patientName);
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

  for (const delivery of deliveries.filter(d => d && (d.delivery_date || d.actual_delivery_time || d.arrival_time))) {
    const rawDate = delivery.delivery_date || (delivery.actual_delivery_time ? String(delivery.actual_delivery_time).slice(0,10) : null) || (delivery.arrival_time ? String(delivery.arrival_time).slice(0,10) : null);
    if (!rawDate) continue;
    const date = new Date(rawDate);
    const monthIndex = date.getMonth();
    const dayOfMonth = date.getDate();
    const store = delivery.store_id ? storeMap.get(delivery.store_id) : null;

    if (isBillableDelivery(delivery)) {
      metrics.monthlyData[monthIndex].total++;
      if (store?.pays_app_fees) {
        metrics.monthlyData[monthIndex].billable++;
        metrics.yearTotals.billable++;
      } else {
        metrics.monthlyData[monthIndex].nonBillable++;
        metrics.yearTotals.nonBillable++;
      }

      if (!metrics.dailyDeliveryData[monthIndex + 1]) metrics.dailyDeliveryData[monthIndex + 1] = [];
      let dailyEntry = metrics.dailyDeliveryData[monthIndex + 1].find(d => d.day === dayOfMonth);
      if (dailyEntry) {
        if (store?.pays_app_fees) dailyEntry.billable++;
        else dailyEntry.nonBillable++;
      } else {
        metrics.dailyDeliveryData[monthIndex + 1].push({
          day: dayOfMonth,
          billable: store?.pays_app_fees ? 1 : 0,
          nonBillable: store?.pays_app_fees ? 0 : 1,
        });
      }

      if (delivery.driver_id) {
        const driverAppUser = appUserMap.get(delivery.driver_id);
        const driverName = driverAppUser?.user_name || driverAppUser?.full_name || 'Unknown Driver';

        let annualDriverEntry = metrics.driverData.find(d => d.driverId === delivery.driver_id);
        if (!annualDriverEntry) {
          annualDriverEntry = { name: driverName, driverId: delivery.driver_id, billable: 0, nonBillable: 0 };
          metrics.driverData.push(annualDriverEntry);
        }
        if (store?.pays_app_fees) annualDriverEntry.billable++;
        else annualDriverEntry.nonBillable++;

        if (!metrics.driverDataByMonth[monthIndex + 1]) metrics.driverDataByMonth[monthIndex + 1] = [];
        let monthlyDriverEntry = metrics.driverDataByMonth[monthIndex + 1].find(d => d.driverId === delivery.driver_id);
        if (!monthlyDriverEntry) {
          monthlyDriverEntry = { name: driverName, driverId: delivery.driver_id, billable: 0, nonBillable: 0 };
          metrics.driverDataByMonth[monthIndex + 1].push(monthlyDriverEntry);
        }
        if (store?.pays_app_fees) monthlyDriverEntry.billable++;
        else monthlyDriverEntry.nonBillable++;

        if (!metrics.dailyDriverData[monthIndex + 1]) metrics.dailyDriverData[monthIndex + 1] = {};
        if (!metrics.dailyDriverData[monthIndex + 1][delivery.driver_id]) {
          metrics.dailyDriverData[monthIndex + 1][delivery.driver_id] = [];
        }
        let dailyDriverEntry = metrics.dailyDriverData[monthIndex + 1][delivery.driver_id].find(d => d.day === dayOfMonth);
        if (!dailyDriverEntry) {
          dailyDriverEntry = { day: dayOfMonth, billable: 0, nonBillable: 0 };
          metrics.dailyDriverData[monthIndex + 1][delivery.driver_id].push(dailyDriverEntry);
        }
        if (store?.pays_app_fees) dailyDriverEntry.billable++;
        else dailyDriverEntry.nonBillable++;

        if (delivery.store_id) {
          if (!metrics.driverDataByStore[delivery.store_id]) metrics.driverDataByStore[delivery.store_id] = [];
          let storeDriverEntry = metrics.driverDataByStore[delivery.store_id].find(d => d.driverId === delivery.driver_id);
          if (!storeDriverEntry) {
            storeDriverEntry = { name: driverName, driverId: delivery.driver_id, billable: 0, nonBillable: 0 };
            metrics.driverDataByStore[delivery.store_id].push(storeDriverEntry);
          }
          if (store?.pays_app_fees) storeDriverEntry.billable++;
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
        monthlyStoreEntry = {
          abbreviation: store.abbreviation, name: store.name, storeId: delivery.store_id,
          completed: 0, failed: 0, afterHours: 0, color: store.color, sortOrder: store.sort_order
        };
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
      if (delivery.patient_id && (isCompletedPatientForStore(delivery) || isFailedPatientForStore(delivery))) {
        dailyStoreEntry.extra_km += calculateExtraKm(delivery, patients);
      }

      if (store.pays_app_fees && appFeeRate > 0) {
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
        if (existingEntry) {
          metrics.monthlyStoreData[m + 1].push({ ...existingEntry, fees: monthlyFeesArray[m] });
        } else {
          metrics.monthlyStoreData[m + 1].push({
            abbreviation: store.abbreviation, name: store.name, storeId: store.id,
            fees: monthlyFeesArray[m], completed: 0, color: store.color, sortOrder: store.sort_order
          });
        }
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
  metrics.yearTotals.activeDrivers = new Set(
    appUsers.filter(au => au.app_roles && au.app_roles.includes('driver') && au.status === 'active').map(au => au.user_id)
  ).size;

  return metrics;
}


// ─── Envelope Metrics ─────────────────────────────────────────────────────────

function calculateEnvelopeMetrics(deliveries, stores) {
  const envelopeMetrics = {
    byStoreAndMonth: {},
    yearTotals: { envelopeDeliveriesCount: 0, totalEnvelopeValue: 0, adjustedDeliveries: 0, actualDeliveries: 0 }
  };

  const envelopeRegex = /(\d{1,2})\s*Envelope/i;

  for (const delivery of deliveries) {
    if (!delivery || !delivery.store_id) continue;
    const rawDate = delivery.delivery_date || (delivery.actual_delivery_time ? String(delivery.actual_delivery_time).slice(0,10) : null) || (delivery.arrival_time ? String(delivery.arrival_time).slice(0,10) : null);
    if (!rawDate) continue;
    const month = new Date(rawDate).getMonth() + 1;
    const storeId = delivery.store_id;
    if (!envelopeMetrics.byStoreAndMonth[storeId]) envelopeMetrics.byStoreAndMonth[storeId] = {};
    if (!envelopeMetrics.byStoreAndMonth[storeId][month]) {
      envelopeMetrics.byStoreAndMonth[storeId][month] = {
        envelopeDeliveriesCount: 0, totalEnvelopeValue: 0, actualDeliveries: 0, adjustedDeliveries: 0
      };
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
  envelopeMetrics.yearTotals.adjustedDeliveries =
    envelopeMetrics.yearTotals.actualDeliveries -
    envelopeMetrics.yearTotals.envelopeDeliveriesCount +
    envelopeMetrics.yearTotals.totalEnvelopeValue;

  return envelopeMetrics;
}