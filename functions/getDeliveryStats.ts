import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

// In-memory cache for expensive stats (survives across requests in the same Deno isolate)
const statsCache = {
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
    
    // Get authenticated user
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
    console.log('📊 [getDeliveryStats] Request params:', { selectedDate, driverId, storeIds: storeIds?.length });
    
    // Get user's AppUser record to determine roles and store assignments
    let appUsers, appUser, userRoles, isAdmin, isDispatcher, isDriver, userStoreIds;
    try {
      appUsers = await base44.asServiceRole.entities.AppUser.filter({ user_id: user.id });
      appUser = appUsers?.[0];
      userRoles = Array.isArray(appUser?.app_roles) ? appUser.app_roles : [];
      isAdmin = userRoles.includes('admin');
      isDispatcher = userRoles.includes('dispatcher');
      isDriver = userRoles.includes('driver');
      userStoreIds = Array.isArray(appUser?.store_ids) ? appUser.store_ids : [];
      
      console.log('📊 [getDeliveryStats] User roles:', userRoles, 'Store IDs:', userStoreIds);
    } catch (appUserError) {
      console.error('❌ Error fetching AppUser:', appUserError.message);
      return Response.json({ error: 'Failed to fetch user roles: ' + appUserError.message }, { status: 500 });
    }
    
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
      // CRITICAL: If specific driver selected, filter by that driver
      if (driverId && driverId !== 'all') {
        baseFilter.driver_id = driverId;
      }
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
    
    const cacheDate = getCacheDateKey();
    
    // Cache keys based on filters
    const monthlyKey = `${year}_${month}_${JSON.stringify(baseFilter)}`;
    
    // Check caches and fetch only what's needed
    let rawMonthDeliveries = null;
    let entityCounts = null;
    
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
      
      let results;
      try {
        results = await Promise.all(fetchPromises);
      } catch (fetchError) {
        console.error('❌ Error fetching data:', fetchError.message);
        return Response.json({ error: 'Failed to fetch delivery data: ' + fetchError.message }, { status: 500 });
      }
      
      let resultIdx = 0;
      try {
        for (const key of fetchKeys) {
          if (key === 'month') {
            rawMonthDeliveries = results[resultIdx++];
            if (!Array.isArray(rawMonthDeliveries)) {
              console.error('❌ Month deliveries is not an array:', rawMonthDeliveries);
              rawMonthDeliveries = [];
            }
            statsCache.monthly = { data: rawMonthDeliveries, cacheDate, key: monthlyKey };
          } else if (key === 'patients') {
            const allPatients = results[resultIdx++];
            const allCities = results[resultIdx++];
            const allStores = results[resultIdx++];
            const allAppUsers = results[resultIdx++];
            entityCounts = {
              patients: Array.isArray(allPatients) ? allPatients.length : 0,
              cities: Array.isArray(allCities) ? allCities.length : 0,
              stores: Array.isArray(allStores) ? allStores.length : 0,
              users: Array.isArray(allAppUsers) ? allAppUsers.length : 0
            };
            statsCache.entityCounts = { data: entityCounts, cacheDate };
          } else if (key === 'patientsOnly') {
            const dispatcherPatients = results[resultIdx++];
            entityCounts = {
              patients: Array.isArray(dispatcherPatients) ? dispatcherPatients.length : 0
            };
            // Don't cache dispatcher-specific counts (they vary by user)
          }
        }
      } catch (processingError) {
        console.error('❌ Error processing results:', processingError.message);
        console.error('Processing stack:', processingError.stack);
        return Response.json({ 
          error: 'Failed to process stats: ' + processingError.message,
          stack: processingError.stack?.split('\n').slice(0, 5).join(' | ')
        }, { status: 500 });
      }
    } else {
      console.log('📊 [getDeliveryStats] All data from cache - no DB calls needed!');
    }

    // CRITICAL: Validate rawMonthDeliveries is an array
    if (!rawMonthDeliveries) {
      console.error('❌ rawMonthDeliveries is null/undefined');
      rawMonthDeliveries = [];
    }
    if (!Array.isArray(rawMonthDeliveries)) {
      console.error('❌ rawMonthDeliveries is not an array:', typeof rawMonthDeliveries, rawMonthDeliveries);
      rawMonthDeliveries = [];
    }
    
    const monthDeliveries = rawMonthDeliveries;
    
    // Filter today's deliveries from month data
    const todayDeliveries = monthDeliveries.filter(d => d && d.delivery_date === todayStr);
    
    console.log('✅ [getDeliveryStats] Stats ready:', {
      today: todayDeliveries.length,
      month: monthDeliveries.length,
      entityCounts: entityCounts,
      cached: fetchPromises.length === 0 ? 'ALL' : `fetched ${fetchKeys.join(', ')}`
    });
    
    // ===========================================
    // HELPER FUNCTIONS
    // ===========================================
    
    // Helper: Check if delivery is a return (based on notes/name with "(RTN)" or "Return")
    // CRITICAL: Only match explicit return markers, not partial matches like "returned" in other contexts
    const isReturn = (d) => {
      if (!d) return false;
      const notes = (d.delivery_notes || '');
      const patientName = (d.patient_name || '');
      // Check for "(RTN)" marker (case-insensitive)
      if (notes.toLowerCase().includes('(rtn)') || patientName.toLowerCase().includes('(rtn)')) return true;
      // Check for "Return" as a word (case-insensitive) - look for word boundaries
      const returnRegex = /\breturn\b/i;
      return returnRegex.test(notes) || returnRegex.test(patientName);
    };
    
    // Helper: Check if delivery is failed OR a cancelled pickup (EXCLUDE returns from failed count)
    const isFailed = (d) => {
      if (!d) return false;
      // CRITICAL: Returns are counted separately, not as failures
      if (isReturn(d)) return false;
      // Failed deliveries
      if (d.status === 'failed') return true;
      // Cancelled pickups (no patient_id)
      if (d.status === 'cancelled' && !d.patient_id) return true;
      return false;
    };
    
    // Helper: Check if delivery is completed (ONLY 'completed', explicitly EXCLUDE returns)
    const isCompleted = (d) => {
      if (!d) return false;
      // CRITICAL: ONLY count 'completed' status
      if (d.status !== 'completed') return false;
      // CRITICAL: Exclude returns from completed count
      if (isReturn(d)) return false;
      return true;
    };
    
    // Helper: Check if delivery is in progress (active stop)
    const isInProgress = (d) => d && ['in_transit', 'en_route', 'pending', 'Ready For Pickup'].includes(d.status);
    
    // Helper: Check if a delivery should be counted for MONTHLY stats
    // Only patient deliveries (has patient_id) OR after-hours pickups count
    const isPaidDelivery = (d) => d && (d.patient_id || d.after_hours_pickup);

    // ===========================================
    // TODAY'S STATS - Counts deliveries only (excludes pickups)
    // ===========================================
    
    // Completed: Only completed deliveries (has patient_id) OR after-hours pickups
    const todayCompleted = todayDeliveries.filter(d => d && (d.patient_id || d.after_hours_pickup) && isCompleted(d)).length;
    
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

    // Polyline Count: Total daily_generation_count for selected date
    let polylineCount = 0;
    try {
      const polylines = await base44.asServiceRole.entities.DriverRoutePolyline.filter({
        delivery_date: todayStr
      });
      if (Array.isArray(polylines)) {
        polylineCount = polylines.reduce((sum, p) => sum + (p?.daily_generation_count || 0), 0);
        console.log(`📍 [getDeliveryStats] Polyline count for ${todayStr}: ${polylineCount}`);
      }
    } catch (polylineError) {
      console.warn('⚠️ [getDeliveryStats] Error fetching polylines:', polylineError.message);
      // Silently continue - polyline count is optional
    }

    const todayStats = {
      completed: todayCompleted,
      activeStops: todayActiveStops,
      failed: todayFailedCount,
      returns: todayReturns,
      activeDrivers: todayActiveDrivers,
      polylineCount: polylineCount
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

    // Build response based on user role
    const response = {
      today: todayStats,
      month: monthStats
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
    console.error('❌❌❌ CRITICAL ERROR in getDeliveryStats:', error);
    console.error('Stack trace:', error.stack);
    return Response.json({ 
      error: error.message || 'Unknown error',
      details: error.stack?.split('\n').slice(0, 3).join(' | ')
    }, { status: 500 });
  }
});