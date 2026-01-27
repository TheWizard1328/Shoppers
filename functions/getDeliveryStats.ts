import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

// In-memory cache for expensive stats (survives across requests in the same Deno isolate)
const statsCache = {
  monthly: { data: null, cacheDate: '', key: '' },
  entityCounts: { data: null, cacheDate: '' },
  squareCodTotal: { data: null, cacheDate: '' }
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
    let user;
    try {
      user = await base44.auth.me();
    } catch (authError) {
      console.error('❌ Auth error:', authError.message);
      return Response.json({ error: 'Authentication failed: ' + authError.message }, { status: 401 });
    }
    
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
      // DISPATCHERS: Only count deliveries where driver has stops in dispatcher's stores
      // CRITICAL: Filter by stores ONLY (not driver) - we need ALL drivers with stops in our stores
      if (userStoreIds.length > 0) {
        baseFilter.store_id = { $in: userStoreIds };
      }
      // When specific driver selected, filter by that driver
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
    let squareCodTotal = null;
    
    // Monthly deliveries - use cache if valid (same day + same filters)
    // CRITICAL: Also validate that cached data is an array (not corrupted)
    if (statsCache.monthly.key === monthlyKey && 
        statsCache.monthly.cacheDate === cacheDate && 
        Array.isArray(statsCache.monthly.data)) {
      console.log('📊 [getDeliveryStats] Using CACHED monthly stats');
      rawMonthDeliveries = statsCache.monthly.data;
    } else if (statsCache.monthly.key === monthlyKey && statsCache.monthly.cacheDate === cacheDate) {
      // Cache exists but data is invalid - invalidate it
      console.warn('⚠️ [getDeliveryStats] Cache data invalid, refetching');
      statsCache.monthly = { data: null, cacheDate: '', key: '' };
    }
    
    // Entity counts - use cache if valid (same day)
    if (statsCache.entityCounts.data && statsCache.entityCounts.cacheDate === cacheDate) {
      console.log('📊 [getDeliveryStats] Using CACHED entity counts');
      entityCounts = statsCache.entityCounts.data;
    }
    
    // Square COD total - use cache if valid (same day)
    if (statsCache.squareCodTotal.data !== null && statsCache.squareCodTotal.cacheDate === cacheDate) {
      console.log('📊 [getDeliveryStats] Using CACHED Square COD total');
      squareCodTotal = statsCache.squareCodTotal.data;
    }
    
    // Build parallel fetch list for only uncached data
    const fetchPromises = [];
    const fetchKeys = [];
    
    // Always fetch month deliveries if not cached (needed for today's stats too)
    if (!rawMonthDeliveries) {
      fetchPromises.push(
        base44.asServiceRole.entities.Delivery.filter({
          ...baseFilter,
          delivery_date: { $gte: startOfMonth, $lte: endOfMonthStr }
        }).catch(err => {
          // CRITICAL: If fetch fails (e.g., 404 for deleted entity), invalidate cache and return empty
          console.warn('⚠️ [getDeliveryStats] Month deliveries fetch failed:', err.message);
          statsCache.monthly = { data: null, cacheDate: '', key: '' };
          return [];
        })
      );
      fetchKeys.push('month');
    }
    
    // CRITICAL: Only fetch entity counts if NOT cached - reduces API calls
    // Entity counts are cached per day and don't need frequent updates
    if (!entityCounts && isAdmin) {
      // Batch all admin entity counts in a single try-catch to prevent cascade failures
      fetchPromises.push(
        Promise.all([
          base44.asServiceRole.entities.Patient.list().catch(() => []),
          base44.asServiceRole.entities.City.list().catch(() => []),
          base44.asServiceRole.entities.Store.list().catch(() => []),
          base44.asServiceRole.entities.AppUser.list().catch(() => [])
        ])
      );
      fetchKeys.push('adminEntityCounts');
    } else if (!entityCounts && isDispatcher && !isDriver) {
      // Dispatchers only see patient count for their stores
      if (userStoreIds.length > 0) {
        fetchPromises.push(base44.asServiceRole.entities.Patient.filter({ store_id: { $in: userStoreIds } }).catch(() => []));
      } else {
        fetchPromises.push(Promise.resolve([]));
      }
      fetchKeys.push('patientsOnly');
    }
    
    // Fetch Square COD total if not cached (for navigation panel display)
    // Only fetch if we don't already have it cached
    if (squareCodTotal === null) {
      fetchPromises.push(
        base44.functions.invoke('squareSyncCatalogItems', {})
          .then(res => res?.data?.items || res?.items || [])
          .catch(() => [])
      );
      fetchKeys.push('squareCatalogItems');
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
          } else if (key === 'adminEntityCounts') {
            // CRITICAL: Handle batched admin entity counts
            const [allPatients, allCities, allStores, allAppUsers] = results[resultIdx++] || [[], [], [], []];
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
          } else if (key === 'squareCatalogItems') {
            const catalogItems = results[resultIdx++];
            squareCodTotal = Array.isArray(catalogItems) 
              ? catalogItems.reduce((sum, item) => sum + (item.amount || 0), 0)
              : 0;
            statsCache.squareCodTotal = { data: squareCodTotal, cacheDate };
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
    
    // CRITICAL: Filter out any null/undefined entries and entries with invalid IDs
    // This handles cases where cached data references deleted entities
    const validMonthDeliveries = monthDeliveries.filter(d => d && d.id && d.delivery_date);
    
    // Filter today's deliveries from valid month data
    const todayDeliveries = validMonthDeliveries.filter(d => d.delivery_date === todayStr);
    
    console.log('✅ [getDeliveryStats] Stats ready:', {
      today: todayDeliveries.length,
      month: monthDeliveries.length,
      entityCounts: entityCounts,
      cached: fetchPromises.length === 0 ? 'ALL' : `fetched ${fetchKeys.join(', ')}`
    });
    
    // ===========================================
    // HELPER FUNCTIONS
    // ===========================================
    
    // CRITICAL: Define finishedStatuses globally for reuse
    const finishedStatuses = ['completed', 'failed', 'cancelled'];
    
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
    
    // Completed (Payable): Completed, failed, OR returned deliveries (has patient_id) OR after-hours pickups (completed OR cancelled)
    // CRITICAL: Failed deliveries are PAID deliveries - they count toward the completed/payable total
    const todayCompleted = todayDeliveries.filter(d => {
      if (!d) return false;
      // Patient deliveries - completed, failed, or returned all count as payable
      if (d.patient_id) return isCompleted(d) || isFailed(d) || isReturn(d);
      // After hours pickups - completed OR cancelled count as completed
      if (d.after_hours_pickup) return d.status === 'completed' || d.status === 'cancelled';
      return false;
    }).length;
    
    // Active Stops: Everything in progress (pickups, deliveries, pending)
    const todayActiveStops = todayDeliveries.filter(isInProgress).length;
    
    // Failed: All failed for today
    const todayFailedCount = todayDeliveries.filter(d => isFailed(d) && !isReturn(d)).length;
    
    // Returns: All returned for today
    const todayReturns = todayDeliveries.filter(isReturn).length;
    
    // DISPATCHER: Count unique driver-date routes for dispatcher's stores
    let todayActiveDrivers = 0;
    let todayInTransitDrivers = 0;
    
    if (isDispatcher && !isDriver) {
      // Count unique drivers who have ANY delivery (pickup or patient) in dispatcher's stores
      const allDriverIds = new Set(
        todayDeliveries.filter(d => d?.driver_id).map(d => d.driver_id)
      );
      todayActiveDrivers = allDriverIds.size;
      
      // CRITICAL: Count only on_duty drivers with in_transit/en_route stops
      // Fetch AppUsers to check driver_status
      const driverAppUsers = await base44.asServiceRole.entities.AppUser.filter({ 
        user_id: { $in: Array.from(allDriverIds) } 
      }).catch(() => []);
      
      const onDutyDriverIds = new Set(
        driverAppUsers.filter(au => au?.driver_status === 'on_duty').map(au => au.user_id)
      );
      
      // Count drivers who are on_duty AND have in_transit/en_route stops
      const inTransitDriverIds = new Set(
        todayDeliveries
          .filter(d => d?.driver_id && (d.status === 'in_transit' || d.status === 'en_route') && onDutyDriverIds.has(d.driver_id))
          .map(d => d.driver_id)
      );
      todayInTransitDrivers = inTransitDriverIds.size;
    } else {
      // For admins and drivers, count all active drivers
      const allDriverIds = new Set(
        todayDeliveries.filter(d => d?.driver_id).map(d => d.driver_id)
      );
      todayActiveDrivers = allDriverIds.size;
      
      // Count drivers with in_transit/en_route stops for admins (no driver_status check)
      const inTransitDriverIds = new Set(
        todayDeliveries
          .filter(d => d?.driver_id && (d.status === 'in_transit' || d.status === 'en_route'))
          .map(d => d.driver_id)
      );
      todayInTransitDrivers = inTransitDriverIds.size;
    }

    // Polyline Count: Skip - not critical and causes errors sometimes
    const polylineCount = 0;

    const todayStats = {
      completed: todayCompleted,
      activeStops: todayActiveStops,
      failed: todayFailedCount,
      returns: todayReturns,
      activeDrivers: todayActiveDrivers,
      inTransitDrivers: todayInTransitDrivers,
      polylineCount: polylineCount
    };

    // ===========================================
    // MONTH STATS - Only counts DELIVERIES (patient_id OR after_hours_pickup)
    // ===========================================
    
    // Completed (Payable): Completed, failed, OR returned deliveries OR after-hours pickups (completed/cancelled)
    // CRITICAL: Failed deliveries are PAID deliveries - they count toward the completed/payable total
    const monthCompleted = validMonthDeliveries.filter(d => {
      if (!d) return false;
      // Patient deliveries - completed, failed, or returned all count as payable
      if (d.patient_id) return isCompleted(d) || isFailed(d) || isReturn(d);
      // After hours pickups - completed OR cancelled count as completed
      if (d.after_hours_pickup) return d.status === 'completed' || d.status === 'cancelled';
      return false;
    }).length;
    
    // Failed: Only paid deliveries that failed (not returns)
    const monthFailed = validMonthDeliveries.filter(d => 
      isPaidDelivery(d) && isFailed(d) && !isReturn(d)
    ).length;
    
    // Returns: Only paid deliveries that are returned
    const monthReturns = validMonthDeliveries.filter(d => 
      isPaidDelivery(d) && isReturn(d)
    ).length;

    const monthStats = {
      completed: monthCompleted,
      failed: monthFailed,
      returns: monthReturns
    };

    // ===========================================
    // PERFORMANCE STATS - Total Pay, Km, Extra Km, Time on Duty
    // ===========================================
    let performanceStats = {
      totalPay: 0,
      totalKm: 0,
      totalExtraKm: 0,
      totalTimeOnDuty: '00:00',
      extraKmLimit: 0
    };

    try {
      // CRITICAL: Calculate for both single driver AND "All Drivers" mode
      // Get unique driver IDs from today's deliveries FIRST
      const uniqueDriverIds = [...new Set(todayDeliveries.map(d => d?.driver_id).filter(Boolean))];
      console.log(`📊 [Performance Stats] Found ${uniqueDriverIds.length} drivers with deliveries today (mode: ${driverId === 'all' ? 'ALL' : 'SINGLE'})`);
      
      if (driverId && driverId !== 'all') {
        // SINGLE DRIVER MODE - use that driver's pay rates
        const driverAppUser = await base44.asServiceRole.entities.AppUser.filter({ user_id: driverId });
        const appUser = driverAppUser?.[0];

        if (appUser) {
          const payRatePerDelivery = appUser.pay_rate_per_delivery || 0;
          const extraKmRate = appUser.extra_km_rate || 0;
          const extraKmLimit = appUser.extra_km_limit || 0;

          // Total Pay: completed, failed, returned patient deliveries + after-hours pickups * pay rate
          const paidDeliveries = todayDeliveries.filter(d => {
            if (!d) return false;
            // Patient deliveries - completed, failed, or returned
            if (d.patient_id) return isCompleted(d) || isFailed(d) || isReturn(d);
            // After-hours pickups - completed or cancelled
            if (d.after_hours_pickup) return d.status === 'completed' || d.status === 'cancelled';
            return false;
          });
          const basePayFromDeliveries = paidDeliveries.length * payRatePerDelivery;

          // Oversized Item Pay: count oversized deliveries and multiply by oversized rate
          const oversizedRate = appUser.oversized_item_rate || 0;
          const oversizedDeliveries = paidDeliveries.filter(d => d.oversized === true);
          const oversizedPay = oversizedDeliveries.length * oversizedRate;

          // Total Km: sum up travel_dist for ALL finished deliveries (completed, failed, returned)
          // If travel_dist missing, fallback to patient's distance_from_store (as the crow flies)
          const finishedDeliveries = todayDeliveries.filter(d => {
            if (!d || !d.actual_delivery_time) return false;
            return isCompleted(d) || isFailed(d) || isReturn(d);
          });
          
          // Batch fetch patients for deliveries missing travel_dist
          const deliveriesMissingDist = finishedDeliveries.filter(d => 
            !d.travel_dist && d.patient_id
          );
          let patientDistanceMap = new Map();
          
          if (deliveriesMissingDist.length > 0) {
            const patientIdsForDist = deliveriesMissingDist.map(d => d.patient_id).filter(Boolean);
            if (patientIdsForDist.length > 0) {
              const patientsForDist = await base44.asServiceRole.entities.Patient.filter({ 
                id: { $in: patientIdsForDist } 
              }).catch(() => []);
              patientsForDist.forEach(p => {
                if (p?.distance_from_store) {
                  patientDistanceMap.set(p.id, p.distance_from_store);
                }
              });
            }
          }
          
          let totalKm = 0;
          finishedDeliveries.forEach(delivery => {
            if (delivery?.travel_dist && typeof delivery.travel_dist === 'number') {
              totalKm += delivery.travel_dist;
              console.log(`📏 [Stats] ${delivery.patient_name || delivery.delivery_notes}: ${delivery.travel_dist} km`);
            } else if (delivery?.patient_id && patientDistanceMap.has(delivery.patient_id)) {
              // Fallback: use patient's distance_from_store (as the crow flies)
              const fallbackDist = patientDistanceMap.get(delivery.patient_id);
              totalKm += fallbackDist;
              console.log(`📏 [Stats] ${delivery.patient_name || delivery.delivery_notes}: ${fallbackDist} km (fallback from patient)`);
            } else {
              console.log(`⚠️ [Stats] ${delivery.patient_name || delivery.delivery_notes}: NO travel_dist (no fallback available)`);
            }
          });
          console.log(`📏 [Stats TOTAL] Total Km: ${totalKm} km from ${finishedDeliveries.length} deliveries`);

          // Extra Km: sum up distances using paid_km_override if available, otherwise patient distance_from_store
          let totalExtraKm = 0;
          
          // CRITICAL: Use paid_km_override if set, otherwise use patient distance_from_store
          paidDeliveries.forEach(delivery => {
            if (!delivery?.patient_id) return;
            
            // Check if delivery has X-KM override
            if (delivery.paid_km_override !== null && delivery.paid_km_override !== undefined) {
              const distance = parseFloat(delivery.paid_km_override);
              if (!isNaN(distance) && distance > extraKmLimit) {
                totalExtraKm += (distance - extraKmLimit);
              }
            }
          });
          
          // Batch fetch patients only for deliveries without override
          const deliveriesNeedingPatientDistance = paidDeliveries.filter(d => 
            d.patient_id && (d.paid_km_override === null || d.paid_km_override === undefined)
          );
          
          if (deliveriesNeedingPatientDistance.length > 0) {
            const patientIds = deliveriesNeedingPatientDistance.map(d => d.patient_id).filter(Boolean);
            
            if (patientIds.length > 0) {
              const patientsData = await base44.asServiceRole.entities.Patient.filter({ 
                id: { $in: patientIds } 
              });
              
              const patientMap = new Map(patientsData.map(p => [p.id, p]));
              
              deliveriesNeedingPatientDistance.forEach(delivery => {
                const patient = patientMap.get(delivery.patient_id);
                if (patient?.distance_from_store && typeof patient.distance_from_store === 'number') {
                  const distance = patient.distance_from_store;
                  
                  // CRITICAL: Only count extra km if THIS patient's distance exceeds limit
                  if (distance > extraKmLimit) {
                    totalExtraKm += (distance - extraKmLimit);
                  }
                }
              });
            }
          }

          const extraKmPay = totalExtraKm * extraKmRate;
          const totalPay = basePayFromDeliveries + extraKmPay + oversizedPay;

          performanceStats.totalPay = totalPay;
          performanceStats.totalKm = totalKm;
          performanceStats.totalExtraKm = totalExtraKm;
          performanceStats.extraKmLimit = extraKmLimit;

          // Total Time on Duty: ALWAYS calculate (for current and past routes)
          // CRITICAL: Times are stored as LOCAL device time - extract HH:MM directly, no UTC conversion
          const extractLocalTimeMinutes = (timeStr) => {
            if (!timeStr) return null;
            // Extract HH:MM directly from the string - this IS local time, not UTC
            // Format: "2026-01-03T10:33:00" or "2026-01-03T16:57:00.000Z"
            const match = timeStr.match(/T(\d{2}):(\d{2})/);
            if (match) {
              return parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
            }
            return null;
          };
          
          // Get break time from DriverDailyActivity for this driver and date
          const dailyActivities = await base44.asServiceRole.entities.DriverDailyActivity.filter({
            driver_id: driverId,
            activity_date: todayStr
          }).catch(() => []);
          const dailyActivity = dailyActivities?.[0];
          const breakTimeMinutes = dailyActivity?.total_break_time_minutes || 0;
          
          console.log(`⏱️ [TIME ON DUTY] Driver: ${driverId}, Date: ${todayStr}`);
          console.log(`⏱️ [TIME ON DUTY] Break time from DB: ${breakTimeMinutes} min`);
          
          // Calculate from first finished stop to last finished stop (or current time if on_duty), minus breaks
          const finishedWithTimes = todayDeliveries
            .filter(d => d && d.actual_delivery_time)
            .map(d => ({ ...d, localMinutes: extractLocalTimeMinutes(d.actual_delivery_time) }))
            .filter(d => d && d.localMinutes !== null)
            .sort((a, b) => a.localMinutes - b.localMinutes);

          console.log(`⏱️ [TIME ON DUTY] Finished stops: ${finishedWithTimes.length}`);

          let totalDutyMinutes = 0;
          if (finishedWithTimes.length > 0) {
            const firstMinutes = finishedWithTimes[0].localMinutes;
            
            // Determine end time: last stop OR current time if driver is on_duty
            let endMinutes;
            const allPatientDeliveries = todayDeliveries.filter(d => d && d.patient_id);
            const routeComplete = allPatientDeliveries.length > 0 &&
              allPatientDeliveries.every(d => finishedStatuses.includes(d.status));
            
            if (routeComplete) {
              // Route complete - use last stop's completion time
              endMinutes = finishedWithTimes[finishedWithTimes.length - 1].localMinutes;
              console.log(`⏱️ [TIME CALC] Route complete - using last stop time`);
            } else {
              // Still on duty - use current device time
              const now = new Date();
              endMinutes = now.getHours() * 60 + now.getMinutes();
              console.log(`⏱️ [TIME CALC] Route active - using current time`);
            }
            
            // Calculate raw duration and deduct breaks
            let rawDurationMinutes = endMinutes - firstMinutes;
            
            // Handle day boundary crossing
            if (rawDurationMinutes < 0) {
              rawDurationMinutes += 24 * 60;
            }
            
            totalDutyMinutes = Math.max(0, rawDurationMinutes - breakTimeMinutes);
            
            console.log(`⏱️ [TIME CALC] First: ${finishedWithTimes[0].actual_delivery_time} (${Math.floor(firstMinutes/60)}:${String(firstMinutes%60).padStart(2,'0')})`);
            console.log(`⏱️ [TIME CALC] End: ${Math.floor(endMinutes/60)}:${String(endMinutes%60).padStart(2,'0')} ${routeComplete ? '(Last Stop)' : '(Current)'}`);
            console.log(`⏱️ [TIME CALC] Raw: ${rawDurationMinutes}min, Breaks: ${breakTimeMinutes}min, Duty: ${totalDutyMinutes}min`);
          } else {
            console.log(`⚠️ [TIME ON DUTY] No completed stops found - returning 00:00`);
          }
          
          const hours = Math.floor(totalDutyMinutes / 60);
          const minutes = totalDutyMinutes % 60;
          performanceStats.totalTimeOnDuty = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
          console.log(`✅ [TIME RESULT] Final time on duty: ${performanceStats.totalTimeOnDuty}`);
        }
      } else if (uniqueDriverIds.length > 0) {
        // ALL DRIVERS MODE - aggregate stats across all drivers
        console.log('📊 [ALL DRIVERS MODE] Calculating aggregated performance stats');
        // Fetch all AppUsers for these drivers to get their pay rates
        const allDriverAppUsers = await base44.asServiceRole.entities.AppUser.filter({ 
          user_id: { $in: uniqueDriverIds } 
        }).catch(() => []);
        
        let totalPayAllDrivers = 0;
        let totalKmAllDrivers = 0;
        let totalExtraKmAllDrivers = 0;
        let totalDutyMinutesAllDrivers = 0;
        
        // Process each driver's stats
        for (const driverUserId of uniqueDriverIds) {
          const driverAppUser = allDriverAppUsers.find(au => au?.user_id === driverUserId);
          if (!driverAppUser) continue;
          
          const payRatePerDelivery = driverAppUser.pay_rate_per_delivery || 0;
          const extraKmRate = driverAppUser.extra_km_rate || 0;
          const extraKmLimit = driverAppUser.extra_km_limit || 0;
          const oversizedRate = driverAppUser.oversized_item_rate || 0;
          
          // Filter deliveries for this driver
          const driverDeliveries = todayDeliveries.filter(d => d?.driver_id === driverUserId);
          
          // Paid deliveries for this driver
          const paidDeliveries = driverDeliveries.filter(d => {
            if (!d) return false;
            if (d.patient_id) return isCompleted(d) || isFailed(d) || isReturn(d);
            if (d.after_hours_pickup) return d.status === 'completed' || d.status === 'cancelled';
            return false;
          });
          
          // Base pay from deliveries
          const basePayFromDeliveries = paidDeliveries.length * payRatePerDelivery;
          
          // Oversized pay
          const oversizedDeliveries = paidDeliveries.filter(d => d.oversized === true);
          const oversizedPay = oversizedDeliveries.length * oversizedRate;
          
          // Total Km for this driver
          const finishedDeliveries = driverDeliveries.filter(d => {
            if (!d || !d.actual_delivery_time) return false;
            return isCompleted(d) || isFailed(d) || isReturn(d);
          });
          
          // Batch fetch patients for deliveries missing travel_dist
          const driverDeliveriesMissingDist = finishedDeliveries.filter(d => 
            !d.travel_dist && d.patient_id
          );
          let driverPatientDistanceMap = new Map();
          
          if (driverDeliveriesMissingDist.length > 0) {
            const driverPatientIdsForDist = driverDeliveriesMissingDist.map(d => d.patient_id).filter(Boolean);
            if (driverPatientIdsForDist.length > 0) {
              const driverPatientsForDist = await base44.asServiceRole.entities.Patient.filter({ 
                id: { $in: driverPatientIdsForDist } 
              }).catch(() => []);
              driverPatientsForDist.forEach(p => {
                if (p?.distance_from_store) {
                  driverPatientDistanceMap.set(p.id, p.distance_from_store);
                }
              });
            }
          }
          
          let driverTotalKm = 0;
          finishedDeliveries.forEach(delivery => {
            if (delivery?.travel_dist && typeof delivery.travel_dist === 'number') {
              driverTotalKm += delivery.travel_dist;
              console.log(`📏 [All Drivers - ${driverUserId}] ${delivery.patient_name || delivery.delivery_notes}: ${delivery.travel_dist} km`);
            } else if (delivery?.patient_id && driverPatientDistanceMap.has(delivery.patient_id)) {
              const fallbackDist = driverPatientDistanceMap.get(delivery.patient_id);
              driverTotalKm += fallbackDist;
              console.log(`📏 [All Drivers - ${driverUserId}] ${delivery.patient_name || delivery.delivery_notes}: ${fallbackDist} km (fallback)`);
            }
          });
          console.log(`📏 [All Drivers - ${driverUserId}] Total Km: ${driverTotalKm} km from ${finishedDeliveries.length} deliveries`);
          
          // Extra Km for this driver
          let driverTotalExtraKm = 0;
          
          // Batch fetch patients ONCE for all deliveries
          const driverPatientIds = paidDeliveries.map(d => d.patient_id).filter(Boolean);
          let driverPatientMap = new Map();
          
          if (driverPatientIds.length > 0) {
            const driverPatientsData = await base44.asServiceRole.entities.Patient.filter({ 
              id: { $in: driverPatientIds } 
            }).catch(() => []);
            driverPatientMap = new Map(driverPatientsData.map(p => [p.id, p]));
          }
          
          // CRITICAL: Use paid_km_override if set, otherwise use patient distance_from_store
          paidDeliveries.forEach(delivery => {
            if (!delivery?.patient_id) return;
            
            let distance = 0;
            
            // Check if delivery has X-KM override
            if (delivery.paid_km_override !== null && delivery.paid_km_override !== undefined) {
              distance = parseFloat(delivery.paid_km_override);
            } else {
              // No override - use patient's distance_from_store
              const patient = driverPatientMap.get(delivery.patient_id);
              if (patient?.distance_from_store && typeof patient.distance_from_store === 'number') {
                distance = patient.distance_from_store;
              }
            }
            
            // Calculate extra km if distance exceeds limit
            if (!isNaN(distance) && distance > extraKmLimit) {
              driverTotalExtraKm += (distance - extraKmLimit);
            }
          });
          
          const extraKmPay = driverTotalExtraKm * extraKmRate;
          const driverTotalPay = basePayFromDeliveries + extraKmPay + oversizedPay;
          
          // Accumulate totals
          totalPayAllDrivers += driverTotalPay;
          totalKmAllDrivers += driverTotalKm;
          totalExtraKmAllDrivers += driverTotalExtraKm;
          
          // CRITICAL: Calculate time on duty for this driver using DriverDailyActivity
          // Get break time from DriverDailyActivity
          const driverDailyActivities = await base44.asServiceRole.entities.DriverDailyActivity.filter({
            driver_id: driverUserId,
            activity_date: todayStr
          }).catch(() => []);
          const driverDailyActivity = driverDailyActivities?.[0];
          const breakTimeMinutes = driverDailyActivity?.total_break_time_minutes || 0;
          
          // First to last stop minus breaks
          const extractLocalTimeMinutesForAllDrivers = (timeStr) => {
            if (!timeStr) return null;
            const match = timeStr.match(/T(\d{2}):(\d{2})/);
            if (match) {
              return parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
            }
            return null;
          };
          
          const finishedDeliveriesForTime = driverDeliveries
            .filter(d => d.actual_delivery_time)
            .map(d => ({ ...d, localMinutes: extractLocalTimeMinutesForAllDrivers(d.actual_delivery_time) }))
            .filter(d => d.localMinutes !== null)
            .sort((a, b) => a.localMinutes - b.localMinutes);
          
          let driverDutyMinutes = 0;
          if (finishedDeliveriesForTime.length > 0) {
            const driverFirstMinutes = finishedDeliveriesForTime[0].localMinutes;
            const driverLastMinutes = finishedDeliveriesForTime[finishedDeliveriesForTime.length - 1].localMinutes;
            
            const rawDurationMinutes = driverLastMinutes - driverFirstMinutes;
            driverDutyMinutes = Math.max(0, rawDurationMinutes - breakTimeMinutes);
            
            console.log(`⏱️ [All Drivers - ${driverUserId}] Raw: ${rawDurationMinutes}min, Breaks: ${breakTimeMinutes}min, Duty: ${driverDutyMinutes}min`);
          }
          
          totalDutyMinutesAllDrivers += driverDutyMinutes;
        }
        
        // Calculate aggregated time on duty
        const hours = Math.floor(totalDutyMinutesAllDrivers / 60);
        const minutes = totalDutyMinutesAllDrivers % 60;
        performanceStats.totalTimeOnDuty = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
        console.log(`✅ [All Drivers Total Time] ${performanceStats.totalTimeOnDuty} (${totalDutyMinutesAllDrivers}min total)`);
        
        performanceStats.totalPay = totalPayAllDrivers;
        performanceStats.totalKm = totalKmAllDrivers;
        performanceStats.totalExtraKm = totalExtraKmAllDrivers;
        performanceStats.extraKmLimit = 0; // Not applicable in "All Drivers" mode
        
        console.log('✅ [ALL DRIVERS MODE] Performance stats calculated:', performanceStats);
      } else {
        // No drivers with deliveries - leave as zeros
        console.log('⏭️ [Performance Stats] No drivers with deliveries today');
      }
    } catch (perfError) {
      console.warn('⚠️ [getDeliveryStats] Performance stats error:', perfError.message);
      // Continue with zeros
    }

    // Build response based on user role
    const response = {
      today: todayStats,
      month: monthStats,
      performanceStats,
      squareCodTotal: squareCodTotal !== null ? squareCodTotal : 0
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
    console.error('Error type:', error.constructor?.name);
    console.error('Error message:', error.message);
    console.error('Stack trace:', error.stack);
    
    // Return detailed error for debugging
    return Response.json({ 
      error: error.message || 'Unknown error occurred',
      errorType: error.constructor?.name || 'Error',
      details: error.stack?.split('\n').slice(0, 5).join('\n')
    }, { 
      status: 500,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  }
});