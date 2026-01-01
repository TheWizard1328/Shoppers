import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

/**
 * Get Store Metrics - Calculates delivery counts and app fees for stores
 * Returns metrics for stores that have pays_app_fees enabled
 */
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    
    // Get authenticated user
    const user = await base44.auth.me();
    
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Check if user is admin
    const appUsers = await base44.asServiceRole.entities.AppUser.filter({ user_id: user.id });
    const appUser = appUsers?.[0];
    const userRoles = Array.isArray(appUser?.app_roles) ? appUser.app_roles : [];
    const isAdmin = userRoles.includes('admin');

    if (!isAdmin) {
      return Response.json({ error: 'Admin access required' }, { status: 403 });
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

    const { year, month, storeId } = body;
    
    // Default to current month if not specified
    const now = new Date();
    const targetYear = year || now.getFullYear();
    const targetMonth = month || (now.getMonth() + 1);
    
    console.log('📊 [getStoreMetrics] Request:', { year: targetYear, month: targetMonth, storeId });
    
    // Get all stores
    const stores = await base44.asServiceRole.entities.Store.list();
    
    // Get app fee rate from AppSettings
    let appFeeRate = 0;
    try {
      const settings = await base44.asServiceRole.entities.AppSettings.filter({ setting_key: 'refresh_intervals' });
      if (settings?.[0]?.setting_value?.app_fees_per_delivery) {
        appFeeRate = parseFloat(settings[0].setting_value.app_fees_per_delivery) || 0;
      }
    } catch (settingsError) {
      console.warn('⚠️ Failed to load app fee rate:', settingsError.message);
    }
    
    // Calculate date range for the target month
    const startOfMonth = `${targetYear}-${String(targetMonth).padStart(2, '0')}-01`;
    const endOfMonth = new Date(targetYear, targetMonth, 0);
    const endOfMonthStr = endOfMonth.toISOString().split('T')[0];
    
    // Helper: Check if delivery should count for billing
    const isBillableDelivery = (d) => {
      if (!d) return false;
      // Must be completed, failed, or returned
      if (!['completed', 'failed'].includes(d.status)) {
        // Check for return status
        const notes = (d.delivery_notes || '').toLowerCase();
        const patientName = (d.patient_name || '').toLowerCase();
        const isReturn = notes.includes('(rtn)') || patientName.includes('(rtn)') ||
                        /\breturn\b/i.test(notes) || /\breturn\b/i.test(patientName);
        if (!isReturn) return false;
      }
      // Must be a patient delivery OR after-hours pickup
      return d.patient_id || d.after_hours_pickup;
    };

    // Helper: Check if store was paying fees on a specific date
    const wasPayingFeesOnDate = (store, dateStr) => {
      if (!store.app_fee_history || store.app_fee_history.length === 0) {
        return store.pays_app_fees || false;
      }
      
      const sortedHistory = [...store.app_fee_history].sort((a, b) => 
        new Date(a.effective_date) - new Date(b.effective_date)
      );
      
      // Find the most recent entry that is on or before the target date
      let payingFees = false;
      for (const entry of sortedHistory) {
        if (entry.effective_date <= dateStr) {
          payingFees = entry.pays_app_fees;
        } else {
          break;
        }
      }
      
      return payingFees;
    };

    // Get deliveries for the month
    const deliveries = await base44.asServiceRole.entities.Delivery.filter({
      delivery_date: { $gte: startOfMonth, $lte: endOfMonthStr }
    });
    
    console.log(`📦 [getStoreMetrics] Loaded ${deliveries.length} deliveries for ${targetMonth}/${targetYear}`);
    
    // Calculate metrics per store
    const storeMetrics = [];
    
    for (const store of stores) {
      // Skip if filtering by specific store and this isn't it
      if (storeId && store.id !== storeId) continue;
      
      // Get deliveries for this store
      const storeDeliveries = deliveries.filter(d => d.store_id === store.id);
      
      // Count billable deliveries per day, checking fee status for each date
      let totalBillable = 0;
      let billableWhilePayingFees = 0;
      
      // Group deliveries by date to check fee status
      const deliveriesByDate = {};
      storeDeliveries.forEach(d => {
        if (!d.delivery_date) return;
        if (!deliveriesByDate[d.delivery_date]) {
          deliveriesByDate[d.delivery_date] = [];
        }
        deliveriesByDate[d.delivery_date].push(d);
      });
      
      // Process each date
      for (const [dateStr, dayDeliveries] of Object.entries(deliveriesByDate)) {
        const billableForDay = dayDeliveries.filter(isBillableDelivery);
        totalBillable += billableForDay.length;
        
        // Check if store was paying fees on this date
        if (wasPayingFeesOnDate(store, dateStr)) {
          billableWhilePayingFees += billableForDay.length;
        }
      }
      
      // Calculate fees
      const totalFees = billableWhilePayingFees * appFeeRate;
      
      // Get current fee status period
      const history = store.app_fee_history || [];
      const sortedHistory = [...history].sort((a, b) => 
        new Date(b.effective_date) - new Date(a.effective_date)
      );
      const currentPeriod = sortedHistory.find(h => h.pays_app_fees);
      const endPeriod = currentPeriod ? sortedHistory.find(h => 
        !h.pays_app_fees && new Date(h.effective_date) > new Date(currentPeriod.effective_date)
      ) : null;
      
      storeMetrics.push({
        store_id: store.id,
        store_name: store.name,
        store_abbreviation: store.abbreviation,
        pays_app_fees: store.pays_app_fees || false,
        current_fee_period: currentPeriod ? {
          start: currentPeriod.effective_date,
          end: endPeriod?.effective_date || null
        } : null,
        total_deliveries: storeDeliveries.length,
        billable_deliveries: totalBillable,
        billable_while_paying: billableWhilePayingFees,
        app_fee_rate: appFeeRate,
        total_fees_owed: totalFees,
        app_fee_history: history
      });
    }
    
    // Sort by store name
    storeMetrics.sort((a, b) => a.store_name.localeCompare(b.store_name));
    
    // Calculate totals
    const totals = {
      total_stores: storeMetrics.length,
      stores_paying_fees: storeMetrics.filter(s => s.pays_app_fees).length,
      total_billable_deliveries: storeMetrics.reduce((sum, s) => sum + s.billable_deliveries, 0),
      total_billable_while_paying: storeMetrics.reduce((sum, s) => sum + s.billable_while_paying, 0),
      total_fees_owed: storeMetrics.reduce((sum, s) => sum + s.total_fees_owed, 0),
      app_fee_rate: appFeeRate
    };
    
    console.log('✅ [getStoreMetrics] Metrics calculated:', {
      stores: storeMetrics.length,
      totalFees: totals.total_fees_owed.toFixed(2)
    });
    
    return Response.json({
      year: targetYear,
      month: targetMonth,
      stores: storeMetrics,
      totals
    });
    
  } catch (error) {
    console.error('❌ Error in getStoreMetrics:', error);
    return Response.json({ 
      error: error.message || 'Unknown error'
    }, { status: 500 });
  }
});