import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

/**
 * Get Admin Metrics - Pre-computed metrics for the Admin Metrics page
 * Returns all chart data, totals, and store fees in a single call
 */

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// In-memory cache (survives across requests in same Deno isolate)
const metricsCache = {
  data: null,
  year: null,
  cacheDate: null
};

const getCacheDateKey = () => new Date().toISOString().split('T')[0];

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    
    const user = await base44.auth.me();
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Check if user is admin/app owner
    const appUsers = await base44.asServiceRole.entities.AppUser.filter({ user_id: user.id });
    const appUser = appUsers?.[0];
    const userRoles = Array.isArray(appUser?.app_roles) ? appUser.app_roles : [];
    const isAdmin = userRoles.includes('admin');

    if (!isAdmin) {
      return Response.json({ error: 'Admin access required' }, { status: 403 });
    }

    // Parse request
    let body = {};
    try {
      const text = await req.text();
      if (text) body = JSON.parse(text);
    } catch (e) {}

    const year = body.year || new Date().getFullYear();
    const cityId = body.cityId || null; // null = all cities
    const cacheKey = `${year}-${cityId || 'all'}`;
    const cacheDate = getCacheDateKey();

    // Check cache
    if (metricsCache.year === cacheKey && metricsCache.cacheDate === cacheDate && metricsCache.data) {
      console.log('📊 [getAdminMetrics] Returning CACHED data');
      return Response.json(metricsCache.data);
    }

    console.log(`📊 [getAdminMetrics] Computing metrics for year ${year}, city ${cityId || 'all'}...`);

    // Fetch all data in parallel
    const [allStores, allAppUsers, appSettings] = await Promise.all([
      base44.asServiceRole.entities.Store.list(),
      base44.asServiceRole.entities.AppUser.list(),
      base44.asServiceRole.entities.AppSettings.filter({ setting_key: 'refresh_intervals' })
    ]);

    // Filter stores by city if cityId is specified (for display filtering)
    const cityStores = cityId 
      ? allStores.filter(s => s?.city_id === cityId)
      : allStores;
    
    // Get store IDs for filtering deliveries
    const cityStoreIds = new Set(cityStores.map(s => s?.id).filter(Boolean));
    
    // Keep ALL stores available for lookups (deliveries may have stores from other cities)
    const allStoresMap = new Map(allStores.map(s => [s?.id, s]).filter(([id]) => id));

    // Get app fee rate
    let appFeeRate = 0;
    if (appSettings?.[0]?.setting_value?.app_fees_per_delivery) {
      appFeeRate = parseFloat(appSettings[0].setting_value.app_fees_per_delivery) || 0;
    }

    // Fetch all deliveries for the year (in monthly chunks to avoid limits)
    const monthPromises = [];
    for (let month = 1; month <= 12; month++) {
      const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
      const monthEndDate = new Date(year, month, 0);
      const monthEnd = `${year}-${String(month).padStart(2, '0')}-${String(monthEndDate.getDate()).padStart(2, '0')}`;
      
      monthPromises.push(
        base44.asServiceRole.entities.Delivery.filter({
          delivery_date: { $gte: monthStart, $lte: monthEnd }
        })
      );
    }

    const monthResults = await Promise.all(monthPromises);
    let yearDeliveries = monthResults.flat();

    // Filter deliveries by city (via store) - only if cityId is specified
    if (cityId) {
      yearDeliveries = yearDeliveries.filter(d => d?.store_id && cityStoreIds.has(d.store_id));
    }

    console.log(`📦 [getAdminMetrics] Loaded ${yearDeliveries.length} deliveries for ${year} (city: ${cityId || 'all'})`);

    // Build list of stores to show in the grid
    // Show: all ACTIVE stores in city + any INACTIVE stores that have delivery data
    const storeIdsInDeliveries = new Set(yearDeliveries.map(d => d?.store_id).filter(Boolean));
    
    let storesForGrid;
    if (cityId) {
      // Active stores in city + inactive stores with delivery data
      const activeStoresInCity = cityStores.filter(s => s?.status !== 'inactive');
      const inactiveStoresWithData = cityStores.filter(s => 
        s?.status === 'inactive' && storeIdsInDeliveries.has(s.id)
      );
      storesForGrid = [...activeStoresInCity, ...inactiveStoresWithData]
        .sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity));
    } else {
      // No city filter - active stores + inactive stores with delivery data
      const activeStores = allStores.filter(s => s?.status !== 'inactive');
      const inactiveStoresWithData = allStores.filter(s => 
        s?.status === 'inactive' && storeIdsInDeliveries.has(s.id)
      );
      storesForGrid = [...activeStores, ...inactiveStoresWithData]
        .sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity));
    }

    // Helper: Check if store was paying fees on date
    const wasPayingFeesOnDate = (store, dateStr) => {
      if (!store.app_fee_history || store.app_fee_history.length === 0) {
        return store.pays_app_fees || false;
      }
      const sorted = [...store.app_fee_history].sort((a, b) => 
        new Date(a.effective_date) - new Date(b.effective_date)
      );
      let paying = false;
      for (const entry of sorted) {
        if (entry.effective_date <= dateStr) paying = entry.pays_app_fees;
        else break;
      }
      return paying;
    };

    // Helper: Check if delivery is billable
    // Billable = Completed, Failed, and After Hours Pickups (Completed or Cancelled)
    const isBillable = (d) => {
      if (!d) return false;
      // Patient deliveries: completed or failed
      if (d.patient_id && (d.status === 'completed' || d.status === 'failed')) return true;
      // After hours pickups (no patient_id): completed or cancelled
      if (!d.patient_id && d.after_hours_pickup && (d.status === 'completed' || d.status === 'cancelled')) return true;
      return false;
    };

    // Helper: Check if delivery should be counted (completed, failed, or after-hours pickup)
    const shouldCount = (d) => {
      if (!d) return false;
      // Patient deliveries: completed or failed
      if (d.patient_id && (d.status === 'completed' || d.status === 'failed')) return true;
      // After hours pickups: completed or cancelled
      if (!d.patient_id && d.after_hours_pickup && (d.status === 'completed' || d.status === 'cancelled')) return true;
      return false;
    };

    // Build monthly data
    const monthlyData = [];
    const monthlyStoreFeeTotals = Array(12).fill(0);

    for (let month = 1; month <= 12; month++) {
      const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
      const monthEndDate = new Date(year, month, 0);
      const monthEnd = monthEndDate.toISOString().split('T')[0];

      const monthDeliveries = yearDeliveries.filter(d => {
        if (!d?.delivery_date) return false;
        return d.delivery_date >= monthStart && d.delivery_date <= monthEnd;
      });

      // Count billable vs non-billable
      let billable = 0;
      let nonBillable = 0;
      let monthFees = 0;

      monthDeliveries.forEach(d => {
        // Include patient deliveries AND after-hours pickups
        const isPatientDelivery = !!d.patient_id;
        const isAfterHoursPickup = !d.patient_id && d.after_hours_pickup;
        
        if (!isPatientDelivery && !isAfterHoursPickup) return; // Skip regular pickups
        
        if (isBillable(d)) {
          // Use allStoresMap to find store (handles transferred deliveries from other cities)
          const store = allStoresMap.get(d.store_id);
          if (store && wasPayingFeesOnDate(store, d.delivery_date)) {
            billable++;
            monthFees += appFeeRate;
          } else {
            nonBillable++;
          }
        } else {
          nonBillable++;
        }
      });

      monthlyStoreFeeTotals[month - 1] = monthFees;

      monthlyData.push({
        month: MONTH_NAMES[month - 1],
        monthNum: month,
        billable,
        nonBillable,
        total: billable + nonBillable
      });
    }

    // Build driver performance data (12-month view) - billable vs non-billable
    const driverMonthlyMapBillable = {};
    const driverMonthlyMapNonBillable = {};
    const driverTotals = {};
    const drivers = allAppUsers.filter(u => u?.app_roles?.includes('driver') && u.status === 'active');

    yearDeliveries.forEach(d => {
      if (!d.driver_id || !d.patient_id) return;
      if (!d.delivery_date) return;

      const month = parseInt(d.delivery_date.split('-')[1]);
      const driver = drivers.find(dr => dr?.user_id === d.driver_id);
      const driverName = driver?.user_name || d.driver_name || 'Unknown';

      if (!driverMonthlyMapBillable[month]) {
        driverMonthlyMapBillable[month] = {};
        driverMonthlyMapNonBillable[month] = {};
      }

      // Check if billable and store was paying fees - use allStoresMap for lookups
      const store = allStoresMap.get(d.store_id);
      const isBillableDelivery = isBillable(d) && store && wasPayingFeesOnDate(store, d.delivery_date);

      if (isBillableDelivery) {
        driverMonthlyMapBillable[month][driverName] = (driverMonthlyMapBillable[month][driverName] || 0) + 1;
      } else {
        driverMonthlyMapNonBillable[month][driverName] = (driverMonthlyMapNonBillable[month][driverName] || 0) + 1;
      }
      driverTotals[driverName] = (driverTotals[driverName] || 0) + 1;
    });

    // Top 8 drivers by total
    const topDriverNames = Object.entries(driverTotals)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name]) => name);

    const driverMonthlyData = [];
    for (let m = 1; m <= 12; m++) {
      const monthData = { month: MONTH_NAMES[m - 1] };
      let monthBillable = 0;
      let monthNonBillable = 0;
      topDriverNames.forEach(name => {
        monthBillable += driverMonthlyMapBillable[m]?.[name] || 0;
        monthNonBillable += driverMonthlyMapNonBillable[m]?.[name] || 0;
      });
      monthData.billable = monthBillable;
      monthData.nonBillable = monthNonBillable;
      driverMonthlyData.push(monthData);
    }

    // Build driver breakdown data (billable vs non-billable per driver) - full year and by month
    const driverStats = {}; // { driverId: { name, billable, nonBillable } }
    const driverStatsByMonth = {}; // { monthNum: { driverId: stats } }
    
    for (let m = 1; m <= 12; m++) {
      driverStatsByMonth[m] = {};
    }

    yearDeliveries.forEach(d => {
      if (!d.driver_id || !d.patient_id) return;
      
      const month = d.delivery_date ? parseInt(d.delivery_date.split('-')[1]) : null;
      const driver = drivers.find(dr => dr?.user_id === d.driver_id);
      const driverName = driver?.user_name || d.driver_name || 'Unknown';
      
      // Use allStoresMap for lookups
      const store = allStoresMap.get(d.store_id);
      const isBillableDelivery = isBillable(d) && store && wasPayingFeesOnDate(store, d.delivery_date);
      
      // Year total
      if (!driverStats[d.driver_id]) {
        driverStats[d.driver_id] = { name: driverName, billable: 0, nonBillable: 0 };
      }
      if (isBillableDelivery) {
        driverStats[d.driver_id].billable++;
      } else {
        driverStats[d.driver_id].nonBillable++;
      }
      
      // By month
      if (month && month >= 1 && month <= 12) {
        if (!driverStatsByMonth[month][d.driver_id]) {
          driverStatsByMonth[month][d.driver_id] = { name: driverName, billable: 0, nonBillable: 0 };
        }
        if (isBillableDelivery) {
          driverStatsByMonth[month][d.driver_id].billable++;
        } else {
          driverStatsByMonth[month][d.driver_id].nonBillable++;
        }
      }
    });

    // Sort by total deliveries descending
    const driverData = Object.values(driverStats)
      .sort((a, b) => (b.billable + b.nonBillable) - (a.billable + a.nonBillable));
    
    // Convert monthly driver stats to sorted arrays
    const driverDataByMonth = {};
    for (let m = 1; m <= 12; m++) {
      driverDataByMonth[m] = Object.values(driverStatsByMonth[m])
        .sort((a, b) => (b.billable + b.nonBillable) - (a.billable + a.nonBillable));
    }

    // Store breakdown (full year + by month) - completed vs failed (not billable filtering for this chart)
    // Initialize all stores in the city with 0 counts first (so all stores appear in charts)
    const storeStats = {};
    const storeStatsByMonth = {}; // { monthNum: { storeId: stats } }
    
    for (let m = 1; m <= 12; m++) {
      storeStatsByMonth[m] = {};
    }

    // Pre-populate with storesForGrid (active stores + inactive stores with data)
    storesForGrid.forEach(store => {
      if (!store?.id) return;
      storeStats[store.id] = {
        name: store.name || 'Unknown',
        abbreviation: store.abbreviation || '',
        sortOrder: store.sort_order ?? Infinity,
        completed: 0,
        failed: 0
      };
      for (let m = 1; m <= 12; m++) {
        storeStatsByMonth[m][store.id] = {
          name: store.name || 'Unknown',
          abbreviation: store.abbreviation || '',
          sortOrder: store.sort_order ?? Infinity,
          completed: 0,
          failed: 0
        };
      }
    });

    yearDeliveries.forEach(d => {
      if (!d.store_id || !d.patient_id) return;
      
      const month = d.delivery_date ? parseInt(d.delivery_date.split('-')[1]) : null;
      
      // Use allStoresMap for lookups
      const store = allStoresMap.get(d.store_id);
      
      // Year total
      if (!storeStats[d.store_id]) {
        storeStats[d.store_id] = {
          name: store?.name || 'Unknown',
          abbreviation: store?.abbreviation || '',
          sortOrder: store?.sort_order ?? Infinity,
          completed: 0,
          failed: 0
        };
      }
      if (d.status === 'completed') storeStats[d.store_id].completed++;
      else if (d.status === 'failed') storeStats[d.store_id].failed++;
      
      // By month
      if (month && month >= 1 && month <= 12) {
        if (!storeStatsByMonth[month][d.store_id]) {
          storeStatsByMonth[month][d.store_id] = {
            name: store?.name || 'Unknown',
            abbreviation: store?.abbreviation || '',
            sortOrder: store?.sort_order ?? Infinity,
            completed: 0,
            failed: 0
          };
        }
        if (d.status === 'completed') storeStatsByMonth[month][d.store_id].completed++;
        else if (d.status === 'failed') storeStatsByMonth[month][d.store_id].failed++;
      }
    });

    const storeData = Object.values(storeStats).sort((a, b) => a.sortOrder - b.sortOrder);
    
    // Convert monthly store stats to sorted arrays
    const storeDataByMonth = {};
    for (let m = 1; m <= 12; m++) {
      storeDataByMonth[m] = Object.values(storeStatsByMonth[m]).sort((a, b) => a.sortOrder - b.sortOrder);
    }
    
    // Build daily store data for day-by-day breakdown
    // { monthNum: { storeId: [{ day: 1, completed: X, failed: Y }, ...] } }
    const dailyStoreData = {};
    for (let m = 1; m <= 12; m++) {
      dailyStoreData[m] = {};
      const daysInMonth = new Date(year, m, 0).getDate();
      
      storesForGrid.forEach(store => {
        if (!store?.id) return;
        dailyStoreData[m][store.id] = [];
        
        for (let d = 1; d <= daysInMonth; d++) {
          dailyStoreData[m][store.id].push({
            day: d,
            completed: 0,
            failed: 0
          });
        }
      });
    }
    
    // Populate daily data
    yearDeliveries.forEach(d => {
      if (!d.store_id || !d.patient_id || !d.delivery_date) return;
      
      const month = parseInt(d.delivery_date.split('-')[1]);
      const day = parseInt(d.delivery_date.split('-')[2]);
      
      if (!dailyStoreData[month]?.[d.store_id]) return;
      
      const dayData = dailyStoreData[month][d.store_id].find(dd => dd.day === day);
      if (dayData) {
        if (d.status === 'completed') dayData.completed++;
        else if (d.status === 'failed') dayData.failed++;
      }
    });
    
    // Build daily delivery data for Monthly Deliveries chart (all stores combined)
    // { monthNum: [{ day: 1, billable: X, nonBillable: Y }, ...] }
    const dailyDeliveryData = {};
    for (let m = 1; m <= 12; m++) {
      const daysInMonth = new Date(year, m, 0).getDate();
      dailyDeliveryData[m] = [];
      
      for (let d = 1; d <= daysInMonth; d++) {
        dailyDeliveryData[m].push({
          day: d,
          billable: 0,
          nonBillable: 0
        });
      }
    }
    
    // Populate daily delivery data
    yearDeliveries.forEach(d => {
      if (!d.patient_id || !d.delivery_date || d.status !== 'completed') return;
      
      const month = parseInt(d.delivery_date.split('-')[1]);
      const day = parseInt(d.delivery_date.split('-')[2]);
      
      // Use allStoresMap to check billable status
      const store = allStoresMap.get(d.store_id);
      const isBillableDelivery = isBillable(d) && store && wasPayingFeesOnDate(store, d.delivery_date);
      
      const dayData = dailyDeliveryData[month]?.find(dd => dd.day === day);
      if (dayData) {
        if (isBillableDelivery) {
          dayData.billable++;
        } else {
          dayData.nonBillable++;
        }
      }
    });
    
    // Build driver name map for lookups
    const driverNameMap = {};
    drivers.forEach(driver => {
      if (driver?.user_id) {
        driverNameMap[driver.user_id] = driver.user_name || 'Unknown';
      }
    });
    
    // Build driver data by store (for store-month selection)
    // { storeId: [{ name: 'Driver A', billable: X, nonBillable: Y }, ...] }
    const driverDataByStore = {};
    storesForGrid.forEach(store => {
      if (!store?.id) return;
      driverDataByStore[store.id] = {};
    });
    
    yearDeliveries.forEach(d => {
      if (!d.driver_id || !d.patient_id || !d.store_id || d.status !== 'completed') return;
      
      if (!driverDataByStore[d.store_id]) return;
      
      const driverName = driverNameMap[d.driver_id] || d.driver_name || 'Unknown';
      if (!driverDataByStore[d.store_id][d.driver_id]) {
        driverDataByStore[d.store_id][d.driver_id] = {
          name: driverName,
          billable: 0,
          nonBillable: 0
        };
      }
      
      // Use allStoresMap to check billable status
      const store = allStoresMap.get(d.store_id);
      const isBillableDelivery = isBillable(d) && store && wasPayingFeesOnDate(store, d.delivery_date);
      
      if (isBillableDelivery) {
        driverDataByStore[d.store_id][d.driver_id].billable++;
      } else {
        driverDataByStore[d.store_id][d.driver_id].nonBillable++;
      }
    });
    
    // Convert to arrays and sort
    Object.keys(driverDataByStore).forEach(storeId => {
      driverDataByStore[storeId] = Object.values(driverDataByStore[storeId])
        .sort((a, b) => (b.billable + b.nonBillable) - (a.billable + a.nonBillable));
    });
    
    // Build monthly store data for the grid (deliveries per store per month + fees)
    const monthlyStoreData = {};
    const monthlyStoreFees = {};
    
    for (let m = 1; m <= 12; m++) {
      monthlyStoreData[m] = [];
      monthlyStoreFees[m] = [];
      
      const monthStart = `${year}-${String(m).padStart(2, '0')}-01`;
      const monthEndDate = new Date(year, m, 0);
      const monthEnd = monthEndDate.toISOString().split('T')[0];
      
      storesForGrid.forEach(store => {
        if (!store) return;
        
        // Count deliveries for this store in this month (completed, failed, after-hours pickups)
        const storeMonthDeliveries = yearDeliveries.filter(d => 
          d?.store_id === store.id && 
          d?.delivery_date >= monthStart && 
          d?.delivery_date <= monthEnd &&
          shouldCount(d)
        );
        
        // Calculate fees for billable deliveries where store was paying fees
        let storeFees = 0;
        storeMonthDeliveries.forEach(d => {
          if (isBillable(d) && wasPayingFeesOnDate(store, d.delivery_date)) {
            storeFees += appFeeRate;
          }
        });
        
        monthlyStoreData[m].push({
          id: store.id, // Include store ID for click handling
          name: store.name || 'Unknown',
          abbreviation: store.abbreviation || '',
          color: store.color || '#64748b',
          sortOrder: store.sort_order ?? Infinity,
          completed: storeMonthDeliveries.length, // Now includes failed + after-hours
          fees: storeFees
        });
      });
      
      // Sort by sort_order
      monthlyStoreData[m].sort((a, b) => a.sortOrder - b.sortOrder);
    }

    // Year totals - billable vs non-billable
    let yearBillable = 0;
    let yearNonBillable = 0;
    yearDeliveries.forEach(d => {
      const isPatientDelivery = !!d.patient_id;
      const isAfterHoursPickup = !d.patient_id && d.after_hours_pickup;
      if (!isPatientDelivery && !isAfterHoursPickup) return;
      
      // Use allStoresMap for lookups
      const store = allStoresMap.get(d.store_id);
      if (isBillable(d) && store && wasPayingFeesOnDate(store, d.delivery_date)) {
        yearBillable++;
      } else {
        yearNonBillable++;
      }
    });
    const yearTotalFees = monthlyStoreFeeTotals.reduce((sum, f) => sum + f, 0);

    // Store fee metrics summary - use storesForGrid for accurate counts
    const storesPayingFees = storesForGrid.filter(s => s.pays_app_fees).length;
    const totalBillableWhilePaying = yearDeliveries.filter(d => {
      if (!isBillable(d)) return false;
      const store = allStoresMap.get(d.store_id);
      return store && wasPayingFeesOnDate(store, d.delivery_date);
    }).length;

    const response = {
      year,
      monthlyData,
      driverMonthlyData,
      driverData,
      driverDataByMonth,
      driverNames: topDriverNames,
      storeData,
      storeDataByMonth,
      dailyStoreData,      // NEW: For day-by-day store breakdown
      dailyDeliveryData,   // NEW: For daily breakdown in Monthly Deliveries chart
      driverDataByStore,   // NEW: For driver breakdown by store
      monthlyStoreData,    // NEW: For monthly store deliveries grid
      monthlyStoreFees,    // NEW: For monthly store fees grid
      yearTotals: {
        billable: yearBillable,
        nonBillable: yearNonBillable,
        total: yearBillable + yearNonBillable,
        activeDrivers: new Set(yearDeliveries.filter(d => d.driver_id).map(d => d.driver_id)).size
      },
      storeFeeTotals: {
        total_fees_owed: yearTotalFees,
        stores_paying_fees: storesPayingFees,
        total_stores: storesForGrid.length,
        total_billable_while_paying: totalBillableWhilePaying,
        app_fee_rate: appFeeRate,
        monthlyFees: monthlyStoreFeeTotals
      }
    };

    // Cache the result
    metricsCache.data = response;
    metricsCache.year = cacheKey;
    metricsCache.cacheDate = cacheDate;

    console.log('✅ [getAdminMetrics] Metrics computed and cached');
    return Response.json(response);

  } catch (error) {
    console.error('❌ Error in getAdminMetrics:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});