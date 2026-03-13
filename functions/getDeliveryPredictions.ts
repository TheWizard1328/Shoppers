import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

const REQUEST_LIMIT = 1000;

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

    const [allPatientsRaw, allDeliveriesRaw] = await Promise.all([
      base44.entities.Patient.list('full_name', REQUEST_LIMIT * 4),
      base44.entities.Delivery.list('-created_date', REQUEST_LIMIT * 4)
    ]);

    const allPatients = Array.isArray(allPatientsRaw) ? allPatientsRaw : [];
    const existingDeliveries = (Array.isArray(allDeliveriesRaw) ? allDeliveriesRaw : []).filter((delivery) => {
      if (!delivery) return false;
      return delivery.delivery_date === selectedDate && targetStoreIds.includes(delivery.store_id);
    });

    const patients = allPatients.filter((patient) => {
      if (!patient) return false;
      if (patient.status !== 'active') return false;
      if (!targetStoreIds.includes(patient.store_id)) return false;
      if (!patient) return false;
      return patient.recurring ||
        patient.recurring_daily ||
        patient.recurring_weekly_mon || patient.recurring_weekly_tue || patient.recurring_weekly_wed ||
        patient.recurring_weekly_thu || patient.recurring_weekly_fri || patient.recurring_weekly_sat || patient.recurring_weekly_sun ||
        patient.recurring_biweekly || patient.recurring_weekly_x4 || patient.recurring_monthly || patient.recurring_bimonthly;
    });

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
          frequency = 'Every 2 Weeks';
        }
      } else if (patient.recurring_weekly_x4) {
        if (!lastDate) {
          shouldDeliver = true;
          frequency = 'Every 4 Weeks';
        } else {
          const dayDiff = Math.abs(selectedDateObj.getDate() - lastDate.getDate());
          if (dayDiff <= 3) {
            shouldDeliver = true;
            frequency = 'Every 4 Weeks';
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
          frequency = 'Every 2 Months';
        } else {
          const dayDiff = Math.abs(selectedDateObj.getDate() - lastDate.getDate());
          if (dayDiff <= 3) {
            shouldDeliver = true;
            frequency = 'Every 2 Months';
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
    return Response.json({ error: error.message }, { status: 500 });
  }
});