import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

// In-memory cache for expensive stats
// CRITICAL: Cache is now PER-YEAR to prevent past month data loss
const statsCache = new Map();

// Helper function to get today's date key for cache invalidation
const getCacheDateKey = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);

    let user;
    try {
      user = await base44.auth.me();
    } catch (authError) {
      console.error('❌ Auth error:', authError.message);
      return Response.json({ error: 'Authentication failed: ' + authError.message }, { status: 401 });
    }
    
    if (!user) {
      return Response.json({ error: 'Forbidden: Authentication required' }, { status: 403 });
    }
    
    // Get AppUser to check app_roles
    const appUserList = await base44.asServiceRole.entities.AppUser.filter({ user_id: user.id });
    const appUser = appUserList[0];
    const appRoles = appUser?.app_roles || [];
    const isAppAdmin = user.role === 'admin'; // Platform admin (app owner)
    const isAppRoleAdmin = appRoles.includes('admin');
    const isDriver = appRoles.includes('driver');
    
    // Allow: app owners, app admins, or drivers (for their own payroll)
    if (!isAppAdmin && !isAppRoleAdmin && !isDriver) {
      return Response.json({ error: 'Forbidden: Access denied' }, { status: 403 });
    }

    let body = {};
    try {
      const text = await req.text();
      if (text) {
        body = JSON.parse(text);
      }
    } catch (parseError) {
      console.warn('Failed to parse request body:', parseError);
    }

    const { 
      adminMetricsYear, adminMetricsCityId,
      payrollYear, payrollCityId, payrollDriverId, payrollStartDate, payrollEndDate
    } = body;

    const cacheDate = getCacheDateKey();

    const fetchAdminMetrics = async (year, cityId) => {
      const metricsKey = `admin_${year}_${cityId}`;
      statsCache.delete(metricsKey);
      console.log(`🔍 [AdminMetrics] Starting fetch for year=${year}, cityId=${cityId}`);

      const deliveriesRaw = await base44.asServiceRole.entities.Delivery.filter({
        delivery_date: { $gte: `${year}-01-01`, $lte: `${year}-12-31` }
      }, '-delivery_date', 5000);
      let deliveries;
      if (Array.isArray(deliveriesRaw)) {
        deliveries = deliveriesRaw;
      } else if (typeof deliveriesRaw === 'string') {
        try { deliveries = JSON.parse(deliveriesRaw); } catch { deliveries = []; }
      } else {
        deliveries = deliveriesRaw?.items ?? deliveriesRaw?.data ?? [];
      }
      if (!Array.isArray(deliveries)) deliveries = [];
      console.log(`📦 [AdminMetrics] Fetched ${deliveries.length} deliveries for ${year}`);

      // Filter by city (client-side) if cityId is specified
      if (cityId && cityId !== 'all') {
        const cityStoresRaw = await base44.asServiceRole.entities.Store.filter({ city_id: cityId });
        const cityStores = Array.isArray(cityStoresRaw) ? cityStoresRaw : (cityStoresRaw?.items ?? cityStoresRaw?.data ?? []);
        const cityStoreIds = new Set(cityStores.map(s => s.id));
        deliveries = deliveries.filter(d => cityStoreIds.has(d.store_id));
      }

      const storesRaw = await base44.asServiceRole.entities.Store.list();
      const stores = Array.isArray(storesRaw) ? storesRaw : (storesRaw?.items ?? storesRaw?.data ?? []);
      const appUsersRaw = await base44.asServiceRole.entities.AppUser.list();
      const appUsers = Array.isArray(appUsersRaw) ? appUsersRaw : (appUsersRaw?.items ?? appUsersRaw?.data ?? []);
      const patientsRaw = await base44.asServiceRole.entities.Patient.list();
      const patients = Array.isArray(patientsRaw) ? patientsRaw : (patientsRaw?.items ?? patientsRaw?.data ?? []);
      const appSettings = await base44.asServiceRole.entities.AppSettings.filter({ setting_key: 'refresh_intervals' });
      const appFeeRate = parseFloat(appSettings[0]?.setting_value?.app_fees_per_delivery) || 0;
      console.log('📊 [AdminMetrics] App Fee Rate:', appFeeRate);

      const metrics = processAdminMetrics(deliveries, stores, appUsers, patients, year, appFeeRate, patients);
      
      // Add envelope metrics - checks delivery_notes (driver notes)
      const envelopeMetrics = calculateEnvelopeMetrics(deliveries, stores);
      metrics.envelopeMetrics = envelopeMetrics;

      statsCache.set(metricsKey, { data: metrics, timestamp: Date.now() });
      console.log(`✅ Cached AdminMetrics for ${year}`);
      return metrics;
    };

    const fetchPayrollData = async (year, cityId, driverId, startDate, endDate) => {
      const payrollKey = `payroll_${year}_${cityId}_${driverId}_${startDate}_${endDate}`;
      const cached = statsCache.get(payrollKey);
      
      // Cache is valid for 1 hour
      if (cached && (Date.now() - cached.timestamp < 3600000)) {
        console.log(`📊 Using CACHED PayrollData for ${year} (${startDate} to ${endDate})`);
        return cached.data;
      }

      // Build store filter from city (Deliveries don't have city_id, only store_id)
      let storeIds = null;
      if (cityId && cityId !== 'all') {
        const cityStores = await base44.asServiceRole.entities.Store.filter({ city_id: cityId });
        storeIds = cityStores.map(s => s.id);
      }

      // CRITICAL: Fetch deliveries for the specific pay period date range
      const dateFilter = {
        delivery_date: { $gte: startDate, $lte: endDate }
      };
      
      const allYearDeliveriesResponse = await base44.asServiceRole.entities.Delivery.filter(dateFilter);

      // CRITICAL: Ensure response is always an array
      const allYearDeliveries = Array.isArray(allYearDeliveriesResponse) ? allYearDeliveriesResponse : [];

      // Filter by store (via city filter) and driver, include only completed/failed/cancelled deliveries
      let payrollDeliveries = allYearDeliveries.filter(d => 
        d && d.delivery_date && 
        (d.status === 'completed' || d.status === 'failed' || d.status === 'cancelled') &&
        (!storeIds || storeIds.includes(d.store_id)) &&
        (!driverId || driverId === 'all' || d.driver_id === driverId)
      );

      const payrollPatients = await base44.asServiceRole.entities.Patient.list();
      const payrollAppUsers = await base44.asServiceRole.entities.AppUser.list();
      const payrollDrivers = payrollAppUsers.filter(au => au.app_roles && au.app_roles.includes('driver'));
      const payrollStores = await base44.asServiceRole.entities.Store.list();
      const payrollCities = await base44.asServiceRole.entities.City.list();

      const payrollData = {
        deliveries: Array.isArray(payrollDeliveries) ? payrollDeliveries : [],
        patients: Array.isArray(payrollPatients) ? payrollPatients : [],
        appUsers: Array.isArray(payrollAppUsers) ? payrollAppUsers : [],
        drivers: Array.isArray(payrollDrivers) ? payrollDrivers : [],
        stores: Array.isArray(payrollStores) ? payrollStores : [],
        cities: Array.isArray(payrollCities) ? payrollCities : []
      };

      statsCache.set(payrollKey, { data: payrollData, timestamp: Date.now() });
      console.log(`✅ Cached PayrollData for ${year} (${payrollData.deliveries.length} deliveries)`);
      return payrollData;
    };

    const [adminMetrics, payrollData] = await Promise.all([
      adminMetricsYear ? fetchAdminMetrics(adminMetricsYear, adminMetricsCityId) : Promise.resolve(null),
      payrollYear ? fetchPayrollData(payrollYear, payrollCityId, payrollDriverId, payrollStartDate, payrollEndDate) : Promise.resolve(null)
    ]);

    console.log(`✅ [getAdminMetricsAndPayrollData] Response payload:`, {
      hasAdminMetrics: !!adminMetrics,
      hasPayrollData: !!payrollData,
      payrollDataKeys: payrollData ? Object.keys(payrollData) : []
    });

    return Response.json({
      adminMetrics,
      payrollData
    });

    } catch (error) {
    console.error('❌ CRITICAL ERROR in getAdminMetricsAndPayrollData:', error);
    console.error('Error details:', {
      message: error.message,
      stack: error.stack
    });
    return Response.json({ error: error.message || 'Unknown error occurred' }, { status: 500 });
    }
});


