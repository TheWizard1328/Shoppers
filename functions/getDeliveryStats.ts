import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

// In-memory cache for expensive stats (survives across requests in the same Deno isolate)
const statsCache = {
  yearly: { data: null, timestamp: 0, key: '' },
  monthly: { data: null, timestamp: 0, key: '' },
  entityCounts: { data: null, timestamp: 0 }
};

// Cache durations
const YEARLY_CACHE_TTL = 24 * 60 * 60 * 1000;  // 24 hours for yearly stats (updates daily)
const MONTHLY_CACHE_TTL = 24 * 60 * 60 * 1000;  // 24 hours for monthly stats (updates daily)
const ENTITY_CACHE_TTL = 24 * 60 * 60 * 1000;   // 24 hours for entity counts (updates daily)

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Parse request body for filters
    let body = {};
    try {
      const text = await req.text();
      if (text) {
        body = JSON.parse(text);
      }
    } catch (parseError) {
      console.warn('Failed to parse request body:', parseError);
    }

    const { selectedDate, driverId, storeIds } = body;
    
    // Use selected date or default to today
    const dateObj = selectedDate ? new Date(selectedDate + 'T00:00:00') : new Date();
    const year = dateObj.getFullYear();
    const month = dateObj.getMonth() + 1; // 1-12
    const todayStr = selectedDate || dateObj.toISOString().split('T')[0];
    
    // Build filter for deliveries
    const baseFilter = {};
    if (storeIds && Array.isArray(storeIds) && storeIds.length > 0) {
      baseFilter.store_id = { $in: storeIds };
    }
    
    // If specific driver selected, filter by driver
    if (driverId && driverId !== 'all') {
      baseFilter.driver_id = driverId;
    }
    
    console.log('📊 [getDeliveryStats] Fetching stats for:', { todayStr, year, month, storeIds: storeIds?.length || 0, driverId });
    
    // Calculate date ranges
    const startOfMonth = `${year}-${String(month).padStart(2, '0')}-01`;
    const endOfMonth = new Date(year, month, 0);
    const endOfMonthStr = endOfMonth.toISOString().split('T')[0];
    
    const startOfYear = `${year}-01-01`;
    const endOfYear = `${year}-12-31`;
    
    const now = Date.now();
    
    // Cache keys based on filters
    const yearlyKey = `${year}_${JSON.stringify(baseFilter)}`;
    const monthlyKey = `${year}_${month}_${JSON.stringify(baseFilter)}`;
    
    // Check caches and fetch only what's needed
    let rawYearDeliveries = null;
    let rawMonthDeliveries = null;
    let entityCounts = null;
    
    // Yearly deliveries - use cache if valid
    if (statsCache.yearly.key === yearlyKey && (now - statsCache.yearly.timestamp) < YEARLY_CACHE_TTL) {
      console.log('📊 [getDeliveryStats] Using CACHED yearly stats');
      rawYearDeliveries = statsCache.yearly.data;
    }
    
    // Monthly deliveries - use cache if valid
    if (statsCache.monthly.key === monthlyKey && (now - statsCache.monthly.timestamp) < MONTHLY_CACHE_TTL) {
      console.log('📊 [getDeliveryStats] Using CACHED monthly stats');
      rawMonthDeliveries = statsCache.monthly.data;
    }
    
    // Entity counts - use cache if valid
    if (statsCache.entityCounts.data && (now - statsCache.entityCounts.timestamp) < ENTITY_CACHE_TTL) {
      console.log('📊 [getDeliveryStats] Using CACHED entity counts');
      entityCounts = statsCache.entityCounts.data;
    }
    
    // Build parallel fetch list for only uncached data
    const fetchPromises = [];
    const fetchKeys = [];
    
    // Always fetch month deliveries if not cached (needed for today's stats too)
    if (!rawMonthDeliveries) {
      fetchPromises.push(base44.asServiceRole.entities.Delivery.filter({
        ...baseFilter,
        delivery_date: { $gte: startOfMonth, $lte: endOfMonthStr }
      }));
      fetchKeys.push('month');
    }
    
    if (!rawYearDeliveries) {
      fetchPromises.push(base44.asServiceRole.entities.Delivery.filter({
        ...baseFilter,
        delivery_date: { $gte: startOfYear, $lte: endOfYear }
      }));
      fetchKeys.push('year');
    }
    
    if (!entityCounts) {
      fetchPromises.push(base44.asServiceRole.entities.Patient.list());
      fetchPromises.push(base44.asServiceRole.entities.City.list());
      fetchPromises.push(base44.asServiceRole.entities.Store.list());
      fetchPromises.push(base44.asServiceRole.entities.AppUser.list());
      fetchKeys.push('patients', 'cities', 'stores', 'appUsers');
    }
    
    // Fetch only what we need
    if (fetchPromises.length > 0) {
      console.log('📊 [getDeliveryStats] Fetching:', fetchKeys.join(', '));
      const results = await Promise.all(fetchPromises);
      
      let resultIdx = 0;
      for (const key of fetchKeys) {
        if (key === 'month') {
          rawMonthDeliveries = results[resultIdx++];
          statsCache.monthly = { data: rawMonthDeliveries, timestamp: now, key: monthlyKey };
        } else if (key === 'year') {
          rawYearDeliveries = results[resultIdx++];
          statsCache.yearly = { data: rawYearDeliveries, timestamp: now, key: yearlyKey };
        } else if (key === 'patients') {
          const allPatients = results[resultIdx++];
          const allCities = results[resultIdx++];
          const allStores = results[resultIdx++];
          const allAppUsers = results[resultIdx++];
          entityCounts = {
            patients: allPatients.length,
            cities: allCities.length,
            stores: allStores.length,
            users: allAppUsers.length
          };
          statsCache.entityCounts = { data: entityCounts, timestamp: now };
        }
      }
    } else {
      console.log('📊 [getDeliveryStats] All data from cache - no DB calls needed!');
    }

    const monthDeliveries = Array.isArray(rawMonthDeliveries) ? rawMonthDeliveries : [];
    const yearDeliveries = Array.isArray(rawYearDeliveries) ? rawYearDeliveries : [];
    
    // Filter today's deliveries from month data
    const todayDeliveries = monthDeliveries.filter(d => d.delivery_date === todayStr);
    
    console.log('✅ [getDeliveryStats] Stats ready:', {
      today: todayDeliveries.length,
      month: monthDeliveries.length,
      year: yearDeliveries.length,
      entityCounts: entityCounts,
      cached: fetchPromises.length === 0 ? 'ALL' : `fetched ${fetchKeys.join(', ')}`
    });
    
    // ===========================================
    // HELPER FUNCTIONS
    // ===========================================
    
    // Helper: Check if delivery is a return (status-based)
    const isReturn = (d) => d && d.status === 'returned';
    
    // Helper: Check if delivery is failed
    const isFailed = (d) => d && d.status === 'failed';
    
    // Helper: Check if delivery is completed
    const isCompleted = (d) => d && ['completed', 'delivered'].includes(d.status);
    
    // Helper: Check if delivery is in progress (active stop)
    const isInProgress = (d) => d && ['in_transit', 'en_route', 'pending', 'Ready For Pickup'].includes(d.status);
    
    // Helper: Check if a delivery should be counted for MONTHLY stats
    // Only patient deliveries (has patient_id) OR after-hours pickups count
    const isPaidDelivery = (d) => d && (d.patient_id || d.after_hours_pickup);

    // ===========================================
    // TODAY'S STATS - Counts ALL activities (pickups + deliveries)
    // ===========================================
    
    // Completed: All completed pickups and deliveries for today
    const todayCompleted = todayDeliveries.filter(isCompleted).length;
    
    // Active Stops: Everything in progress (pickups, deliveries, pending)
    const todayActiveStops = todayDeliveries.filter(isInProgress).length;
    
    // Failed: All failed for today
    const todayFailedCount = todayDeliveries.filter(d => isFailed(d) && !isReturn(d)).length;
    
    // Returns: All returned for today
    const todayReturns = todayDeliveries.filter(isReturn).length;
    
    // Active Drivers: Unique drivers with any activity today
    const todayActiveDrivers = new Set(
      todayDeliveries.filter(d => d.driver_id).map(d => d.driver_id)
    ).size;

    const todayStats = {
      completed: todayCompleted,
      activeStops: todayActiveStops,
      failed: todayFailedCount,
      returns: todayReturns,
      activeDrivers: todayActiveDrivers
    };

    // ===========================================
    // MONTH STATS - Only counts DELIVERIES (patient_id OR after_hours_pickup)
    // ===========================================
    
    // Completed: Only paid deliveries that are completed
    const monthCompleted = monthDeliveries.filter(d => 
      isPaidDelivery(d) && isCompleted(d)
    ).length;
    
    // Failed: Only paid deliveries that failed (not returns)
    const monthFailed = monthDeliveries.filter(d => 
      isPaidDelivery(d) && isFailed(d) && !isReturn(d)
    ).length;
    
    // Returns: Only paid deliveries that are returned
    const monthReturns = monthDeliveries.filter(d => 
      isPaidDelivery(d) && isReturn(d)
    ).length;

    const monthStats = {
      completed: monthCompleted,
      failed: monthFailed,
      returns: monthReturns
    };

    // ===========================================
    // DELIVERY TOTALS (Monthly & Yearly) - Only paid deliveries
    // ===========================================
    
    const totalMonthlyDeliveries = monthDeliveries.filter(isPaidDelivery).length;
    const totalYearlyDeliveries = yearDeliveries.filter(isPaidDelivery).length;

    // ===========================================
    // DRIVER ROUTES (Yearly) - Unique driver-days for paid deliveries
    // ===========================================
    
    const yearlyDriverDeliveriesByDay = {};
    yearDeliveries.forEach(d => {
      if (isPaidDelivery(d) && d.driver_id && d.delivery_date) {
        if (!yearlyDriverDeliveriesByDay[d.delivery_date]) {
          yearlyDriverDeliveriesByDay[d.delivery_date] = new Set();
        }
        yearlyDriverDeliveriesByDay[d.delivery_date].add(d.driver_id);
      }
    });
    const yearlyTotalDriverRoutes = Object.values(yearlyDriverDeliveriesByDay)
      .reduce((sum, driversSet) => sum + driversSet.size, 0);
    
    return Response.json({
      today: todayStats,
      month: monthStats,
      deliveries: {
        monthly: totalMonthlyDeliveries,
        yearly: totalYearlyDeliveries
      },
      drivers: {
        yearlyTotalDriverRoutes: yearlyTotalDriverRoutes
      },
      entityCounts: entityCounts
    });
  } catch (error) {
    console.error('Error in getDeliveryStats:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});