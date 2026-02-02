import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

// In-memory cache for expensive stats
const statsCache = {
  adminMetrics: { data: null, cacheDate: '', key: '' },
  payrollData: { data: null, cacheDate: '', key: '' }
};

const REFRESH_HOUR_UTC = 11; // 4 AM Mountain (UTC-7) = 11:00 UTC

const getCacheDateKey = () => {
  const now = new Date();
  const utcHour = now.getUTCHours();
  if (utcHour < REFRESH_HOUR_UTC) {
    const yesterday = new Date(now);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    return yesterday.toISOString().split('T')[0];
  }
  return now.toISOString().split('T')[0];
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
      payrollYear, payrollCityId, payrollDriverId
    } = body;

    const cacheDate = getCacheDateKey();

    const fetchAdminMetrics = async (year, cityId) => {
      const metricsKey = `admin_${year}_${cityId}`;
      if (statsCache.adminMetrics.key === metricsKey && statsCache.adminMetrics.cacheDate === cacheDate) {
        console.log('📊 Using CACHED AdminMetrics');
        return statsCache.adminMetrics.data;
      }

      let storeFilter = {};
      if (cityId && cityId !== 'all') {
        const cityStores = await base44.asServiceRole.entities.Store.filter({ city_id: cityId });
        storeFilter = { store_id: { $in: cityStores.map(s => s.id) } };
      }

      const deliveries = await base44.asServiceRole.entities.Delivery.filter({
        delivery_date: { $gte: `${year}-01-01`, $lte: `${year}-12-31` },
        ...storeFilter
      });

      const stores = await base44.asServiceRole.entities.Store.list();
      const appUsers = await base44.asServiceRole.entities.AppUser.list();
      const patients = await base44.asServiceRole.entities.Patient.list();
      const appSettings = await base44.asServiceRole.entities.AppSettings.filter({ setting_key: 'refresh_intervals' });
      const appFeeRate = parseFloat(appSettings[0]?.setting_value?.app_fees_per_delivery) || 0;
      console.log('📊 [AdminMetrics] App Fee Rate:', appFeeRate);

      const metrics = processAdminMetrics(deliveries, stores, appUsers, patients, year, appFeeRate);
      
      // Add envelope metrics - checks delivery_notes (driver notes)
      const envelopeMetrics = calculateEnvelopeMetrics(deliveries, stores);
      metrics.envelopeMetrics = envelopeMetrics;

      statsCache.adminMetrics = { data: metrics, cacheDate, key: metricsKey };
      return metrics;
    };

    const fetchPayrollData = async (year, cityId, driverId) => {
      const payrollKey = `payroll_${year}_${cityId}_${driverId}`;
      if (statsCache.payrollData.key === payrollKey && statsCache.payrollData.cacheDate === cacheDate) {
        console.log('📊 Using CACHED PayrollData');
        return statsCache.payrollData.data;
      }

      let storeFilter = {};
      if (cityId && cityId !== 'all') {
        const cityStores = await base44.asServiceRole.entities.Store.filter({ city_id: cityId });
        storeFilter = { store_id: { $in: cityStores.map(s => s.id) } };
      }

      const payrollDeliveries = await base44.asServiceRole.entities.Delivery.filter({
        delivery_date: { $gte: `${year}-01-01`, $lte: `${year}-12-31` },
        ...storeFilter,
        ...(driverId && driverId !== 'all' ? { driver_id: driverId } : {})
      });

      const payrollPatients = await base44.asServiceRole.entities.Patient.list();
      const payrollAppUsers = await base44.asServiceRole.entities.AppUser.list();
      const payrollDrivers = payrollAppUsers.filter(au => au.app_roles && au.app_roles.includes('driver'));
      const payrollStores = await base44.asServiceRole.entities.Store.list();
      const payrollCities = await base44.asServiceRole.entities.City.list();

      const payrollData = {
        deliveries: payrollDeliveries,
        patients: payrollPatients,
        appUsers: payrollAppUsers,
        drivers: payrollDrivers,
        stores: payrollStores,
        cities: payrollCities
      };

      statsCache.payrollData = { data: payrollData, cacheDate, key: payrollKey };
      return payrollData;
    };

    const [adminMetrics, payrollData] = await Promise.all([
      adminMetricsYear ? fetchAdminMetrics(adminMetricsYear, adminMetricsCityId) : Promise.resolve(null),
      payrollYear ? fetchPayrollData(payrollYear, payrollCityId, payrollDriverId) : Promise.resolve(null)
    ]);
    
    return Response.json({
      adminMetrics,
      payrollData
    });

  } catch (error) {
    console.error('❌ CRITICAL ERROR in getAdminMetricsAndPayrollData:', error);
    return Response.json({ error: error.message || 'Unknown error occurred' }, { status: 500 });
  }
});


