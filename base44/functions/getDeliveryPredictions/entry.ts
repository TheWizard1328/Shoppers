import { createClientFromRequest } from 'npm:@base44/sdk@0.8.21';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const {
      selectedDate,
      storeIds = [],
      excludePatientIds = []
    } = body || {};

    if (!selectedDate) {
      return Response.json({ error: 'selectedDate is required' }, { status: 400 });
    }

    const dateParts = selectedDate.split('-');
    const year = parseInt(dateParts[0], 10);
    const month = parseInt(dateParts[1], 10) - 1;
    const day = parseInt(dateParts[2], 10);
    const selectedDateObj = new Date(year, month, day);
    const dayOfWeek = selectedDateObj.getDay();
    const dayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    const selectedDayName = dayNames[dayOfWeek];

    const targetStoreIds = Array.isArray(storeIds) ? storeIds.filter(Boolean) : [];
    if (targetStoreIds.length === 0) {
      return Response.json({ predictions: [], count: 0, selectedDate, dayOfWeek: selectedDayName });
    }

    const patientQueryBase = {
      status: 'active',
      store_id: { $in: targetStoreIds }
    };

    const patientQueryList = [
      { ...patientQueryBase, recurring: true },
      { ...patientQueryBase, recurring_daily: true },
      { ...patientQueryBase, [`recurring_weekly_${selectedDayName}`]: true },
      { ...patientQueryBase, recurring_biweekly: true },
      { ...patientQueryBase, recurring_weekly_x4: true },
      { ...patientQueryBase, recurring_monthly: true },
      { ...patientQueryBase, recurring_bimonthly: true }
    ];

    const [existingDeliveriesRaw, ...patientQueryResults] = await Promise.all([
      base44.entities.Delivery.filter({
        delivery_date: selectedDate,
        store_id: { $in: targetStoreIds }
      }, '-created_date', 2000),
      ...patientQueryList.map((query) => base44.entities.Patient.filter(query, 'full_name', 1000))
    ]);

    const patientsMap = new Map();
    patientQueryResults.forEach((resultSet) => {
      (Array.isArray(resultSet) ? resultSet : []).forEach((patient) => {
        if (patient?.id && !patientsMap.has(patient.id)) {
          patientsMap.set(patient.id, patient);
        }
      });
    });

    const patients = Array.from(patientsMap.values());
    const existingDeliveries = Array.isArray(existingDeliveriesRaw) ? existingDeliveriesRaw.filter(Boolean) : [];

    const patientsWithDeliveries = new Set();
    existingDeliveries.forEach((delivery) => {
      if (delivery?.patient_id) {
        patientsWithDeliveries.add(delivery.patient_id);
      }
    });

    const excludeSet = new Set(Array.isArray(excludePatientIds) ? excludePatientIds : []);
    const predictions = [];

    for (const patient of patients) {
      if (!patient || excludeSet.has(patient.id) || patientsWithDeliveries.has(patient.id)) {
        continue;
      }

      let shouldDeliver = false;
      let frequency = null;

      const hasDaySelected = patient[`recurring_weekly_${selectedDayName}`];
      const lastDate = patient.last_delivery_date ? new Date(patient.last_delivery_date + 'T00:00:00') : null;
      const daysSinceLast = lastDate ? Math.floor((selectedDateObj - lastDate) / (1000 * 60 * 60 * 24)) : null;

      if (patient.recurring_daily) {
        shouldDeliver = true;
        frequency = 'Daily';
      } else if (hasDaySelected && !patient.recurring_biweekly && !patient.recurring_weekly_x4) {
        shouldDeliver = true;
        frequency = 'Weekly';
      } else if (patient.recurring_biweekly && hasDaySelected) {
        if (!lastDate || daysSinceLast >= 14) {
          shouldDeliver = true;
          frequency = 'Bi-Weeks';
        }
      } else if (patient.recurring_weekly_x4) {
        if (!lastDate) {
          shouldDeliver = true;
          frequency = 'x4 Weeks';
        } else {
          const dayDiff = Math.abs(selectedDateObj.getDate() - lastDate.getDate());
          if (dayDiff <= 3) {
            shouldDeliver = true;
            frequency = 'x4 Weeks';
          }
        }
      } else if (patient.recurring_monthly) {
        if (!lastDate) {
          shouldDeliver = true;
          frequency = 'Monthly';
        } else {
          const dayDiff = Math.abs(selectedDateObj.getDate() - lastDate.getDate());
          if (dayDiff <= 3) {
            shouldDeliver = true;
            frequency = 'Monthly';
          }
        }
      } else if (patient.recurring_bimonthly) {
        if (!lastDate) {
          shouldDeliver = true;
          frequency = 'Bi-Monthly';
        } else {
          const dayDiff = Math.abs(selectedDateObj.getDate() - lastDate.getDate());
          if (dayDiff <= 3) {
            shouldDeliver = true;
            frequency = 'Bi-Monthly';
          }
        }
      }

      if (shouldDeliver && lastDate && lastDate >= selectedDateObj) {
        shouldDeliver = false;
      }

      if (!shouldDeliver) {
        continue;
      }

      predictions.push({
        patient_id: patient.id,
        patient_name: patient.full_name,
        patient_address: patient.address,
        patient_phone: patient.phone,
        store_id: patient.store_id,
        frequency,
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

    predictions.sort((a, b) => (a.patient_name || '').localeCompare(b.patient_name || ''));

    return Response.json({
      predictions,
      count: predictions.length,
      selectedDate,
      dayOfWeek: selectedDayName
    });
  } catch (error) {
    console.error('Error fetching delivery predictions:', error);
    if (error?.status === 429 || error?.response?.status === 429 || error?.message?.includes('Rate limit exceeded')) {
      return Response.json({ predictions: [], count: 0, selectedDate: null, dayOfWeek: null, rate_limited: true });
    }
    return Response.json({ error: error.message }, { status: 500 });
  }
});