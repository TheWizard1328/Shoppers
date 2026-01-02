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

    for (const patient of patients) {
      if (!patient) continue;
      
      if (excludeSet.has(patient.id)) {
        console.log(`[Predictions] SKIP ${patient.full_name}: in exclude list`);
        continue;
      }
      
      // Skip patients who already have a delivery on this date
      if (patientsWithDeliveries.has(patient.id)) {
        console.log(`[Predictions] SKIP ${patient.full_name}: already has delivery on ${selectedDate}`);
        continue;
      }

      let shouldDeliver = false;
      let frequency = null;

      const hasDaySelected = patient[`recurring_weekly_${selectedDayName}`];
      const lastDate = patient.last_delivery_date ? new Date(patient.last_delivery_date + 'T00:00:00') : null;
      const daysSinceLast = lastDate ? Math.floor((selectedDateObj - lastDate) / (1000 * 60 * 60 * 24)) : null;

      console.log(`[Predictions] Checking ${patient.full_name}: daily=${patient.recurring_daily}, weekly_${selectedDayName}=${hasDaySelected}, biweekly=${patient.recurring_biweekly}, x4=${patient.recurring_weekly_x4}, x4_day=${patient.recurring_weekly_x4_day}, monthly=${patient.recurring_monthly}, bimonthly=${patient.recurring_bimonthly}, lastDate=${patient.last_delivery_date}, daysSince=${daysSinceLast}`);

      // 1) Daily: Show unless no delivery in past 3 days
      if (patient.recurring_daily) {
        if (!lastDate || daysSinceLast <= 3) {
          shouldDeliver = true;
          frequency = 'Daily';
          console.log(`[Predictions] MATCH ${patient.full_name}: Daily`);
        } else {
          console.log(`[Predictions] SKIP ${patient.full_name}: Daily but ${daysSinceLast} days since last > 3`);
        }
      }
      // 2) Weekly: Show on selected day, unless last delivery > 14 days ago
      else if (hasDaySelected && !patient.recurring_biweekly && !patient.recurring_weekly_x4) {
        if (!lastDate || daysSinceLast <= 14) {
          shouldDeliver = true;
          frequency = 'Weekly';
          console.log(`[Predictions] MATCH ${patient.full_name}: Weekly on ${selectedDayName}`);
        } else {
          console.log(`[Predictions] SKIP ${patient.full_name}: Weekly but ${daysSinceLast} days since last > 14`);
        }
      }
      // 3) Bi-Weekly: Show on selected day, unless last delivery > 28 days ago
      else if (patient.recurring_biweekly && hasDaySelected) {
        if (!lastDate || daysSinceLast <= 28) {
          shouldDeliver = true;
          frequency = 'Every 2 Weeks';
          console.log(`[Predictions] MATCH ${patient.full_name}: Bi-Weekly on ${selectedDayName}`);
        } else {
          console.log(`[Predictions] SKIP ${patient.full_name}: Bi-Weekly but ${daysSinceLast} days since last > 28`);
        }
      }
      // 4) Weekly x4: Show on selected day +/- 2 days, unless last delivery > 56 days ago
      else if (patient.recurring_weekly_x4) {
        const x4Day = patient.recurring_weekly_x4_day;
        const dayIndexMap = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
        const targetDayIndex = x4Day ? dayIndexMap[x4Day] : null;
        
        let dayMatches = false;
        if (targetDayIndex !== null) {
          const diff = Math.abs(dayOfWeek - targetDayIndex);
          const wrappedDiff = Math.min(diff, 7 - diff);
          dayMatches = wrappedDiff <= 2;
          console.log(`[Predictions] ${patient.full_name}: x4 day check - target=${x4Day}(${targetDayIndex}), selected=${selectedDayName}(${dayOfWeek}), diff=${wrappedDiff}, matches=${dayMatches}`);
        } else if (hasDaySelected) {
          // Fallback: if no x4_day set but has a weekly day flag, use that
          dayMatches = true;
          console.log(`[Predictions] ${patient.full_name}: x4 fallback to hasDaySelected=${hasDaySelected}`);
        }
        
        if (dayMatches) {
          if (!lastDate || daysSinceLast <= 56) {
            shouldDeliver = true;
            frequency = 'Every 4 Weeks';
            console.log(`[Predictions] MATCH ${patient.full_name}: Weekly x4`);
          } else {
            console.log(`[Predictions] SKIP ${patient.full_name}: Weekly x4 but ${daysSinceLast} days since last > 56`);
          }
        } else {
          console.log(`[Predictions] SKIP ${patient.full_name}: Weekly x4 day mismatch (x4_day=${x4Day}, selected=${selectedDayName})`);
        }
      }
      // 5) Monthly: Show +/- 3 days of last delivery date, unless last delivery > 60 days ago
      else if (patient.recurring_monthly) {
        if (!lastDate) {
          shouldDeliver = true;
          frequency = 'Monthly';
          console.log(`[Predictions] MATCH ${patient.full_name}: Monthly (no last date)`);
        } else if (daysSinceLast > 60) {
          console.log(`[Predictions] SKIP ${patient.full_name}: Monthly but ${daysSinceLast} days since last > 60`);
        } else {
          const lastDayOfMonth = lastDate.getDate();
          const selectedDayOfMonth = selectedDateObj.getDate();
          const dayDiff = Math.abs(selectedDayOfMonth - lastDayOfMonth);
          if (daysSinceLast >= 27 && dayDiff <= 3) {
            shouldDeliver = true;
            frequency = 'Monthly';
            console.log(`[Predictions] MATCH ${patient.full_name}: Monthly (daysSince=${daysSinceLast}, dayDiff=${dayDiff})`);
          } else {
            console.log(`[Predictions] SKIP ${patient.full_name}: Monthly daysSince=${daysSinceLast} (<27?) or dayDiff=${dayDiff} (>3?)`);
          }
        }
      }
      // 6) Bi-Monthly: Show +/- 3 days of last delivery date, unless last delivery > 120 days ago
      else if (patient.recurring_bimonthly) {
        if (!lastDate) {
          shouldDeliver = true;
          frequency = 'Every 2 Months';
          console.log(`[Predictions] MATCH ${patient.full_name}: Bi-Monthly (no last date)`);
        } else if (daysSinceLast > 120) {
          console.log(`[Predictions] SKIP ${patient.full_name}: Bi-Monthly but ${daysSinceLast} days since last > 120`);
        } else {
          const lastDayOfMonth = lastDate.getDate();
          const selectedDayOfMonth = selectedDateObj.getDate();
          const dayDiff = Math.abs(selectedDayOfMonth - lastDayOfMonth);
          if (daysSinceLast >= 57 && dayDiff <= 3) {
            shouldDeliver = true;
            frequency = 'Every 2 Months';
            console.log(`[Predictions] MATCH ${patient.full_name}: Bi-Monthly (daysSince=${daysSinceLast}, dayDiff=${dayDiff})`);
          } else {
            console.log(`[Predictions] SKIP ${patient.full_name}: Bi-Monthly daysSince=${daysSinceLast} (<57?) or dayDiff=${dayDiff} (>3?)`);
          }
        }
      } else {
        // Patient has recurring flag but no specific pattern matched
        console.log(`[Predictions] SKIP ${patient.full_name}: has recurring flags but no pattern matched for ${selectedDayName}`);
      }

      // Skip if last delivery was today or in the future
      if (shouldDeliver && lastDate && lastDate >= selectedDateObj) {
        console.log(`[Predictions] SKIP ${patient.full_name}: last delivery ${patient.last_delivery_date} >= selected date`);
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

    console.log(`[Predictions] Final result: ${predictions.length} predictions`);

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