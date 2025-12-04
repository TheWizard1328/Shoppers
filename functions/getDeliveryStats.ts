import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';
import { format, startOfMonth, endOfMonth, startOfYear, endOfYear } from 'npm:date-fns@3.6.0';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let body = {};
    try {
      body = await req.json();
    } catch (e) {
      // No body or invalid JSON - use defaults
    }
    const { selectedDate, driverId, storeIds } = body;
    
    const now = selectedDate ? new Date(selectedDate + 'T00:00:00') : new Date();
    const monthStart = format(startOfMonth(now), 'yyyy-MM-dd');
    const monthEnd = format(endOfMonth(now), 'yyyy-MM-dd');
    const yearStart = format(startOfYear(now), 'yyyy-MM-dd');
    const yearEnd = format(endOfYear(now), 'yyyy-MM-dd');
    const todayStr = format(now, 'yyyy-MM-dd');

    // Build base filter
    const baseFilter = {};
    if (storeIds && storeIds.length > 0) {
      baseFilter.store_id = { $in: storeIds };
    }
    if (driverId && driverId !== 'all') {
      baseFilter.driver_id = driverId;
    }

    // Fetch deliveries for the month (for daily stats)
    const monthDeliveries = await base44.entities.Delivery.filter({
      ...baseFilter,
      delivery_date: { $gte: monthStart, $lte: monthEnd }
    }, '-delivery_date', 5000);

    // Fetch deliveries for the year (just to count unique dates)
    const yearDeliveries = await base44.entities.Delivery.filter({
      ...baseFilter,
      delivery_date: { $gte: yearStart, $lte: yearEnd }
    }, '-delivery_date', 5000);

    // Calculate stats
    const todayDeliveries = monthDeliveries.filter(d => d.delivery_date === todayStr);
    
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

    // Month stats
    const monthCompleted = monthDeliveries.filter(d => 
      ['completed', 'delivered'].includes(d.status) && isCountableDelivery(d)
    ).length;
    const monthReturns = monthDeliveries.filter(isReturn).length;
    const monthFailed = monthDeliveries.filter(d => 
      d.status === 'failed' && !isReturn(d) && isCountableDelivery(d)
    ).length;

    // Route counts (unique dates)
    const monthlyRouteCount = new Set(
      monthDeliveries.filter(d => d.delivery_date).map(d => d.delivery_date)
    ).size;
    const yearlyRouteCount = new Set(
      yearDeliveries.filter(d => d.delivery_date).map(d => d.delivery_date)
    ).size;

    return Response.json({
      today: {
        completed: todayCompleted,
        activeStops: todayActiveStops,
        returns: todayReturns,
        failed: todayFailed,
        activeDrivers: todayActiveDrivers
      },
      month: {
        completed: monthCompleted,
        returns: monthReturns,
        failed: monthFailed
      },
      routeCounts: {
        monthly: monthlyRouteCount,
        yearly: yearlyRouteCount
      }
    });

  } catch (error) {
    console.error('getDeliveryStats error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});