function processAdminMetrics(deliveries, stores, appUsers, patients, year, appFeeRate) {
  
  // Helper to calculate extra_km for a delivery
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
      billable: 0, 
      nonBillable: 0, 
      total: 0 
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

  const relevantDeliveries = deliveries.filter(d => d && d.delivery_date);

  stores.forEach(s => {
    metrics.storeData.push({ 
      abbreviation: s.abbreviation, 
      name: s.name, 
      storeId: s.id, 
      completed: 0, 
      failed: 0, 
      afterHours: 0, 
      cancelled: 0, 
      fees: 0, 
      color: s.color, 
      sortOrder: s.sort_order 
    });
  });
  
  // Deduplicate drivers by user_id (in case of duplicate AppUser records)
  const uniqueDriverMap = new Map();
  appUsers.filter(au => au.app_roles && au.app_roles.includes('driver')).forEach(driver => {
    if (!uniqueDriverMap.has(driver.user_id)) {
      uniqueDriverMap.set(driver.user_id, { 
        name: driver.user_name || driver.full_name, 
        driverId: driver.user_id, 
        billable: 0, 
        nonBillable: 0 
      });
    }
  });
  metrics.driverData = Array.from(uniqueDriverMap.values());

  // --- HELPER FUNCTIONS FOR METRICS ---
  
  // Check if delivery is a return (exclude from most counts)
  const isReturn = (d) => {
    if (!d) return false;
    const notes = (d.delivery_notes || '');
    const patientName = (d.patient_name || '');
    if (notes.toLowerCase().includes('(rtn)') || patientName.toLowerCase().includes('(rtn)')) return true;
    const returnRegex = /\breturn\b/i;
    return returnRegex.test(notes) || returnRegex.test(patientName);
  };
  
  // Deliveries that are billable: completed/failed patient deliveries (excluding returns), completed/cancelled after-hours
  const isCompletedPatientDelivery = (d) => {
    if (!d) return false;
    if (d.status !== 'completed') return false;
    if (isReturn(d)) return false;
    return d.patient_id;
  };
  
  const isFailedPatientDelivery = (d) => {
    if (!d) return false;
    if (d.status !== 'failed') return false;
    if (isReturn(d)) return false;
    return d.patient_id;
  };
  
  const isCompletedAfterHoursPickup = (d) => {
    if (!d) return false;
    return d.after_hours_pickup && d.status === 'completed';
  };
  
  const isCancelledAfterHoursPickup = (d) => {
    if (!d) return false;
    return d.after_hours_pickup && d.status === 'cancelled';
  };
  
  // Store breakdown: include returns but separate out after-hours
  const isCompletedPatientForStore = (d) => {
    if (!d) return false;
    if (d.status !== 'completed') return false;
    return d.patient_id; // Include returns
  };
  
  const isFailedPatientForStore = (d) => {
    if (!d) return false;
    if (d.status !== 'failed') return false;
    return d.patient_id; // Include returns
  };
  
  // Check if store pays fees
  const storePaysFees = (storeId) => {
    const store = storeMap.get(storeId);
    return store?.pays_app_fees === true;
  };

  const storeMonthlyFees = new Map();
  const storesPayingFeesSet = new Set();

  for (const delivery of relevantDeliveries) {
    const date = new Date(delivery.delivery_date);
    const monthIndex = date.getMonth();
    const dayOfMonth = date.getDate();
    const store = delivery.store_id ? storeMap.get(delivery.store_id) : null;

    // --- MONTHLY DELIVERIES & DRIVER BREAKDOWN ---
    // Billable = Completed + Failed patient deliveries (excluding returns) + all returns (patient) + after-hours (completed/cancelled)
    // Non-Billable = same from stores that DON'T pay fees
    const isBillableDelivery = (d) => {
      if (!d) return false;
      // After-hours pickups (completed or cancelled) are billable
      if (isCompletedAfterHoursPickup(d) || isCancelledAfterHoursPickup(d)) return true;
      // Patient deliveries (completed, failed, or returns)
      if (d.patient_id && (isCompletedPatientDelivery(d) || isFailedPatientDelivery(d) || isReturn(d))) return true;
      return false;
    };
    
    if (isBillableDelivery(delivery)) {
      metrics.monthlyData[monthIndex].total++;
      if (store?.pays_app_fees) {
        metrics.monthlyData[monthIndex].billable++;
        metrics.yearTotals.billable++;
      } else {
        metrics.monthlyData[monthIndex].nonBillable++;
        metrics.yearTotals.nonBillable++;
      }
      
      // Daily delivery data (for Monthly Deliveries chart when month is selected)
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

      // Driver data
      if (delivery.driver_id) {
        const driverAppUser = appUserMap.get(delivery.driver_id);
        const driverName = driverAppUser?.user_name || driverAppUser?.full_name || 'Unknown Driver';
        
        // Create annual driver entry if it doesn't exist
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

        // Daily driver data for selected month (for day-by-day breakdown)
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

    // --- STORE BREAKDOWN ---
    // Completed = Patient deliveries (completed status, includes returns)
    // Failed = Patient deliveries (failed status, includes returns)
    // After Hours = After-hours pickups (completed or cancelled)
    if (delivery.store_id && store) {
      const storeAbbr = store.abbreviation;
      if (storeAbbr) {
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
            abbreviation: storeAbbr, 
            name: store.name, 
            storeId: delivery.store_id, 
            completed: 0, 
            failed: 0, 
            afterHours: 0, 
            color: store.color, 
            sortOrder: store.sort_order 
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

         // Add extra_km for patient deliveries
         if (delivery.patient_id && (isCompletedPatientForStore(delivery) || isFailedPatientForStore(delivery))) {
           dailyStoreEntry.extra_km += calculateExtraKm(delivery, patients);
         }

        // --- APP FEES ---
        // Fees apply only for stores with pays_app_fees and only for completed + failed + returns (patient/after-hours)
        if (store.pays_app_fees && appFeeRate > 0) {
          storesPayingFeesSet.add(store.id);
          if (isBillableDelivery(delivery)) {
            if (!storeMonthlyFees.has(store.id)) storeMonthlyFees.set(store.id, Array(12).fill(0));
            const feesByMonth = storeMonthlyFees.get(store.id);
            feesByMonth[monthIndex] += appFeeRate;
            metrics.storeFeeTotals.monthlyFees[monthIndex] += appFeeRate;
            metrics.storeFeeTotals.total_fees_owed += appFeeRate;
            metrics.storeFeeTotals.total_billable_while_paying++;
          }
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
          metrics.monthlyStoreData[m + 1].push({
            ...existingEntry,
            fees: monthlyFeesArray[m]
          });
        } else {
          metrics.monthlyStoreData[m + 1].push({
            abbreviation: store.abbreviation,
            name: store.name,
            storeId: store.id,
            fees: monthlyFeesArray[m],
            completed: 0,
            color: store.color,
            sortOrder: store.sort_order
          });
        }
      }
    }
  }

  // Add stores without fees
  for (let m = 1; m <= 12; m++) {
    const existingStores = new Set(metrics.monthlyStoreData[m]?.map(s => s.storeId) || []);
    const monthStoreData = metrics.storeDataByMonth[m] || [];
    monthStoreData.forEach(storeData => {
      if (!existingStores.has(storeData.storeId)) {
        if (!metrics.monthlyStoreData[m]) metrics.monthlyStoreData[m] = [];
        metrics.monthlyStoreData[m].push({
          ...storeData,
          fees: 0
        });
      }
    });
  }
  
  metrics.storeFeeTotals.stores_paying_fees = storesPayingFeesSet.size;
  metrics.yearTotals.activeDrivers = new Set(
    appUsers.filter(au => au.app_roles && au.app_roles.includes('driver') && au.status === 'active').map(au => au.user_id)
  ).size;

  return metrics;
}

// Helper to calculate Envelope metrics from delivery_notes (driver notes)
function calculateEnvelopeMetrics(deliveries, stores) {
  const envelopeMetrics = {
    byStoreAndMonth: {},
    yearTotals: { 
      envelopeDeliveriesCount: 0,
      totalEnvelopeValue: 0,
      adjustedDeliveries: 0,
      actualDeliveries: 0
    }
  };

  // Regex to find 1-2 digit number immediately before "Envelope" (case insensitive)
  const envelopeRegex = /(\d{1,2})\s*Envelope/i;

  for (const delivery of deliveries) {
    if (!delivery || !delivery.delivery_date || !delivery.store_id) continue;
    
    const date = new Date(delivery.delivery_date);
    const month = date.getMonth() + 1;
    const storeId = delivery.store_id;

    if (!envelopeMetrics.byStoreAndMonth[storeId]) {
      envelopeMetrics.byStoreAndMonth[storeId] = {};
    }
    if (!envelopeMetrics.byStoreAndMonth[storeId][month]) {
      envelopeMetrics.byStoreAndMonth[storeId][month] = {
        envelopeDeliveriesCount: 0,
        totalEnvelopeValue: 0,
        actualDeliveries: 0,
        adjustedDeliveries: 0
      };
    }

    envelopeMetrics.byStoreAndMonth[storeId][month].actualDeliveries++;
    envelopeMetrics.yearTotals.actualDeliveries++;

    // Check delivery_notes (driver notes) for envelope pattern
    const driverNotes = delivery.delivery_notes || '';
    const match = driverNotes.match(envelopeRegex);
    if (match) {
      const envelopeValue = parseInt(match[1], 10);
      if (!isNaN(envelopeValue)) {
        envelopeMetrics.byStoreAndMonth[storeId][month].envelopeDeliveriesCount++;
        envelopeMetrics.byStoreAndMonth[storeId][month].totalEnvelopeValue += envelopeValue;
        envelopeMetrics.yearTotals.envelopeDeliveriesCount++;
        envelopeMetrics.yearTotals.totalEnvelopeValue += envelopeValue;
      }
    }
  }
  
  // Calculate adjusted deliveries: Actual - EnvelopeCount + EnvelopeValue
  for (const storeId in envelopeMetrics.byStoreAndMonth) {
    for (const month in envelopeMetrics.byStoreAndMonth[storeId]) {
      const monthData = envelopeMetrics.byStoreAndMonth[storeId][month];
      monthData.adjustedDeliveries = monthData.actualDeliveries - monthData.envelopeDeliveriesCount + monthData.totalEnvelopeValue;
    }
  }
  envelopeMetrics.yearTotals.adjustedDeliveries = 
    envelopeMetrics.yearTotals.actualDeliveries - 
    envelopeMetrics.yearTotals.envelopeDeliveriesCount + 
    envelopeMetrics.yearTotals.totalEnvelopeValue;

  return envelopeMetrics;
}