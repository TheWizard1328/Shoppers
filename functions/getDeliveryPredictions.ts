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
      
      // Debug: Log patient recurring flags
      const hasAnyWeeklyFlag = patient.recurring_weekly_mon || patient.recurring_weekly_tue || 
        patient.recurring_weekly_wed || patient.recurring_weekly_thu || 
        patient.recurring_weekly_fri || patient.recurring_weekly_sat || patient.recurring_weekly_sun;
      
      if (patient.recurring_weekly_x4 || patient.recurring_biweekly || hasAnyWeeklyFlag) {
        console.log(`[Predictions] Checking: ${patient.full_name} - weekly_x4=${patient.recurring_weekly_x4}, biweekly=${patient.recurring_biweekly}, hasDaySelected(${selectedDayName})=${hasDaySelected}, last=${patient.last_delivery_date}`);
      }

      // Daily deliveries - highest priority
      if (patient.recurring_daily) {
        shouldDeliver = true;
        frequency = 'Daily';
      }
      // CRITICAL: Check Weekly x4 BEFORE Bi-Weekly BEFORE Weekly (more specific patterns first)
      // Weekly x4 (Every 4 Weeks) - requires the specific day to be selected
      else if (patient.recurring_weekly_x4) {
        if (hasDaySelected) {
          if (!patient.last_delivery_date) {
            console.log(`[Predictions] ✅ MATCH: ${patient.full_name} (Weekly x4) - no last delivery, including`);
            shouldDeliver = true;
            frequency = 'Every 4 Weeks';
          } else {
            const lastDate = new Date(patient.last_delivery_date + 'T00:00:00');
            const daysSinceLast = Math.floor((selectedDateObj - lastDate) / (1000 * 60 * 60 * 24));
            // Include if: pattern matches OR at least 28 days have passed
            if (matchesCyclePattern(lastDate, 28, lookbackWindowDays, maxCyclesBack, patient.full_name, 'Weekly x4') || daysSinceLast >= 28) {
              console.log(`[Predictions] ✅ MATCH: ${patient.full_name} (Weekly x4) - daysSinceLast=${daysSinceLast}`);
              shouldDeliver = true;
              frequency = 'Every 4 Weeks';
            } else {
              console.log(`[Predictions] ❌ SKIP: ${patient.full_name} (Weekly x4) - daysSinceLast=${daysSinceLast} < 28 and no pattern match`);
            }
          }
        } else {
          console.log(`[Predictions] ❌ SKIP: ${patient.full_name} (Weekly x4) - day ${selectedDayName} not selected`);
        }
      }
      // Bi-weekly deliveries (Every 2 Weeks) - requires the specific day to be selected
      else if (patient.recurring_biweekly) {
        if (hasDaySelected) {
          if (!patient.last_delivery_date) {
            console.log(`[Predictions] ✅ MATCH: ${patient.full_name} (Bi-Weekly) - no last delivery, including`);
            shouldDeliver = true;
            frequency = 'Every 2 Weeks';
          } else {
            const lastDate = new Date(patient.last_delivery_date + 'T00:00:00');
            const daysSinceLast = Math.floor((selectedDateObj - lastDate) / (1000 * 60 * 60 * 24));
            // Include if: pattern matches OR at least 14 days have passed
            if (matchesCyclePattern(lastDate, 14, lookbackWindowDays, maxCyclesBack, patient.full_name, 'Bi-Weekly') || daysSinceLast >= 14) {
              console.log(`[Predictions] ✅ MATCH: ${patient.full_name} (Bi-Weekly) - daysSinceLast=${daysSinceLast}`);
              shouldDeliver = true;
              frequency = 'Every 2 Weeks';
            } else {
              console.log(`[Predictions] ❌ SKIP: ${patient.full_name} (Bi-Weekly) - daysSinceLast=${daysSinceLast} < 14 and no pattern match`);
            }
          }
        } else {
          console.log(`[Predictions] ❌ SKIP: ${patient.full_name} (Bi-Weekly) - day ${selectedDayName} not selected`);
        }
      }
      // Weekly deliveries (Every Week) - requires the specific day to be selected
      else if (hasDaySelected) {
        if (!patient.last_delivery_date) {
          console.log(`[Predictions] ✅ MATCH: ${patient.full_name} (Weekly) - no last delivery, including`);
          shouldDeliver = true;
          frequency = 'Weekly';
        } else {
          const lastDate = new Date(patient.last_delivery_date + 'T00:00:00');
          const daysSinceLast = Math.floor((selectedDateObj - lastDate) / (1000 * 60 * 60 * 24));
          // Include if: pattern matches OR at least 7 days have passed
          if (matchesCyclePattern(lastDate, 7, lookbackWindowDays, maxCyclesBack, patient.full_name, 'Weekly') || daysSinceLast >= 7) {
            console.log(`[Predictions] ✅ MATCH: ${patient.full_name} (Weekly) - daysSinceLast=${daysSinceLast}`);
            shouldDeliver = true;
            frequency = 'Weekly';
          } else {
            console.log(`[Predictions] ❌ SKIP: ${patient.full_name} (Weekly) - daysSinceLast=${daysSinceLast} < 7 and no pattern match`);
          }
        }
      }
      // Monthly deliveries
      else if (patient.recurring_monthly) {
        if (!patient.last_delivery_date) {
          shouldDeliver = true;
          frequency = 'Monthly';
        } else {
          const lastDate = new Date(patient.last_delivery_date + 'T00:00:00');
          const daysDiff = Math.floor((selectedDateObj - lastDate) / (1000 * 60 * 60 * 24));
          // For monthly, check if at least ~26 days have passed (28 - 2 day window)
          if (daysDiff >= 28 - lookbackWindowDays) {
            shouldDeliver = true;
            frequency = 'Monthly';
          }
        }
      }
      // Bi-monthly deliveries
      else if (patient.recurring_bimonthly) {
        if (!patient.last_delivery_date) {
          shouldDeliver = true;
          frequency = 'Every 2 Months';
        } else {
          const lastDate = new Date(patient.last_delivery_date + 'T00:00:00');
          const daysDiff = Math.floor((selectedDateObj - lastDate) / (1000 * 60 * 60 * 24));
          // For bi-monthly, check if at least ~54 days have passed (56 - 2 day window)
          if (daysDiff >= 56 - lookbackWindowDays) {
            shouldDeliver = true;
            frequency = 'Every 2 Months';
          }
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