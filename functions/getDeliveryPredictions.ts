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

    // Helper: Check if lastDate falls within +/- windowDays of any cycle back from selectedDateObj
    const matchesCyclePattern = (lastDate, intervalDays, windowDays, maxCycles, patientName = '', patternType = '') => {
      const debugInfo = [];
      for (let i = 1; i <= maxCycles; i++) {
        const expectedDate = new Date(selectedDateObj);
        expectedDate.setDate(selectedDateObj.getDate() - (i * intervalDays));
        
        const minDate = new Date(expectedDate);
        minDate.setDate(expectedDate.getDate() - windowDays);
        const maxDate = new Date(expectedDate);
        maxDate.setDate(expectedDate.getDate() + windowDays);
        
        const daysDiff = Math.floor((lastDate - expectedDate) / (1000 * 60 * 60 * 24));
        debugInfo.push(`Cycle ${i}: expected=${expectedDate.toISOString().split('T')[0]}, range=[${minDate.toISOString().split('T')[0]} to ${maxDate.toISOString().split('T')[0]}], diff=${daysDiff}d`);
        
        if (lastDate >= minDate && lastDate <= maxDate) {
          console.log(`[Predictions] ✅ MATCH: ${patientName} (${patternType}) - last=${lastDate.toISOString().split('T')[0]} matched cycle ${i} (${expectedDate.toISOString().split('T')[0]} ±${windowDays}d)`);
          return true;
        }
      }
      // Log near-misses (within 7 days of any expected cycle)
      for (let i = 1; i <= maxCycles; i++) {
        const expectedDate = new Date(selectedDateObj);
        expectedDate.setDate(selectedDateObj.getDate() - (i * intervalDays));
        const daysDiff = Math.abs(Math.floor((lastDate - expectedDate) / (1000 * 60 * 60 * 24)));
        if (daysDiff <= 7 && daysDiff > windowDays) {
          console.log(`[Predictions] ⚠️ NEAR-MISS: ${patientName} (${patternType}) - last=${lastDate.toISOString().split('T')[0]}, expected cycle ${i}=${expectedDate.toISOString().split('T')[0]}, off by ${daysDiff}d (needs ≤${windowDays}d)`);
        }
      }
      return false;
    };

    const predictions = [];
    const excludeSet = new Set(excludePatientIds);
    const lookbackWindowDays = 2; // +/- 2 days for flexible matching
    const maxCyclesBack = 3; // Check up to 3 cycles back

    console.log(`[Predictions] Processing ${patients.length} recurring patients for ${selectedDate} (${selectedDayName})`);

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

      let shouldDeliver = false;
      let frequency = null;

      const hasDaySelected = patient[`recurring_weekly_${selectedDayName}`];
      const lastDate = patient.last_delivery_date ? new Date(patient.last_delivery_date + 'T00:00:00') : null;
      const daysSinceLast = lastDate ? Math.floor((selectedDateObj - lastDate) / (1000 * 60 * 60 * 24)) : null;

      // NEW RULES:
      // 1) Daily: Show unless no delivery in past 3 days (means they're inactive)
      if (patient.recurring_daily) {
        if (!lastDate || daysSinceLast <= 3) {
          shouldDeliver = true;
          frequency = 'Daily';
        } else {
          console.log(`[Predictions] ❌ SKIP: ${patient.full_name} (Daily) - last delivery ${daysSinceLast} days ago > 3 days`);
        }
      }
      // 2) Weekly: Show on selected day, unless last delivery > 14 days ago
      else if (hasDaySelected && !patient.recurring_biweekly && !patient.recurring_weekly_x4) {
        if (!lastDate || daysSinceLast <= 14) {
          shouldDeliver = true;
          frequency = 'Weekly';
          console.log(`[Predictions] ✅ MATCH: ${patient.full_name} (Weekly) - daysSinceLast=${daysSinceLast}`);
        } else {
          console.log(`[Predictions] ❌ SKIP: ${patient.full_name} (Weekly) - last delivery ${daysSinceLast} days ago > 14 days`);
        }
      }
      // 3) Bi-Weekly: Show on selected day, unless last delivery > 28 days ago
      else if (patient.recurring_biweekly && hasDaySelected) {
        if (!lastDate || daysSinceLast <= 28) {
          shouldDeliver = true;
          frequency = 'Every 2 Weeks';
          console.log(`[Predictions] ✅ MATCH: ${patient.full_name} (Bi-Weekly) - daysSinceLast=${daysSinceLast}`);
        } else {
          console.log(`[Predictions] ❌ SKIP: ${patient.full_name} (Bi-Weekly) - last delivery ${daysSinceLast} days ago > 28 days`);
        }
      }
      // 4) Weekly x4: Show on selected day +/- 2 days, unless last delivery > 56 days ago
      else if (patient.recurring_weekly_x4) {
        // Check if selected day matches the weekly_x4_day field OR any recurring_weekly_X flag, with +/- 2 day tolerance
        const x4Day = patient.recurring_weekly_x4_day;
        const dayIndexMap = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
        const targetDayIndex = x4Day ? dayIndexMap[x4Day] : null;
        
        let dayMatches = false;
        if (targetDayIndex !== null) {
          // Check if selected day is within +/- 2 days of the target day
          const diff = Math.abs(dayOfWeek - targetDayIndex);
          const wrappedDiff = Math.min(diff, 7 - diff); // Handle week wrap-around
          dayMatches = wrappedDiff <= 2;
        }
        
        if (dayMatches) {
          if (!lastDate || daysSinceLast <= 56) {
            shouldDeliver = true;
            frequency = 'Every 4 Weeks';
            console.log(`[Predictions] ✅ MATCH: ${patient.full_name} (Weekly x4) - daysSinceLast=${daysSinceLast}, day=${selectedDayName} within ±2 of ${x4Day}`);
          } else {
            console.log(`[Predictions] ❌ SKIP: ${patient.full_name} (Weekly x4) - last delivery ${daysSinceLast} days ago > 56 days`);
          }
        } else {
          console.log(`[Predictions] ❌ SKIP: ${patient.full_name} (Weekly x4) - day ${selectedDayName} not within ±2 of ${x4Day}`);
        }
      }
      // 5) Monthly: Show +/- 3 days of last delivery date, unless last delivery > 60 days ago
      else if (patient.recurring_monthly) {
        if (!lastDate) {
          shouldDeliver = true;
          frequency = 'Monthly';
        } else if (daysSinceLast > 60) {
          console.log(`[Predictions] ❌ SKIP: ${patient.full_name} (Monthly) - last delivery ${daysSinceLast} days ago > 60 days`);
        } else {
          // Check if we're within +/- 3 days of the monthly anniversary
          const lastDayOfMonth = lastDate.getDate();
          const selectedDayOfMonth = selectedDateObj.getDate();
          const dayDiff = Math.abs(selectedDayOfMonth - lastDayOfMonth);
          // Also check if we're at least ~27 days out (to avoid showing too early)
          if (daysSinceLast >= 27 && dayDiff <= 3) {
            shouldDeliver = true;
            frequency = 'Monthly';
            console.log(`[Predictions] ✅ MATCH: ${patient.full_name} (Monthly) - daysSinceLast=${daysSinceLast}, dayOfMonth diff=${dayDiff}`);
          } else {
            console.log(`[Predictions] ❌ SKIP: ${patient.full_name} (Monthly) - daysSinceLast=${daysSinceLast}, dayOfMonth diff=${dayDiff}`);
          }
        }
      }
      // 6) Bi-Monthly: Show +/- 3 days of last delivery date, unless last delivery > 120 days ago
      else if (patient.recurring_bimonthly) {
        if (!lastDate) {
          shouldDeliver = true;
          frequency = 'Every 2 Months';
        } else if (daysSinceLast > 120) {
          console.log(`[Predictions] ❌ SKIP: ${patient.full_name} (Bi-Monthly) - last delivery ${daysSinceLast} days ago > 120 days`);
        } else {
          // Check if we're within +/- 3 days of the bi-monthly anniversary
          const lastDayOfMonth = lastDate.getDate();
          const selectedDayOfMonth = selectedDateObj.getDate();
          const dayDiff = Math.abs(selectedDayOfMonth - lastDayOfMonth);
          // Also check if we're at least ~57 days out (to avoid showing too early)
          if (daysSinceLast >= 57 && dayDiff <= 3) {
            shouldDeliver = true;
            frequency = 'Every 2 Months';
            console.log(`[Predictions] ✅ MATCH: ${patient.full_name} (Bi-Monthly) - daysSinceLast=${daysSinceLast}, dayOfMonth diff=${dayDiff}`);
          } else {
            console.log(`[Predictions] ❌ SKIP: ${patient.full_name} (Bi-Monthly) - daysSinceLast=${daysSinceLast}, dayOfMonth diff=${dayDiff}`);
          }
        }
      }

      // Additional validation: skip if last delivery was today or in the future
      if (shouldDeliver && lastDate && lastDate >= selectedDateObj) {
        shouldDeliver = false;
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