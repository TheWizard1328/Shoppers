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

    // Filter patients based on their recurring schedule
    const predictions = [];
    const excludeSet = new Set(excludePatientIds);

    for (const patient of patients) {
      if (!patient || excludeSet.has(patient.id)) continue;

      // Check if this patient should have a delivery on the selected date
      let shouldDeliver = false;
      let frequency = null;

      // Daily deliveries
      if (patient.recurring_daily) {
        shouldDeliver = true;
        frequency = 'daily';
      }
      // Weekly deliveries - check specific day
      else if (patient[`recurring_weekly_${selectedDayName}`]) {
        shouldDeliver = true;
        frequency = 'weekly';
      }
      // Bi-weekly deliveries - check specific day and week parity
      else if (patient.recurring_biweekly && patient[`recurring_weekly_${selectedDayName}`]) {
        // For bi-weekly, check if it's the right week based on last_delivery_date
        if (patient.last_delivery_date) {
          const lastDate = new Date(patient.last_delivery_date + 'T00:00:00');
          const daysDiff = Math.floor((selectedDateObj - lastDate) / (1000 * 60 * 60 * 24));
          // Should deliver if at least 14 days have passed
          if (daysDiff >= 14) {
            shouldDeliver = true;
            frequency = 'biweekly';
          }
        } else {
          shouldDeliver = true;
          frequency = 'biweekly';
        }
      }
      // 4x weekly deliveries - check specific day
      else if (patient.recurring_weekly_x4) {
        // Count how many days are selected for this patient
        const selectedDays = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
          .filter(d => patient[`recurring_weekly_${d}`]);
        if (selectedDays.includes(selectedDayName)) {
          shouldDeliver = true;
          frequency = '4x_weekly';
        }
      }
      // Monthly deliveries
      else if (patient.recurring_monthly) {
        // Check if last delivery was at least 28 days ago
        if (patient.last_delivery_date) {
          const lastDate = new Date(patient.last_delivery_date + 'T00:00:00');
          const daysDiff = Math.floor((selectedDateObj - lastDate) / (1000 * 60 * 60 * 24));
          if (daysDiff >= 28) {
            shouldDeliver = true;
            frequency = 'monthly';
          }
        } else {
          shouldDeliver = true;
          frequency = 'monthly';
        }
      }
      // Bi-monthly deliveries
      else if (patient.recurring_bimonthly) {
        // Check if last delivery was at least 56 days ago
        if (patient.last_delivery_date) {
          const lastDate = new Date(patient.last_delivery_date + 'T00:00:00');
          const daysDiff = Math.floor((selectedDateObj - lastDate) / (1000 * 60 * 60 * 24));
          if (daysDiff >= 56) {
            shouldDeliver = true;
            frequency = 'bimonthly';
          }
        } else {
          shouldDeliver = true;
          frequency = 'bimonthly';
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