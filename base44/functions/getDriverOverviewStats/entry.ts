import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { year, storeIds, forceRefresh = false } = await req.json();
    
    console.log('📊 [getDriverOverviewStats] Params:', { year, storeIds: storeIds?.length });

    // CRITICAL: Check cache first to avoid recalculating (unless force refresh)
    const storeIdsHash = storeIds && storeIds.length > 0 ? storeIds.sort().join(',') : 'all';
    const cacheFilter = { year: year || 'all', store_ids_hash: storeIdsHash };
    
    if (!forceRefresh) {
      const cachedStats = await base44.asServiceRole.entities.DriverOverviewStatsCache.filter(cacheFilter);
      
      if (cachedStats && cachedStats.length > 0) {
        const cache = cachedStats[0];
        const cacheAge = Date.now() - new Date(cache.calculated_at).getTime();
        
        // CRITICAL: Extended cache for historical years (24 hours), current year (1 hour)
        const currentYear = new Date().getFullYear();
        const isCurrentYear = !year || year === 'all' || parseInt(year) === currentYear;
        const maxCacheAge = isCurrentYear ? 3600000 : 86400000; // 1hr current, 24hr historical
        
        if (cacheAge < maxCacheAge) {
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
    } else {
      console.log('🔄 [getDriverOverviewStats] Force refresh requested, bypassing cache...');
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

    // CRITICAL: Fetch deliveries in chunks to avoid rate limiting
    // Fetch with sorting by date descending and limit to 1000 per request
    const deliveries = [];
    let pageCount = 0;
    let hasMore = true;
    
    while (hasMore && pageCount < 50) { // Max 50 pages = 50,000 deliveries
      const pageDeliveries = await base44.asServiceRole.entities.Delivery.filter(
        deliveryFilter, 
        '-delivery_date', 
        1000,
        pageCount * 1000
      );
      
      if (!pageDeliveries || pageDeliveries.length === 0) {
        hasMore = false;
      } else {
        deliveries.push(...pageDeliveries);
        pageCount++;
        // Add small delay between requests to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
    
    console.log(`📊 [getDriverOverviewStats] Fetched ${deliveries.length} deliveries in ${pageCount} requests`);

    // Fetch patients in chunks too
    const patients = [];
    pageCount = 0;
    hasMore = true;
    
    while (hasMore && pageCount < 50) {
      const pagePatients = await base44.asServiceRole.entities.Patient.filter({}, 'full_name', 1000, pageCount * 1000);
      
      if (!pagePatients || pagePatients.length === 0) {
        hasMore = false;
      } else {
        patients.push(...pagePatients);
        pageCount++;
        // Add small delay between requests
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
    
    const patientMap = new Map((patients || []).map(p => [p.id, p]));
    console.log(`👥 [getDriverOverviewStats] Fetched ${patients.length} patients in ${pageCount} requests`);

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

      // Re-fetch cache to avoid race conditions
      const latestCache = await base44.asServiceRole.entities.DriverOverviewStatsCache.filter(cacheFilter);
      
      // Update existing cache or create new one
      if (latestCache && latestCache.length > 0) {
        await base44.asServiceRole.entities.DriverOverviewStatsCache.update(latestCache[0].id, cacheData);
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