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

    // Calculate time on duty (first completed stop to last completed stop, minus breaks)
    let totalTimeOnDuty = '00:00';
    
    const completedWithTime = deliveries
      .filter(d => d.status === 'completed' && d.actual_delivery_time)
      .sort((a, b) => new Date(a.actual_delivery_time) - new Date(b.actual_delivery_time));

    if (completedWithTime.length > 0) {
      const firstStopTime = new Date(completedWithTime[0].actual_delivery_time);
      const lastStopTime = new Date(completedWithTime[completedWithTime.length - 1].actual_delivery_time);
      
      // Calculate duration in minutes
      const durationMinutes = Math.floor((lastStopTime - firstStopTime) / (1000 * 60));
      
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
        lastStop: lastStopTime.toISOString(),
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