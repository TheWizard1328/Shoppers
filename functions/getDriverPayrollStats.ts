import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { driverId, deliveryDate } = await req.json();

    if (!driverId || !deliveryDate) {
      return Response.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // CRITICAL: Get AppUser record to fetch driver's pay rates
    const appUserRecords = await base44.entities.AppUser.filter({ user_id: driverId });
    const appUser = appUserRecords?.[0];

    console.log('👤 [Payroll Stats] Looking up driver:', { 
      driverId, 
      driverName: appUser?.user_name || 'NOT FOUND',
      deliveryDate 
    });

    if (!appUser) {
      return Response.json({ 
        success: false, 
        error: 'Driver not found',
        totalPay: 0,
        totalKm: 0,
        totalExtraKm: 0,
        totalTimeOnDuty: '00:00',
        extraKmLimit: 0
      });
    }

    // Get driver's current pay rates
    const payRatePerDelivery = appUser.pay_rate_per_delivery || 0;
    const extraKmRate = appUser.extra_km_rate || 0;
    const extraKmLimit = appUser.extra_km_limit || 0;
    const oversizedRate = appUser.oversized_item_rate || 0;

    // Get all deliveries for this driver on this date
    const deliveries = await base44.entities.Delivery.filter({
      driver_id: driverId,
      delivery_date: deliveryDate
    });

    console.log('📋 [Payroll Stats] Query params:', { driverId, deliveryDate });
    console.log('📋 [Payroll Stats] Found deliveries:', deliveries.length);
    console.log('📋 [Payroll Stats] Delivery dates:', deliveries.map(d => ({ 
      id: d.id.substring(0, 8), 
      delivery_date: d.delivery_date, 
      actual_time: d.actual_delivery_time,
      status: d.status,
      patient: d.patient_name 
    })));

    // Calculate stats
    const finishedStatuses = ['completed', 'failed', 'cancelled'];
    
    // Count completed deliveries (exclude pickups, failed, cancelled)
    const completedDeliveries = deliveries.filter(d => 
      d.patient_id && // Only patient deliveries
      d.status === 'completed' // Only completed
    );

    // Count oversized deliveries
    const oversizedCount = completedDeliveries.filter(d => d.oversized === true).length;

    // Calculate total kilometers (sum of all travel_dist)
    const totalKm = deliveries
      .filter(d => finishedStatuses.includes(d.status))
      .reduce((sum, d) => sum + (d.travel_dist || 0), 0);

    // Calculate extra kilometers (beyond the limit)
    const totalExtraKm = Math.max(0, totalKm - extraKmLimit);

    // Calculate total pay
    const deliveryPay = completedDeliveries.length * payRatePerDelivery;
    const extraKmPay = totalExtraKm * extraKmRate;
    const oversizedPay = oversizedCount * oversizedRate;
    const totalPay = deliveryPay + extraKmPay + oversizedPay;

    // Calculate time on duty
    // If route complete: first stop to last stop, minus breaks
    // If route in progress: first stop to now, minus breaks
    let totalTimeOnDuty = '00:00';
    
    const completedWithTime = deliveries
      .filter(d => d.status === 'completed' && d.actual_delivery_time)
      .sort((a, b) => new Date(a.actual_delivery_time) - new Date(b.actual_delivery_time));

    if (completedWithTime.length > 0) {
      // CRITICAL: Parse timestamps as UTC (they have 'Z' suffix) and convert to local Edmonton time
      // The timestamps are stored as ISO strings with Z (UTC), but represent local completion times
      const parseLocalTime = (isoString) => {
        // Remove 'Z' to treat as local time, not UTC
        const withoutZ = isoString.replace(/Z$/, '');
        return new Date(withoutZ);
      };
      
      const firstStopTime = parseLocalTime(completedWithTime[0].actual_delivery_time);
      
      // Check if route is still in progress
      const hasActiveDeliveries = deliveries.some(d => 
        ['pending', 'in_transit', 'en_route'].includes(d.status)
      );
      
      // Use current local time if route in progress, otherwise last completed stop
      const endTime = hasActiveDeliveries 
        ? new Date() 
        : parseLocalTime(completedWithTime[completedWithTime.length - 1].actual_delivery_time);
      
      // Calculate duration in minutes
      const durationMinutes = Math.floor((endTime - firstStopTime) / (1000 * 60));
      
      // Get break time from DriverDailyActivity
      let breakTimeMinutes = 0;
      try {
        const activityRecords = await base44.entities.DriverDailyActivity.filter({
          driver_id: driverId,
          activity_date: deliveryDate
        });
        
        if (activityRecords && activityRecords.length > 0) {
          breakTimeMinutes = activityRecords[0].total_break_time_minutes || 0;
        }
      } catch (error) {
        console.warn('Failed to fetch break time:', error);
      }
      
      // Subtract break time
      const workMinutes = Math.max(0, durationMinutes - breakTimeMinutes);
      
      // Format as HH:MM
      const hours = Math.floor(workMinutes / 60);
      const minutes = workMinutes % 60;
      totalTimeOnDuty = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
      
      console.log('⏰ Time on duty calculation:', {
        firstStop: firstStopTime.toISOString(),
        endTime: endTime.toISOString(),
        hasActiveDeliveries,
        durationMinutes,
        breakTimeMinutes,
        workMinutes,
        totalTimeOnDuty,
        completedCount: completedWithTime.length
      });
    }

    return Response.json({
      success: true,
      totalPay: totalPay,
      totalKm: totalKm,
      totalExtraKm: totalExtraKm,
      totalTimeOnDuty: totalTimeOnDuty,
      extraKmLimit: extraKmLimit,
      breakdown: {
        completedDeliveries: completedDeliveries.length,
        deliveryPay: deliveryPay,
        extraKmPay: extraKmPay,
        oversizedCount: oversizedCount,
        oversizedPay: oversizedPay
      }
    });
  } catch (error) {
    console.error('Error in getDriverPayrollStats:', error);
    return Response.json({ 
      success: false, 
      error: error.message,
      totalPay: 0,
      totalKm: 0,
      totalExtraKm: 0,
      totalTimeOnDuty: '00:00',
      extraKmLimit: 0
    }, { status: 500 });
  }
});