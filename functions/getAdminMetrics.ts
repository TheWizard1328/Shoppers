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
    const cacheDate = getCacheDateKey();

    // Check cache
    if (metricsCache.year === year && metricsCache.cacheDate === cacheDate && metricsCache.data) {
      console.log('📊 [getAdminMetrics] Returning CACHED data');
      return Response.json(metricsCache.data);
    }

    console.log(`📊 [getAdminMetrics] Computing metrics for year ${year}...`);

    // Fetch all data in parallel
    const [stores, allAppUsers, appSettings] = await Promise.all([
      base44.asServiceRole.entities.Store.list(),
      base44.asServiceRole.entities.AppUser.list(),
      base44.asServiceRole.entities.AppSettings.filter({ setting_key: 'refresh_intervals' })
    ]);

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
    const yearDeliveries = monthResults.flat();

    console.log(`📦 [getAdminMetrics] Loaded ${yearDeliveries.length} deliveries for ${year}`);

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
    const isBillable = (d) => {
      if (!d) return false;
      if (d.patient_id && (d.status === 'completed' || d.status === 'failed')) return true;
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

      const completed = monthDeliveries.filter(d => d.status === 'completed' && d.patient_id).length;
      const failed = monthDeliveries.filter(d => d.status === 'failed').length;

      // Calculate fees for this month
      let monthFees = 0;
      monthDeliveries.forEach(d => {
        if (!isBillable(d)) return;
        const store = stores.find(s => s?.id === d.store_id);
        if (store && wasPayingFeesOnDate(store, d.delivery_date)) {
          monthFees += appFeeRate;
        }
      });
      monthlyStoreFeeTotals[month - 1] = monthFees;

      monthlyData.push({
        month: MONTH_NAMES[month - 1],
        monthNum: month,
        completed,
        failed,
        total: completed + failed
      });
    }

    // Build driver performance data (12-month view)
    const driverMonthlyMap = {};
    const driverTotals = {};
    const drivers = allAppUsers.filter(u => u?.app_roles?.includes('driver') && u.status === 'active');

    yearDeliveries.forEach(d => {
      if (!d.driver_id || !d.patient_id || d.status !== 'completed') return;
      if (!d.delivery_date) return;

      const month = parseInt(d.delivery_date.split('-')[1]);
      const driver = drivers.find(dr => dr?.user_id === d.driver_id);
      const driverName = driver?.user_name || d.driver_name || 'Unknown';

      if (!driverMonthlyMap[month]) {
        driverMonthlyMap[month] = {};
      }
      driverMonthlyMap[month][driverName] = (driverMonthlyMap[month][driverName] || 0) + 1;
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
      topDriverNames.forEach(name => {
        monthData[name] = driverMonthlyMap[m]?.[name] || 0;
      });
      driverMonthlyData.push(monthData);
    }

    // Build day-by-day driver data for each month (for drill-down view)
    const driverDailyByMonth = {};
    for (let m = 1; m <= 12; m++) {
      const daysInMonth = new Date(year, m, 0).getDate();
      const dailyData = [];
      
      for (let day = 1; day <= daysInMonth; day++) {
        const dateStr = `${year}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const dayData = { day: day };
        
        topDriverNames.forEach(driverName => {
          const count = yearDeliveries.filter(d => 
            d.delivery_date === dateStr && 
            d.status === 'completed' && 
            d.patient_id &&
            (drivers.find(dr => dr?.user_id === d.driver_id)?.user_name === driverName || d.driver_name === driverName)
          ).length;
          dayData[driverName] = count;
        });
        
        dailyData.push(dayData);
      }
      
      driverDailyByMonth[m] = dailyData;
    }

    // Store breakdown (full year + by month)
    const storeStats = {};
    const storeStatsByMonth = {}; // { monthNum: { storeId: stats } }
    
    for (let m = 1; m <= 12; m++) {
      storeStatsByMonth[m] = {};
    }

    yearDeliveries.forEach(d => {
      if (!d.store_id || !d.patient_id) return;
      
      const month = d.delivery_date ? parseInt(d.delivery_date.split('-')[1]) : null;
      
      // Year total
      if (!storeStats[d.store_id]) {
        const store = stores.find(s => s?.id === d.store_id);
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
          const store = stores.find(s => s?.id === d.store_id);
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

    // Year totals
    const yearCompleted = yearDeliveries.filter(d => d.status === 'completed' && d.patient_id).length;
    const yearFailed = yearDeliveries.filter(d => d.status === 'failed').length;
    const yearTotalFees = monthlyStoreFeeTotals.reduce((sum, f) => sum + f, 0);

    // Store fee metrics summary
    const storesPayingFees = stores.filter(s => s.pays_app_fees).length;
    const totalBillableWhilePaying = yearDeliveries.filter(d => {
      if (!isBillable(d)) return false;
      const store = stores.find(s => s?.id === d.store_id);
      return store && wasPayingFeesOnDate(store, d.delivery_date);
    }).length;

    const response = {
      year,
      monthlyData,
      driverMonthlyData,
      driverDailyByMonth,
      driverNames: topDriverNames,
      storeData,
      storeDataByMonth,
      yearTotals: {
        completed: yearCompleted,
        failed: yearFailed,
        total: yearCompleted + yearFailed,
        activeDrivers: new Set(yearDeliveries.filter(d => d.driver_id).map(d => d.driver_id)).size
      },
      storeFeeTotals: {
        total_fees_owed: yearTotalFees,
        stores_paying_fees: storesPayingFees,
        total_stores: stores.length,
        total_billable_while_paying: totalBillableWhilePaying,
        app_fee_rate: appFeeRate,
        monthlyFees: monthlyStoreFeeTotals
      }
    };

    // Cache the result
    metricsCache.data = response;
    metricsCache.year = year;
    metricsCache.cacheDate = cacheDate;

    console.log('✅ [getAdminMetrics] Metrics computed and cached');
    return Response.json(response);

  } catch (error) {
    console.error('❌ Error in getAdminMetrics:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});