function processAdminMetrics(deliveries, stores, appUsers, patients, year, appFeeRate) {
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
  
  appUsers.filter(au => au.app_roles && au.app_roles.includes('driver')).forEach(driver => {
    metrics.driverData.push({ 
      name: driver.user_name || driver.full_name, 
      driverId: driver.user_id, 
      billable: 0, 
      nonBillable: 0 
    });
  });

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
  
  // Check if delivery is a completed delivery (status=completed, not a return)
  // INCLUDES after-hours pickups only (not regular store pickups)
  const isCompletedDelivery = (d) => {
    if (!d) return false;
    if (d.status !== 'completed') return false;
    if (isReturn(d)) return false;
    // Must be a patient delivery OR after-hours pickup
    return d.patient_id || d.after_hours_pickup;
  };
  
  // Check if delivery is a failed delivery (status=failed, not a return)
  // INCLUDES after-hours pickups only (not regular store pickups)
  const isFailedDelivery = (d) => {
    if (!d) return false;
    if (isReturn(d)) return false;
    if (d.status !== 'failed') return false;
    // Must be a patient delivery OR after-hours pickup
    return d.patient_id || d.after_hours_pickup;
  };
  
  // For store breakdown: count finished deliveries INCLUDING returns
  // Finished = Completed OR Failed (both include returns) + must be patient/after-hours
  const isFinishedCompletedDelivery = (d) => {
    if (!d) return false;
    if (d.status !== 'completed') return false;
    // Must be a patient delivery OR after-hours pickup (no return exclusion)
    return d.patient_id || d.after_hours_pickup;
  };
  
  const isFinishedFailedDelivery = (d) => {
    if (!d) return false;
    if (d.status !== 'failed') return false;
    // Must be a patient delivery OR after-hours pickup (no return exclusion)
    return d.patient_id || d.after_hours_pickup;
  };
  
  // Check if it's a completed or cancelled after-hours pickup
  const isAfterHoursPickup = (d) => {
    if (!d) return false;
    if (!d.after_hours_pickup) return false;
    return d.status === 'completed' || d.status === 'cancelled';
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
    // Billable = Completed + Failed + Returns (all patient deliveries or after-hours) from stores that pay fees
    //           + After Hours Pickups (Completed & Cancelled)
    // Non-Billable = Completed + Failed + Returns (all patient deliveries or after-hours) from stores that DON'T pay fees
    const isBillableDelivery = (d) => {
      if (!d) return false;
      // After-hours pickups (completed or cancelled) are billable
      if (d.after_hours_pickup && (d.status === 'completed' || d.status === 'cancelled')) return true;
      // Regular patient deliveries (completed, failed, or returns)
      if (d.patient_id && (d.status === 'completed' || d.status === 'failed' || isReturn(d))) return true;
      return false;
    };
    
    if (isBillableDelivery(delivery)) {
      metrics.monthlyData[monthIndex].total++;
      if (store?.pays_app_fees) {
        metrics.monthlyData[monthIndex].billable++;
      } else {
        metrics.monthlyData[monthIndex].nonBillable++;
      }
      metrics.yearTotals.billable++;
      
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
    // Completed = Finished Completed + After Hours Completed/Cancelled (includes returns)
    // Failed = Finished Failed (includes returns)
    if (delivery.store_id && store) {
      const storeAbbr = store.abbreviation;
      if (storeAbbr) {
        const annualStoreEntry = metrics.storeData.find(s => s.storeId === delivery.store_id);
        if (annualStoreEntry) {
          if (isFinishedCompletedDelivery(delivery)) annualStoreEntry.completed++;
          if (isFinishedFailedDelivery(delivery)) annualStoreEntry.failed++;
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
        if (isFinishedCompletedDelivery(delivery)) monthlyStoreEntry.completed++;
        if (isFinishedFailedDelivery(delivery)) monthlyStoreEntry.failed++;

        if (!metrics.dailyStoreData[monthIndex + 1]) metrics.dailyStoreData[monthIndex + 1] = {};
        if (!metrics.dailyStoreData[monthIndex + 1][delivery.store_id]) metrics.dailyStoreData[monthIndex + 1][delivery.store_id] = [];
        let dailyStoreEntry = metrics.dailyStoreData[monthIndex + 1][delivery.store_id].find(d => d.day === dayOfMonth);
        if (!dailyStoreEntry) {
          dailyStoreEntry = { day: dayOfMonth, completed: 0, failed: 0, afterHours: 0 };
          metrics.dailyStoreData[monthIndex + 1][delivery.store_id].push(dailyStoreEntry);
        }
        if (isFinishedCompletedDelivery(delivery)) dailyStoreEntry.completed++;
        if (isFinishedFailedDelivery(delivery)) dailyStoreEntry.failed++;

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