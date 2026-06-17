import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

/**
 * calculateDriverPayroll
 * 
 * Triggered by an entity automation whenever a Delivery status changes to or from
 * a "finished" state (completed, failed, cancelled) or an "active" state
 * (pending, in_transit, en_route).
 * 
 * Recalculates the driver's Payroll record for the pay period that contains
 * the delivery's date, using the same logic as getDriverPayrollStats.
 * 
 * Only updates Payroll records that are still in 'draft' status — finalized
 * records are left untouched.
 */

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

// Determine the pay period date range for a given date and pay cycle type
const getPayPeriodRange = (deliveryDate, payCycleType) => {
  const date = new Date(deliveryDate + 'T00:00:00');
  const year = date.getFullYear();
  const month = date.getMonth();
  const day = date.getDate();

  switch (payCycleType) {
    case 'weekly': {
      const dayOfWeek = date.getDay(); // 0=Sun
      const daysFromMonday = (dayOfWeek + 6) % 7;
      const monday = new Date(date);
      monday.setDate(day - daysFromMonday);
      const sunday = new Date(monday);
      sunday.setDate(monday.getDate() + 6);
      return {
        start: monday.toISOString().slice(0, 10),
        end: sunday.toISOString().slice(0, 10),
        type: 'weekly'
      };
    }
    case 'biweekly': {
      // Anchor: first Monday on or before Jan 1 of the year
      const jan1 = new Date(year, 0, 1);
      const jan1Day = jan1.getDay();
      const daysFromMonday = (jan1Day + 6) % 7;
      const anchor = new Date(year, 0, 1 - daysFromMonday);
      const msPerDay = 24 * 60 * 60 * 1000;
      const daysSinceAnchor = Math.floor((date - anchor) / msPerDay);
      const periodNumber = Math.floor(daysSinceAnchor / 14);
      const periodStart = new Date(anchor.getTime() + periodNumber * 14 * msPerDay);
      const periodEnd = new Date(periodStart.getTime() + 13 * msPerDay);
      return {
        start: periodStart.toISOString().slice(0, 10),
        end: periodEnd.toISOString().slice(0, 10),
        type: 'biweekly'
      };
    }
    case 'semimonthly': {
      if (day <= 15) {
        const end = new Date(year, month, 15);
        return {
          start: new Date(year, month, 1).toISOString().slice(0, 10),
          end: end.toISOString().slice(0, 10),
          type: 'semimonthly'
        };
      } else {
        const lastDay = new Date(year, month + 1, 0).getDate();
        return {
          start: new Date(year, month, 16).toISOString().slice(0, 10),
          end: new Date(year, month, lastDay).toISOString().slice(0, 10),
          type: 'semimonthly'
        };
      }
    }
    case 'monthly':
    default: {
      const lastDay = new Date(year, month + 1, 0).getDate();
      return {
        start: new Date(year, month, 1).toISOString().slice(0, 10),
        end: new Date(year, month, lastDay).toISOString().slice(0, 10),
        type: 'monthly'
      };
    }
  }
};

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);

    // Parse the entity automation payload
    const body = await req.json();
    const deliveryData = body?.data;
    const eventType = body?.event?.type;

    if (!deliveryData) {
      return Response.json({ success: false, error: 'No delivery data in payload' }, { status: 400 });
    }

    const driverId = deliveryData.driver_id;
    const deliveryDate = deliveryData.delivery_date;

    if (!driverId || !deliveryDate) {
      console.log('⏭️ [PayrollCalc] Skipping — no driver_id or delivery_date on record');
      return Response.json({ success: true, skipped: true, reason: 'no_driver_or_date' });
    }

    console.log(`🔄 [PayrollCalc] Triggered by ${eventType} on delivery ${deliveryData.id} — driver: ${driverId}, date: ${deliveryDate}, status: ${deliveryData.status}`);

    // Get driver's AppUser record for pay rates and pay cycle
    const appUserRecords = await base44.asServiceRole.entities.AppUser.filter({ user_id: driverId });
    const appUser = appUserRecords?.[0];

    if (!appUser) {
      console.log(`⚠️ [PayrollCalc] AppUser not found for driver_id: ${driverId}`);
      return Response.json({ success: false, error: 'Driver AppUser not found' });
    }

    const payCycleType = appUser.pay_cycle_type || 'monthly';
    const payRatePerDelivery = appUser.pay_rate_per_delivery || 0;
    const extraKmRate = appUser.extra_km_rate || 0;
    const extraKmLimit = appUser.extra_km_limit || 0;
    const oversizedRate = appUser.oversized_item_rate || 0;
    const afterHoursRate = appUser.after_hours_rate || 0;
    const gstHstEnabled = appUser.gst_hst_enabled || false;

    // Determine pay period
    const period = getPayPeriodRange(deliveryDate, payCycleType);
    console.log(`📅 [PayrollCalc] Pay period: ${period.start} → ${period.end} (${payCycleType})`);

    // Fetch all deliveries for this driver within the pay period
    const allDeliveries = await base44.asServiceRole.entities.Delivery.filter({ driver_id: driverId });
    const periodDeliveries = allDeliveries.filter(d =>
      d.delivery_date >= period.start && d.delivery_date <= period.end
    );

    console.log(`📋 [PayrollCalc] Found ${periodDeliveries.length} deliveries in pay period for driver ${appUser.user_name || driverId}`);

    // Fetch patients for distance_from_store calculations
    const allPatients = await base44.asServiceRole.entities.Patient.list();
    const patientMap = new Map(allPatients.map(p => [p.id, p]));

    const isPatientReturn = (delivery) => {
      if (!delivery?.patient_id) return false;
      const patient = patientMap.get(delivery.patient_id);
      return String(patient?.address || '').toUpperCase().includes('(RTN)');
    };

    // ISD/ISP inter-store deliveries are always counted as deliveries (never pickups)
    const isInterStore = (d) => {
      const id = String(d?.delivery_id || '').toUpperCase();
      return id.startsWith('ISD-') || id.startsWith('ISP-');
    };

    // --- Count countable deliveries (same logic as getDriverPayrollStats) ---
    // Patient deliveries: completed or failed (or cancelled if it's a return)
    // Also includes ISD/ISP inter-store deliveries (they have no patient_id but are payable)
    const countablePatientDeliveries = periodDeliveries.filter(d =>
      (d.patient_id || isInterStore(d)) && !d.no_charge &&
      ((d.status === 'completed' || d.status === 'failed') ||
       (d.status === 'cancelled' && isPatientReturn(d)))
    );

    // After-hours pickups: no patient_id, NOT inter-store, after_hours_pickup=true, completed or cancelled
    const countableAfterHoursPickups = periodDeliveries.filter(d =>
      !d.patient_id && !isInterStore(d) && d.after_hours_pickup === true && !d.no_charge &&
      (d.status === 'completed' || d.status === 'cancelled')
    );

    const countableDeliveries = [...countablePatientDeliveries, ...countableAfterHoursPickups];
    countableDeliveries.sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));

    const oversizedCount = countableDeliveries.filter(d => d.oversized === true).length;
    const afterHoursCount = countableAfterHoursPickups.length;

    // --- Calculate extra km ---
    const getTimeDiffMinutes = (d1, d2) => {
      const t = (d) => d.actual_delivery_time
        ? new Date(d.actual_delivery_time.replace(/[Z]$/, '').replace(/[+-]\d{4}$/, ''))
        : d.delivery_time_eta
          ? new Date(`2000-01-01T${d.delivery_time_eta}:00`)
          : d.delivery_time_start
            ? new Date(`2000-01-01T${d.delivery_time_start}:00`)
            : null;
      const t1 = t(d1); const t2 = t(d2);
      if (!t1 || !t2) return 0;
      return Math.abs(t2 - t1) / 60000;
    };

    let totalExtraKm = 0;
    countableDeliveries.forEach((d, i) => {
      if (i > 0 && getTimeDiffMinutes(countableDeliveries[i - 1], d) > 90) return;
      if (d.no_charge) return;
      let paidDistance = 0;
      if (d.paid_km_override != null) {
        paidDistance = d.paid_km_override;
      } else if (d.patient_id) {
        paidDistance = patientMap.get(d.patient_id)?.distance_from_store || 0;
      }
      // ISD/ISP: paid_km_override is the only source (no patient record) — already handled above
      if (paidDistance > extraKmLimit) {
        totalExtraKm += (paidDistance - extraKmLimit);
      }
    });

    // --- Calculate gross pay ---
    const deliveryPay = countableDeliveries.length * payRatePerDelivery;
    const extraKmPay = round2(totalExtraKm * extraKmRate);
    const oversizedPay = round2(oversizedCount * oversizedRate);
    const afterHoursPay = round2(afterHoursCount * afterHoursRate);
    const grossPay = round2(deliveryPay + extraKmPay + oversizedPay + afterHoursPay);

    // --- GST/HST ---
    const gstRate = 0.05;
    const taxAmount = gstHstEnabled ? round2(grossPay * gstRate) : 0;

    const netPay = round2(grossPay + taxAmount);

    console.log(`💰 [PayrollCalc] Totals — deliveries: ${countableDeliveries.length}, grossPay: $${grossPay}, extraKm: ${round2(totalExtraKm)}km, oversized: ${oversizedCount}, afterHours: ${afterHoursCount}`);

    // --- Find or create Payroll record ---
    const existingRecords = await base44.asServiceRole.entities.Payroll.filter({
      driver_id: driverId,
      pay_period_start: period.start,
      pay_period_end: period.end
    });

    const existingRecord = existingRecords?.[0];

    // Don't overwrite finalized records
    if (existingRecord && existingRecord.status !== 'draft') {
      console.log(`🔒 [PayrollCalc] Payroll record ${existingRecord.id} is ${existingRecord.status} — skipping update`);
      return Response.json({ success: true, skipped: true, reason: 'record_finalized', status: existingRecord.status });
    }

    const payrollFields = {
      total_deliveries: countableDeliveries.length,
      total_extra_km: round2(totalExtraKm),
      total_oversized_deliveries: oversizedCount,
      total_after_hours_deliveries: afterHoursCount,
      gross_pay: grossPay,
      net_pay: netPay,
      tax_amount: taxAmount,
      pay_rate_per_delivery: round2(payRatePerDelivery),
      extra_km_rate: round2(extraKmRate),
      extra_km_limit: round2(extraKmLimit),
      oversized_item_rate: round2(oversizedRate),
      after_hours_rate: round2(afterHoursRate),
      gst_hst_enabled: gstHstEnabled,
    };

    let recordId;
    if (existingRecord) {
      await base44.asServiceRole.entities.Payroll.update(existingRecord.id, payrollFields);
      recordId = existingRecord.id;
      console.log(`✅ [PayrollCalc] Updated Payroll record ${recordId} for driver ${appUser.user_name || driverId}`);
    } else if (countableDeliveries.length > 0) {
      // Only create a new record if there are actual deliveries to pay
      const cityId = appUser.city_id || (appUser.city_ids?.[0]) || null;
      const newRecord = await base44.asServiceRole.entities.Payroll.create({
        driver_id: driverId,
        city_id: cityId,
        pay_period_start: period.start,
        pay_period_end: period.end,
        pay_period_type: payCycleType,
        status: 'draft',
        ...payrollFields
      });
      recordId = newRecord.id;
      console.log(`✅ [PayrollCalc] Created new Payroll record ${recordId} for driver ${appUser.user_name || driverId}`);
    } else {
      console.log(`ℹ️ [PayrollCalc] No countable deliveries in period — skipping record creation`);
      return Response.json({ success: true, skipped: true, reason: 'no_countable_deliveries' });
    }

    return Response.json({
      success: true,
      recordId,
      driverId,
      period,
      totals: {
        deliveries: countableDeliveries.length,
        grossPay,
        netPay,
        taxAmount,
        totalExtraKm: round2(totalExtraKm),
        oversizedCount,
        afterHoursCount
      }
    });

  } catch (error) {
    console.error('❌ [PayrollCalc] Error:', error.message);
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
});