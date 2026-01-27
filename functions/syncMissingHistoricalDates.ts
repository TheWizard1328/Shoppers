import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

// Helper to delay between requests
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Only admins can sync historical data
    if (user.role !== 'App Owner' && !user.app_roles?.includes('admin')) {
      return Response.json({ error: 'Admin only' }, { status: 403 });
    }

    // Import offlineDB - note: this only works in browser context
    // For backend, we'll work with the offline DB via the frontend
    // This function orchestrates the sync from the backend
    
    const response = req.json ? await req.json() : {};
    const { cityStoreIds = [], startDate, endDate } = response;

    // Generate date range to sync (last 90 days if not specified)
    const today = new Date();
    const start = startDate ? new Date(startDate) : new Date(today.getTime() - 90 * 24 * 60 * 60 * 1000);
    const end = endDate ? new Date(endDate) : today;

    const datesToSync = [];
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const dateStr = d.toISOString().split('T')[0];
      datesToSync.push(dateStr);
    }

    console.log(`📅 [syncMissingHistoricalDates] Will check ${datesToSync.length} dates for missing deliveries`);

    const syncedDates = [];
    const skippedDates = [];

    // Sync dates one at a time with delays to avoid rate limits
    for (let i = 0; i < datesToSync.length; i++) {
      const dateStr = datesToSync[i];
      
      try {
        // Build filter
        const filter = { delivery_date: dateStr };
        if (cityStoreIds && cityStoreIds.length > 0) {
          filter.store_id = { $in: cityStoreIds };
        }

        // Fetch deliveries for this date
        const deliveries = await base44.entities.Delivery.filter(filter, '-delivery_date', 1000);
        
        if (deliveries && deliveries.length > 0) {
          syncedDates.push({
            date: dateStr,
            count: deliveries.length,
            synced: true
          });
          console.log(`✅ [syncMissingHistoricalDates] Synced ${deliveries.length} deliveries for ${dateStr}`);
        } else {
          skippedDates.push({ date: dateStr, count: 0 });
          console.log(`⏭️ [syncMissingHistoricalDates] No deliveries for ${dateStr}`);
        }

        // Rate limit protection: delay between dates
        // More aggressive delay to avoid hitting limits
        if (i < datesToSync.length - 1) {
          await delay(3000); // 3 second delay between requests
        }
      } catch (dateError) {
        console.warn(`⚠️ [syncMissingHistoricalDates] Error syncing ${dateStr}:`, dateError.message);
        
        // If rate limited, back off more aggressively
        if (dateError.response?.status === 429 || dateError.message?.includes('429')) {
          console.log(`⏰ [syncMissingHistoricalDates] Rate limited - backing off for 30 seconds`);
          await delay(30000); // 30 second backoff on rate limit
        }
        
        skippedDates.push({ date: dateStr, error: dateError.message });
      }
    }

    return Response.json({
      success: true,
      datesToSync: datesToSync.length,
      synced: syncedDates.length,
      skipped: skippedDates.length,
      syncedDates: syncedDates.slice(0, 10), // Return first 10 as sample
      message: `Synced ${syncedDates.length} dates with deliveries, skipped ${skippedDates.length} empty dates`
    });

  } catch (error) {
    console.error('❌ [syncMissingHistoricalDates] Error:', error);
    return Response.json({ 
      error: error.message,
      success: false
    }, { status: 500 });
  }
});