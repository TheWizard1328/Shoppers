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

    console.log(`[Predictions] ========== START ==========`);
    console.log(`[Predictions] Selected Date: ${selectedDate}`);
    console.log(`[Predictions] Store IDs: ${JSON.stringify(storeIds)}`);
    console.log(`[Predictions] Exclude Patient IDs count: ${excludePatientIds.length}`);

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

    console.log(`[Predictions] Day of week: ${dayOfWeek} (${selectedDayName})`);

    // Build patient filter - fetch active patients, filter for recurring patterns in code
    let patientFilter = { 
      status: 'active'
    };

    // Filter by store IDs if provided
    if (storeIds && storeIds.length > 0) {
      patientFilter.store_id = { $in: storeIds };
    }

    // Fetch all active patients, then filter for those with any recurring pattern
    const allPatients = await base44.entities.Patient.filter(patientFilter, 'full_name', 2000);
    
    console.log(`[Predictions] Fetched ${allPatients.length} active patients total`);
    
    // Filter to only patients with at least one recurring pattern set
    const patients = allPatients.filter(p => {
      if (!p) return false;
      const hasRecurring = p.recurring || 
             p.recurring_daily || 
             p.recurring_weekly_mon || p.recurring_weekly_tue || p.recurring_weekly_wed ||
             p.recurring_weekly_thu || p.recurring_weekly_fri || p.recurring_weekly_sat || p.recurring_weekly_sun ||
             p.recurring_biweekly || p.recurring_weekly_x4 || p.recurring_monthly || p.recurring_bimonthly;
      return hasRecurring;
    });

    console.log(`[Predictions] Found ${patients.length} patients with recurring patterns`);
    
    // Log first 10 recurring patients for debugging
    if (patients.length > 0) {
      console.log(`[Predictions] Sample recurring patients:`);
      patients.slice(0, 10).forEach(p => {
        console.log(`  - ${p.full_name}: daily=${p.recurring_daily}, weekly_${selectedDayName}=${p[`recurring_weekly_${selectedDayName}`]}, biweekly=${p.recurring_biweekly}, x4=${p.recurring_weekly_x4}, monthly=${p.recurring_monthly}, bimonthly=${p.recurring_bimonthly}, last_delivery=${p.last_delivery_date}`);
      });
    }

    // CRITICAL: Fetch all deliveries for selected date to exclude patients already on routes
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

    const predictions = [];
    const excludeSet = new Set(excludePatientIds);

    console.log(`[Predictions] Processing ${patients.length} recurring patients for ${selectedDate} (${selectedDayName}, dayOfWeek=${dayOfWeek})`);

    let skippedAlreadyHasDelivery = 0;
    let skippedNoPatternMatch = 0;
    let skippedTooLongSinceLast = 0;
    let skippedFutureLastDelivery = 0;
    let matched = 0;

    for (const patient of patients) {
      if (!patient) continue;
      
      if (excludeSet.has(patient.id)) {
        continue;
      }
      
      // Skip patients who already have a delivery on this date
      if (patientsWithDeliveries.has(patient.id)) {
        skippedAlreadyHasDelivery++;
        continue;
      }

      let shouldDeliver = false;
      let frequency = null;
      let skipReason = null;

      const hasDaySelected = patient[`recurring_weekly_${selectedDayName}`];
      const lastDate = patient.last_delivery_date ? new Date(patient.last_delivery_date + 'T00:00:00') : null;
      const daysSinceLast = lastDate ? Math.floor((selectedDateObj - lastDate) / (1000 * 60 * 60 * 24)) : null;

      // 1) Daily: Always show (no time cap)
      if (patient.recurring_daily) {
        shouldDeliver = true;
        frequency = 'Daily';
      }
      // 2) Weekly: Show on selected day (no time cap)
      else if (hasDaySelected && !patient.recurring_biweekly && !patient.recurring_weekly_x4) {
        shouldDeliver = true;
        frequency = 'Weekly';
      }
      // 3) Bi-Weekly: Show on selected day if no last_delivery_date OR at least 14 days since last
      else if (patient.recurring_biweekly && hasDaySelected) {
        if (!lastDate || daysSinceLast >= 14) {
          shouldDeliver = true;
          frequency = 'Every 2 Weeks';
        } else {
          skipReason = `Bi-Weekly but only ${daysSinceLast} days since last (<14)`;
        }
      }
      // 4) Weekly x4: Show if no last_delivery_date OR day-of-month within +/- 3 days
      else if (patient.recurring_weekly_x4) {
        if (!lastDate) {
          shouldDeliver = true;
          frequency = 'Every 4 Weeks';
        } else {
          const lastDayOfMonth = lastDate.getDate();
          const selectedDayOfMonth = selectedDateObj.getDate();
          const dayDiff = Math.abs(selectedDayOfMonth - lastDayOfMonth);
          if (dayDiff <= 3) {
            shouldDeliver = true;
            frequency = 'Every 4 Weeks';
          } else {
            skipReason = `Weekly x4 dayDiff=${dayDiff} (>3)`;
          }
        }
      }
      // 5) Monthly: Show if no last_delivery_date OR day-of-month within +/- 3 days
      else if (patient.recurring_monthly) {
        if (!lastDate) {
          shouldDeliver = true;
          frequency = 'Monthly';
        } else {
          const lastDayOfMonth = lastDate.getDate();
          const selectedDayOfMonth = selectedDateObj.getDate();
          const dayDiff = Math.abs(selectedDayOfMonth - lastDayOfMonth);
          if (dayDiff <= 3) {
            shouldDeliver = true;
            frequency = 'Monthly';
          } else {
            skipReason = `Monthly dayDiff=${dayDiff} (>3)`;
          }
        }
      }
      // 6) Bi-Monthly: Show if no last_delivery_date OR day-of-month within +/- 3 days
      else if (patient.recurring_bimonthly) {
        if (!lastDate) {
          shouldDeliver = true;
          frequency = 'Every 2 Months';
        } else {
          const lastDayOfMonth = lastDate.getDate();
          const selectedDayOfMonth = selectedDateObj.getDate();
          const dayDiff = Math.abs(selectedDayOfMonth - lastDayOfMonth);
          if (dayDiff <= 3) {
            shouldDeliver = true;
            frequency = 'Every 2 Months';
          } else {
            skipReason = `Bi-Monthly dayDiff=${dayDiff} (>3)`;
          }
        }
      } else {
        // Patient has recurring flag but no specific pattern matched for today
        skipReason = `No pattern matched for ${selectedDayName}`;
      }

      // Skip if last delivery was today or in the future
      if (shouldDeliver && lastDate && lastDate >= selectedDateObj) {
        skipReason = `Last delivery ${patient.last_delivery_date} >= selected date`;
        shouldDeliver = false;
        skippedFutureLastDelivery++;
      }

      if (shouldDeliver) {
        matched++;
        predictions.push({
          patient_id: patient.id,
          patient_name: patient.full_name,
          patient_address: patient.address,
          patient_phone: patient.phone,
          store_id: patient.store_id,
          frequency: frequency,
          last_delivery_date: patient.last_delivery_date,
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
      } else {
        if (skipReason) {
          if (skipReason.includes('days >')) {
            skippedTooLongSinceLast++;
          } else {
            skippedNoPatternMatch++;
          }
          // Log individual skips for first 20 patients only
          if (skippedNoPatternMatch + skippedTooLongSinceLast <= 20) {
            console.log(`[Predictions] SKIP ${patient.full_name}: ${skipReason}`);
          }
        }
      }
    }

    // Sort predictions by patient name
    predictions.sort((a, b) => (a.patient_name || '').localeCompare(b.patient_name || ''));

    console.log(`[Predictions] ========== SUMMARY ==========`);
    console.log(`[Predictions] Total recurring patients: ${patients.length}`);
    console.log(`[Predictions] Skipped (already has delivery): ${skippedAlreadyHasDelivery}`);
    console.log(`[Predictions] Skipped (no pattern match for ${selectedDayName}): ${skippedNoPatternMatch}`);
    console.log(`[Predictions] Skipped (too long since last delivery): ${skippedTooLongSinceLast}`);
    console.log(`[Predictions] Skipped (last delivery >= selected date): ${skippedFutureLastDelivery}`);
    console.log(`[Predictions] MATCHED: ${matched}`);
    console.log(`[Predictions] ========== END ==========`);

    return Response.json({ 
      predictions,
      count: predictions.length,
      selectedDate,
      dayOfWeek: selectedDayName,
      debug: {
        totalRecurring: patients.length,
        skippedAlreadyHasDelivery,
        skippedNoPatternMatch,
        skippedTooLongSinceLast,
        skippedFutureLastDelivery,
        matched
      }
    });

  } catch (error) {
    console.error('Error fetching delivery predictions:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});