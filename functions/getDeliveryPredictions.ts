import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const { selectedDate, storeIds, excludePatientIds = [], userRoles = [] } = body;

    if (!selectedDate) {
      return Response.json({ error: 'selectedDate is required' }, { status: 400 });
    }

    // Parse the selected date
    const dateParts = selectedDate.split('-');
    const year = parseInt(dateParts[0], 10);
    const month = parseInt(dateParts[1], 10) - 1;
    const day = parseInt(dateParts[2], 10);
    const selectedDateObj = new Date(year, month, day);
    const dayOfWeek = selectedDateObj.getDay();

    // Map day of week to recurring field names
    const dayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    const selectedDayName = dayNames[dayOfWeek];

    // Build patient filter
    let patientFilter = { 
      recurring: true,
      status: 'active'
    };

    // Filter by store IDs if provided
    if (storeIds && storeIds.length > 0) {
      patientFilter.store_id = { $in: storeIds };
    }

    // Fetch recurring patients
    const patients = await base44.entities.Patient.filter(patientFilter, 'full_name', 500);

    // CRITICAL: Fetch all deliveries for selected date to exclude patients already on routes
    // This includes: pending, in_transit, en_route, completed, failed statuses
    let existingDeliveriesFilter = {
      delivery_date: selectedDate
    };
    if (storeIds && storeIds.length > 0) {
      existingDeliveriesFilter.store_id = { $in: storeIds };
    }
    
    const existingDeliveries = await base44.entities.Delivery.filter(existingDeliveriesFilter, '-created_date', 1000);
    
    // Build set of patient IDs that already have deliveries on selected date
    const patientsWithDeliveries = new Set();
    for (const delivery of existingDeliveries) {
      if (delivery && delivery.patient_id) {
        patientsWithDeliveries.add(delivery.patient_id);
      }
    }
    console.log(`[Predictions] Found ${patientsWithDeliveries.size} patients already with deliveries on ${selectedDate}`);

    // Helper function to count weeks between two dates (same day of week)
    const getWeeksBetween = (fromDate, toDate) => {
      const diffTime = toDate - fromDate;
      const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
      return Math.floor(diffDays / 7);
    };

    // Helper function to find the last delivery on the same day of week
    const findLastDeliveryOnSameDay = (patientId, targetDayOfWeek, beforeDate) => {
      // Look through existing deliveries for this patient on the same day of week
      const patientDeliveries = existingDeliveries.filter(d => 
        d && d.patient_id === patientId && d.status === 'completed'
      );
      
      let lastMatchingDate = null;
      for (const delivery of patientDeliveries) {
        if (!delivery.delivery_date) continue;
        const deliveryDate = new Date(delivery.delivery_date + 'T00:00:00');
        if (deliveryDate.getDay() === targetDayOfWeek && deliveryDate < beforeDate) {
          if (!lastMatchingDate || deliveryDate > lastMatchingDate) {
            lastMatchingDate = deliveryDate;
          }
        }
      }
      return lastMatchingDate;
    };

    // Filter patients based on their recurring schedule
    const predictions = [];
    const excludeSet = new Set(excludePatientIds);

    for (const patient of patients) {
      if (!patient || excludeSet.has(patient.id)) continue;
      
      // CRITICAL: Skip patients who already have a delivery on this date (in any driver's route)
      if (patientsWithDeliveries.has(patient.id)) {
        continue;
      }
      
      // CRITICAL: Skip inactive patients
      if (patient.status === 'inactive') {
        continue;
      }

      // Check if this patient should have a delivery on the selected date
      let shouldDeliver = false;
      let frequency = null;

      // Check if patient has this day selected for weekly patterns
      const hasDaySelected = patient[`recurring_weekly_${selectedDayName}`];

      // Daily deliveries - check first (highest frequency)
      if (patient.recurring_daily) {
        shouldDeliver = true;
        frequency = 'Daily';
      }
      // CRITICAL: Check Weekly x4 BEFORE Bi-Weekly BEFORE Weekly (more specific patterns first)
      // Weekly x4 (Every 4 Weeks) - check specific day and 4-week interval
      else if (patient.recurring_weekly_x4) {
        // Weekly x4 requires a day selected
        if (hasDaySelected) {
          if (patient.last_delivery_date) {
            const lastDate = new Date(patient.last_delivery_date + 'T00:00:00');
            const daysDiff = Math.floor((selectedDateObj - lastDate) / (1000 * 60 * 60 * 24));
            // Should deliver if at least 28 days have passed
            if (daysDiff >= 28) {
              shouldDeliver = true;
              frequency = 'Every 4 Weeks';
            }
          } else {
            // No last delivery - include in predictions
            shouldDeliver = true;
            frequency = 'Every 4 Weeks';
          }
        }
      }
      // Bi-weekly deliveries (Every 2 Weeks) - check BEFORE weekly
      else if (patient.recurring_biweekly) {
        // Bi-weekly requires a day selected
        if (hasDaySelected) {
          if (patient.last_delivery_date) {
            const lastDate = new Date(patient.last_delivery_date + 'T00:00:00');
            const daysDiff = Math.floor((selectedDateObj - lastDate) / (1000 * 60 * 60 * 24));
            // Should deliver if at least 14 days have passed
            if (daysDiff >= 14) {
              shouldDeliver = true;
              frequency = 'Every 2 Weeks';
            }
          } else {
            // No last delivery - include in predictions
            shouldDeliver = true;
            frequency = 'Every 2 Weeks';
          }
        }
      }
      // Weekly deliveries (Every Week) - check LAST among weekly patterns
      // Only if NOT biweekly and NOT weekly_x4 (those were already checked above)
      else if (hasDaySelected) {
        if (patient.last_delivery_date) {
          const lastDate = new Date(patient.last_delivery_date + 'T00:00:00');
          const daysDiff = Math.floor((selectedDateObj - lastDate) / (1000 * 60 * 60 * 24));
          // Should deliver if at least 7 days have passed
          if (daysDiff >= 7) {
            shouldDeliver = true;
            frequency = 'Weekly';
          }
        } else {
          // No last delivery - include in predictions
          shouldDeliver = true;
          frequency = 'Weekly';
        }
      }
      // Monthly deliveries
      else if (patient.recurring_monthly) {
        if (patient.last_delivery_date) {
          const lastDate = new Date(patient.last_delivery_date + 'T00:00:00');
          const daysDiff = Math.floor((selectedDateObj - lastDate) / (1000 * 60 * 60 * 24));
          if (daysDiff >= 28) {
            shouldDeliver = true;
            frequency = 'Monthly';
          }
        } else {
          shouldDeliver = true;
          frequency = 'Monthly';
        }
      }
      // Bi-monthly deliveries
      else if (patient.recurring_bimonthly) {
        if (patient.last_delivery_date) {
          const lastDate = new Date(patient.last_delivery_date + 'T00:00:00');
          const daysDiff = Math.floor((selectedDateObj - lastDate) / (1000 * 60 * 60 * 24));
          if (daysDiff >= 56) {
            shouldDeliver = true;
            frequency = 'Every 2 Months';
          }
        } else {
          shouldDeliver = true;
          frequency = 'Every 2 Months';
        }
      }

      // Additional validation: skip if last delivery was today or in the future
      if (shouldDeliver && patient.last_delivery_date) {
        const lastDate = new Date(patient.last_delivery_date + 'T00:00:00');
        if (lastDate >= selectedDateObj) {
          shouldDeliver = false;
        }
      }

      if (shouldDeliver) {
        predictions.push({
          patient_id: patient.id,
          patient_name: patient.full_name,
          patient_address: patient.address,
          patient_phone: patient.phone,
          store_id: patient.store_id,
          frequency: frequency,
          last_delivery_date: patient.last_delivery_date,
          // Include patient preferences for display
          mailbox_ok: patient.mailbox_ok,
          call_upon_arrival: patient.call_upon_arrival,
          ring_bell: patient.ring_bell,
          dont_ring_bell: patient.dont_ring_bell,
          back_door: patient.back_door,
          time_window_start: patient.time_window_start,
          time_window_end: patient.time_window_end,
          notes: patient.notes,
          latitude: patient.latitude,
          longitude: patient.longitude,
          unit_number: patient.unit_number
        });
      }
    }

    // Sort predictions by patient name
    predictions.sort((a, b) => (a.patient_name || '').localeCompare(b.patient_name || ''));

    return Response.json({ 
      predictions,
      count: predictions.length,
      selectedDate,
      dayOfWeek: selectedDayName
    });

  } catch (error) {
    console.error('Error fetching delivery predictions:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});