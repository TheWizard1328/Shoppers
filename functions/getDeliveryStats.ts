import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

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
    
    // Parallel fetch for efficiency - use service role for all data
    const [monthDeliveries, yearDeliveries, allPatients, allCities, allStores, allUsers] = await Promise.all([
      base44.asServiceRole.entities.Delivery.filter({
        ...baseFilter,
        delivery_date: { $gte: startOfMonth, $lte: endOfMonthStr }
      }),
      base44.asServiceRole.entities.Delivery.filter({
        ...baseFilter,
        delivery_date: { $gte: startOfYear, $lte: endOfYear }
      }),
      base44.asServiceRole.entities.Patient.list(),
      base44.asServiceRole.entities.City.list(),
      base44.asServiceRole.entities.Store.list(),
      base44.asServiceRole.entities.AppUser.list()
    ]);
    
    // Filter today's deliveries from month data
    const todayDeliveries = monthDeliveries.filter(d => d.delivery_date === todayStr);
    
    console.log('✅ [getDeliveryStats] Fetched:', {
      today: todayDeliveries.length,
      month: monthDeliveries.length,
      year: yearDeliveries.length,
      patients: allPatients.length,
      cities: allCities.length,
      stores: allStores.length,
      users: allUsers.length
    });
    
    // Helper: Check if delivery is countable (patient delivery or after-hours pickup)
    const isCountableDelivery = (d) => {
      if (!d) return false;
      if (d.patient_id) return true;
      if (!d.patient_id && d.after_hours_pickup) return true;
      return false;
    };

    // Helper: Check if delivery is a return
    const isReturn = (d) => {
      if (!d) return false;
      return (d.delivery_notes || '').toLowerCase().includes('return');
    };

    // Today stats
    const todayCompleted = todayDeliveries.filter(d => 
      ['completed', 'delivered'].includes(d.status) && isCountableDelivery(d)
    ).length;
    const todayActiveStops = todayDeliveries.filter(d => 
      d.status === 'in_transit' || d.status === 'en_route'
    ).length;
    const todayReturns = todayDeliveries.filter(isReturn).length;
    const todayFailed = todayDeliveries.filter(d => 
      d.status === 'failed' && !isReturn(d) && isCountableDelivery(d)
    ).length;
    const todayActiveDrivers = new Set(
      todayDeliveries.filter(d => d.driver_name).map(d => d.driver_name)
    ).size;

    const todayStats = {
      completed: todayCompleted,
      activeStops: todayActiveStops,
      returns: todayReturns,
      failed: todayFailed,
      activeDrivers: todayActiveDrivers
    };

    // Month stats
    const monthCompleted = monthDeliveries.filter(d => 
      ['completed', 'delivered'].includes(d.status) && isCountableDelivery(d)
    ).length;
    const monthReturns = monthDeliveries.filter(isReturn).length;
    const monthFailed = monthDeliveries.filter(d => 
      d.status === 'failed' && !isReturn(d) && isCountableDelivery(d)
    ).length;

    const monthStats = {
      completed: monthCompleted,
      returns: monthReturns,
      failed: monthFailed
    };

    // Route counts (unique dates)
    const monthlyRoutes = new Set(monthDeliveries.map(d => d.delivery_date)).size;
    const yearlyRoutes = new Set(yearDeliveries.map(d => d.delivery_date)).size;
    
    // Entity counts for navigation panel
    const entityCounts = {
      patients: allPatients.length,
      cities: allCities.length,
      stores: allStores.length,
      users: allUsers.length
    };
    
    return Response.json({
      today: todayStats,
      month: monthStats,
      routeCounts: {
        monthly: monthlyRoutes,
        yearly: yearlyRoutes
      },
      entityCounts: entityCounts
    });
  } catch (error) {
    console.error('Error in getDeliveryStats:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});