import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

// In-memory cache for expensive stats (survives across requests in the same Deno isolate)
const statsCache = {
  yearly: { data: null, cacheDate: '', key: '' },
  monthly: { data: null, cacheDate: '', key: '' },
  entityCounts: { data: null, cacheDate: '' }
};

// Daily refresh at 4 AM Mountain Time (Edmonton) = 6 AM Eastern (Ontario)
// Both are off-peak hours for users in Alberta and Ontario
const REFRESH_HOUR_UTC = 11; // 4 AM Mountain (UTC-7) = 11:00 UTC, 6 AM Eastern (UTC-5) = 11:00 UTC

// Helper: Get today's cache date key (changes at REFRESH_HOUR_UTC)
const getCacheDateKey = () => {
  const now = new Date();
  const utcHour = now.getUTCHours();
  
  // If before refresh hour, use yesterday's date as cache key
  // This ensures cache invalidates at the refresh hour
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
    
    // Get user's AppUser record to determine roles and store assignments
    const appUsers = await base44.asServiceRole.entities.AppUser.filter({ user_id: user.id });
    const appUser = appUsers?.[0];
    const userRoles = appUser?.app_roles || [];
    const isAdmin = userRoles.includes('admin');
    const isDispatcher = userRoles.includes('dispatcher');
    const isDriver = userRoles.includes('driver');
    const userStoreIds = appUser?.store_ids || [];
    
    console.log('📊 [getDeliveryStats] User roles:', userRoles, 'Store IDs:', userStoreIds);
    
    // Use selected date or default to today
    const dateObj = selectedDate ? new Date(selectedDate + 'T00:00:00') : new Date();
    const year = dateObj.getFullYear();
    const month = dateObj.getMonth() + 1; // 1-12
    const todayStr = selectedDate || dateObj.toISOString().split('T')[0];
    
    // Build filter for deliveries based on user role
    const baseFilter = {};
    
    // Role-based filtering
    if (isAdmin) {
      // Admins see totals across all drivers - use provided storeIds if any
      if (storeIds && Array.isArray(storeIds) && storeIds.length > 0) {
        baseFilter.store_id = { $in: storeIds };
      }
      // Admins always see totals - do NOT filter by driverId for stats
    } else if (isDispatcher && !isDriver) {
      // Dispatchers only see their assigned stores
      if (userStoreIds.length > 0) {
        baseFilter.store_id = { $in: userStoreIds };
      }
      // If specific driver selected, filter by driver
      if (driverId && driverId !== 'all') {
        baseFilter.driver_id = driverId;
      }
    } else if (isDriver) {
      // Drivers only see their own deliveries
      baseFilter.driver_id = user.id;
    }
    
    console.log('📊 [getDeliveryStats] Fetching stats for:', { todayStr, year, month, storeIds: storeIds?.length || 0, driverId });
    
    // Calculate date ranges
    const startOfMonth = `${year}-${String(month).padStart(2, '0')}-01`;
    const endOfMonth = new Date(year, month, 0);
    const endOfMonthStr = endOfMonth.toISOString().split('T')[0];
    
    const startOfYear = `${year}-01-01`;
    const endOfYear = `${year}-12-31`;
    
    const cacheDate = getCacheDateKey();
    
    // Cache keys based on filters
    const yearlyKey = `${year}_${JSON.stringify(baseFilter)}`;
    const monthlyKey = `${year}_${month}_${JSON.stringify(baseFilter)}`;
    
    // Check caches and fetch only what's needed
    let rawYearDeliveries = null;
    let rawMonthDeliveries = null;
    let entityCounts = null;
    
    // Yearly deliveries - use cache if valid (same day + same filters)
    if (statsCache.yearly.key === yearlyKey && statsCache.yearly.cacheDate === cacheDate) {
      console.log('📊 [getDeliveryStats] Using CACHED yearly stats');
      rawYearDeliveries = statsCache.yearly.data;
    }
    
    // Monthly deliveries - use cache if valid (same day + same filters)
    if (statsCache.monthly.key === monthlyKey && statsCache.monthly.cacheDate === cacheDate) {
      console.log('📊 [getDeliveryStats] Using CACHED monthly stats');
      rawMonthDeliveries = statsCache.monthly.data;
    }
    
    // Entity counts - use cache if valid (same day)
    if (statsCache.entityCounts.data && statsCache.entityCounts.cacheDate === cacheDate) {
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
    
    // Only fetch entity counts for admins
    if (!entityCounts && isAdmin) {
      fetchPromises.push(base44.asServiceRole.entities.Patient.list());
      fetchPromises.push(base44.asServiceRole.entities.City.list());
      fetchPromises.push(base44.asServiceRole.entities.Store.list());
      fetchPromises.push(base44.asServiceRole.entities.AppUser.list());
      fetchKeys.push('patients', 'cities', 'stores', 'appUsers');
    } else if (!entityCounts && isDispatcher && !isDriver) {
      // Dispatchers only see patient count for their stores
      if (userStoreIds.length > 0) {
        fetchPromises.push(base44.asServiceRole.entities.Patient.filter({ store_id: { $in: userStoreIds } }));
      } else {
        fetchPromises.push(Promise.resolve([]));
      }
      fetchKeys.push('patientsOnly');
    }
    
    // Fetch only what we need
    if (fetchPromises.length > 0) {
      console.log('📊 [getDeliveryStats] Fetching:', fetchKeys.join(', '));
      const results = await Promise.all(fetchPromises);
      
      let resultIdx = 0;
      for (const key of fetchKeys) {
        if (key === 'month') {
          rawMonthDeliveries = results[resultIdx++];
          statsCache.monthly = { data: rawMonthDeliveries, cacheDate, key: monthlyKey };
        } else if (key === 'year') {
          rawYearDeliveries = results[resultIdx++];
          statsCache.yearly = { data: rawYearDeliveries, cacheDate, key: yearlyKey };
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
          statsCache.entityCounts = { data: entityCounts, cacheDate };
        } else if (key === 'patientsOnly') {
          const dispatcherPatients = results[resultIdx++];
          entityCounts = {
            patients: dispatcherPatients.length
          };
          // Don't cache dispatcher-specific counts (they vary by user)
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
    
    // Build response based on user role
    const response = {
      today: todayStats,
      month: monthStats,
      deliveries: {
        monthly: totalMonthlyDeliveries,
        yearly: totalYearlyDeliveries
      },
      drivers: {
        yearlyTotalDriverRoutes: yearlyTotalDriverRoutes
      }
    };
    
    // Only include entityCounts for roles that should see them
    if (isAdmin) {
      // Admins see all entity counts
      response.entityCounts = entityCounts;
    } else if (isDispatcher && !isDriver) {
      // Dispatchers only see patient count
      response.entityCounts = entityCounts ? { patients: entityCounts.patients } : null;
    }
    // Drivers don't get entityCounts at all
    
    return Response.json(response);
  } catch (error) {
    console.error('Error in getDeliveryStats:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});