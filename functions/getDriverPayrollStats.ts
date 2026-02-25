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

    console.log('👤 [Payroll Stats] Looking up driver:', appUser?.user_name || 'NOT FOUND', 'for date:', deliveryDate);

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

    console.log('📋 [Payroll Stats] Found', deliveries.length, 'deliveries for', appUser.user_name);
    if (deliveries.length > 0) {
      console.log('📋 [Payroll Stats] Sample deliveries:', deliveries.slice(0, 5).map(d => ({ 
        delivery_date: d.delivery_date, 
        driver_name: d.driver_name,
        actual_time: d.actual_delivery_time,
        status: d.status,
        patient: d.patient_name 
      })));
    }

    // Calculate stats
    const finishedStatuses = ['completed', 'failed', 'cancelled'];

    // Count completed deliveries
    // CRITICAL: Patient deliveries count when completed OR failed
    // Pickups count ONLY when they have after_hours_pickup = true AND (completed OR cancelled)
    const completedPatientDeliveries = deliveries.filter(d => 
      d.patient_id && !d.no_charge && (d.status === 'completed' || d.status === 'failed')
    );

    const completedAfterHoursPickups = deliveries.filter(d => 
      !d.patient_id && d.after_hours_pickup === true && !d.no_charge && (d.status === 'completed' || d.status === 'cancelled')
    );

    const completedDeliveries = [...completedPatientDeliveries, ...completedAfterHoursPickups];

    // Count oversized deliveries
    const oversizedCount = completedDeliveries.filter(d => d.oversized === true).length;

    // CRITICAL: Fetch all patients to get distance_from_store
    const allPatients = await base44.entities.Patient.list();
    const patientMap = new Map(allPatients.map(p => [p.id, p]));

    // Sort completed deliveries by stop_order to process in sequence
    completedDeliveries.sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));

    // Helper: Calculate time difference between two stops in minutes
    const getTimeDifferenceMinutes = (delivery1, delivery2) => {
      const time1 = delivery1.actual_delivery_time 
        ? new Date(delivery1.actual_delivery_time)
        : delivery1.delivery_time_eta 
          ? new Date(`2000-01-01T${delivery1.delivery_time_eta}:00`)
          : delivery1.delivery_time_start 
            ? new Date(`2000-01-01T${delivery1.delivery_time_start}:00`)
            : null;
      
      const time2 = delivery2.actual_delivery_time 
        ? new Date(delivery2.actual_delivery_time)
        : delivery2.delivery_time_eta 
          ? new Date(`2000-01-01T${delivery2.delivery_time_eta}:00`)
          : delivery2.delivery_time_start 
            ? new Date(`2000-01-01T${delivery2.delivery_time_start}:00`)
            : null;
      
      if (!time1 || !time2) return 0;
      
      return Math.abs(time2 - time1) / (1000 * 60); // Convert to minutes
    };

    // Calculate total kilometers and extra kilometers per delivery
    // CRITICAL: Exclude segments with > 90 minute gaps
    let totalKm = 0;
    let totalExtraKm = 0;

    completedDeliveries.forEach((d, index) => {
      // Check if this segment should be excluded (gap > 90 min from previous stop)
      if (index > 0) {
        const prevDelivery = completedDeliveries[index - 1];
        const timeDiffMinutes = getTimeDifferenceMinutes(prevDelivery, d);
        
        if (timeDiffMinutes > 90) {
          console.log(`⏭️ Excluding segment from stats - ${timeDiffMinutes.toFixed(0)} min gap exceeds 90 min threshold`);
          return; // Skip this delivery's distance from totals
        }
      }
      
      // Total km = actual distance traveled (travel_dist)
      totalKm += (d.travel_dist || 0);

      // Do not award extra km for No Charge deliveries
      if (d.no_charge) {
        return;
      }

      // Extra km = based on paid_km_override or patient.distance_from_store
      let paidDistance = 0;

      if (d.paid_km_override !== null && d.paid_km_override !== undefined) {
        paidDistance = d.paid_km_override;
      } else if (d.patient_id) {
        const patient = patientMap.get(d.patient_id);
        paidDistance = patient?.distance_from_store || 0;
      }

      // Extra km: if paid distance > limit, add the excess
      if (paidDistance > extraKmLimit) {
        totalExtraKm += (paidDistance - extraKmLimit);
      }
    });

    // Calculate total pay
    const deliveryPay = completedDeliveries.length * payRatePerDelivery;
    const extraKmPay = totalExtraKm * extraKmRate;
    const oversizedPay = oversizedCount * oversizedRate;
    const totalPay = deliveryPay + extraKmPay + oversizedPay;

    // Calculate time on duty
    // If route complete: first stop to last stop, minus breaks
    // If route in progress: first stop to now, minus breaks
    let totalTimeOnDuty = '00:00';

    // CRITICAL: Include ALL completed stops (patient deliveries AND pickups) for time calculation
    const completedWithTime = deliveries
      .filter(d => d.status === 'completed' && d.actual_delivery_time)
      .sort((a, b) => new Date(a.actual_delivery_time) - new Date(b.actual_delivery_time));

    if (completedWithTime.length > 0) {
      // CRITICAL: Parse timestamps - strip timezone offsets like -0700 or Z
      // Timestamps should be stored without timezone info (local time only)
      const parseLocalTime = (isoString) => {
        // Remove timezone suffix (Z or ±HHMM like -0700, +0530, etc.)
        const withoutTz = isoString.replace(/[Z]$/, '').replace(/[+-]\d{4}$/, '');
        return new Date(withoutTz);
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