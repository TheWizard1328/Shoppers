import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { year, storeIds } = await req.json();
    
    console.log('📊 [getDriverOverviewStats] Params:', { year, storeIds: storeIds?.length });

    // CRITICAL: Check cache first to avoid recalculating
    const storeIdsHash = storeIds && storeIds.length > 0 ? storeIds.sort().join(',') : 'all';
    const cacheFilter = { year: year || 'all', store_ids_hash: storeIdsHash };
    
    const cachedStats = await base44.asServiceRole.entities.DriverOverviewStatsCache.filter(cacheFilter);
    
    if (cachedStats && cachedStats.length > 0) {
      const cache = cachedStats[0];
      const cacheAge = Date.now() - new Date(cache.calculated_at).getTime();
      
      // Use cache if less than 1 hour old
      if (cacheAge < 3600000) {
        console.log(`✅ [getDriverOverviewStats] Using cached stats (age: ${Math.round(cacheAge / 60000)}min)`);
        return Response.json({
          year: cache.year,
          driverStats: cache.driver_stats,
          totalDrivers: cache.driver_stats.length,
          totalDeliveries: cache.driver_stats.reduce((sum, d) => sum + d.totalStops, 0),
          fromCache: true
        });
      }
    }

    console.log('🔄 [getDriverOverviewStats] Cache miss or expired, calculating fresh stats...');

    // Build filter for year
    let deliveryFilter = {};
    if (year && year !== 'all') {
      const yearInt = parseInt(year);
      deliveryFilter.delivery_date = { 
        $gte: `${yearInt}-01-01`, 
        $lte: `${yearInt}-12-31` 
      };
    }

    // Fetch all deliveries for the year (or all years)
    const deliveries = await base44.asServiceRole.entities.Delivery.filter(deliveryFilter);
    console.log(`📊 [getDriverOverviewStats] Fetched ${deliveries?.length || 0} deliveries`);

    // Fetch all patients to check for returns
    const patients = await base44.asServiceRole.entities.Patient.filter({});
    const patientMap = new Map((patients || []).map(p => [p.id, p]));

    // Helper function to check if delivery is a return
    const isReturn = (delivery) => {
      const patient = patientMap.get(delivery.patient_id);
      const notesReturn = (delivery.delivery_notes || '').toLowerCase().includes('return');
      const addressReturn = patient && (patient.address || '').toLowerCase().includes('rtn');
      return notesReturn || addressReturn;
    };

    // Get today's date string
    const todayStr = new Date().toISOString().split('T')[0];

    // Group deliveries by driver_id
    const driverStatsMap = new Map();

    (deliveries || []).forEach(delivery => {
      if (!delivery || !delivery.driver_id) return;

      // Filter by storeIds if provided (for dispatchers)
      if (storeIds && storeIds.length > 0 && !storeIds.includes(delivery.store_id)) {
        return;
      }

      const driverId = delivery.driver_id;
      
      if (!driverStatsMap.has(driverId)) {
        driverStatsMap.set(driverId, {
          driverId: driverId,
          totalStops: 0,
          pickups: 0,
          completed: 0,
          failed: 0,
          returned: 0,
          todayStats: {
            active: 0,
            completed: 0,
            failed: 0,
            returned: 0,
            total: 0
          }
        });
      }

      const stats = driverStatsMap.get(driverId);
      stats.totalStops++;

      // Count pickups (completed store pickups)
      const isPickup = !delivery.patient_id || delivery.patient_id === '';
      if (isPickup && (delivery.status === 'completed' || delivery.status === 'picked_up')) {
        stats.pickups++;
      }

      // Count completed deliveries (patient deliveries only)
      const isPatientDelivery = delivery.patient_id && delivery.patient_id !== '';
      if (isPatientDelivery && delivery.status === 'completed') {
        stats.completed++;
      }

      // Count returns
      if (isReturn(delivery)) {
        stats.returned++;
      }

      // Count failed
      if (delivery.status === 'failed') {
        stats.failed++;
      }

      // Today's stats
      if (delivery.delivery_date === todayStr) {
        stats.todayStats.total++;
        
        if (['picked_up', 'in_transit', 'pending'].includes(delivery.status)) {
          stats.todayStats.active++;
        }
        if (delivery.status === 'completed' || delivery.status === 'delivered') {
          stats.todayStats.completed++;
        }
        if (delivery.status === 'failed' && !isReturn(delivery)) {
          stats.todayStats.failed++;
        }
        if (delivery.status === 'returned' || isReturn(delivery)) {
          stats.todayStats.returned++;
        }
      }
    });

    // Convert map to array and add completion rate
    const driverStats = Array.from(driverStatsMap.values()).map(stats => ({
      ...stats,
      completionRate: stats.totalStops > 0 ? Math.round((stats.completed / stats.totalStops) * 100) : 0
    }));

    console.log(`📊 [getDriverOverviewStats] Returning stats for ${driverStats.length} drivers`);

    // CRITICAL: Save stats to cache for faster future access
    try {
      const cacheData = {
        year: year || 'all',
        store_ids_hash: storeIdsHash,
        driver_stats: driverStats,
        calculated_at: new Date().toISOString()
      };

      // Update existing cache or create new one
      if (cachedStats && cachedStats.length > 0) {
        await base44.asServiceRole.entities.DriverOverviewStatsCache.update(cachedStats[0].id, cacheData);
        console.log('💾 [getDriverOverviewStats] Updated cache');
      } else {
        await base44.asServiceRole.entities.DriverOverviewStatsCache.create(cacheData);
        console.log('💾 [getDriverOverviewStats] Created new cache entry');
      }
    } catch (cacheError) {
      console.warn('⚠️ [getDriverOverviewStats] Failed to save cache:', cacheError.message);
    }

    return Response.json({
      year: year || 'all',
      driverStats: driverStats,
      totalDrivers: driverStats.length,
      totalDeliveries: deliveries?.length || 0,
      fromCache: false
    });

  } catch (error) {
    console.error('❌ [getDriverOverviewStats] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});