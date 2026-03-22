import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

// Day of week mapping
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Analyzes delivery dates to detect recurring patterns.
 * Returns an array of possible patterns sorted by confidence (highest first).
 */
function analyzeDeliveryPattern(deliveryDates) {
  if (!deliveryDates || deliveryDates.length < 3) return [];

  // Sort dates ascending
  const sorted = [...deliveryDates].sort((a, b) => new Date(a) - new Date(b));
  const timestamps = sorted.map(d => new Date(d).getTime());
  const msPerDay = 86400000;

  // Calculate intervals between consecutive deliveries (in days)
  const intervals = [];
  for (let i = 1; i < timestamps.length; i++) {
    intervals.push(Math.round((timestamps[i] - timestamps[i - 1]) / msPerDay));
  }

  const patterns = [];

  // --- DAILY (interval ~1 day, allow 1-2 day gaps) ---
  const nearDailyCount = intervals.filter(d => d <= 3).length;
  if (nearDailyCount / intervals.length >= 0.8) {
    patterns.push({
      pattern_key: 'recurring_daily',
      pattern_label: 'Daily',
      confidence: Math.round(80 + (nearDailyCount / intervals.length) * 20),
      supporting_data: `${nearDailyCount} of ${intervals.length} intervals were 1-3 days apart`
    });
  }

  // --- WEEKLY (interval ~7 days, allow ±3 days, tolerate occasional missed weeks up to ~14 days) ---
  const weeklyIntervalCount = intervals.filter(d => (d >= 4 && d <= 10) || (d >= 11 && d <= 17)).length;
  const strictWeekly = intervals.filter(d => d >= 4 && d <= 10).length;
  if (strictWeekly / intervals.length >= 0.5 || weeklyIntervalCount / intervals.length >= 0.65) {
    // Determine most common delivery day of week
    const dayCounts = {};
    sorted.forEach(d => {
      const day = new Date(d).getDay();
      dayCounts[day] = (dayCounts[day] || 0) + 1;
    });
    const dominantDay = Object.entries(dayCounts).sort((a, b) => b[1] - a[1])[0];
    const dayKey = `recurring_weekly_${DAY_NAMES[dominantDay[0]]}`;
    const dayLabel = `Weekly (${DAY_LABELS[dominantDay[0]]})`;
    const dayRatio = dominantDay[1] / sorted.length;

    patterns.push({
      pattern_key: dayKey,
      pattern_label: dayLabel,
      confidence: Math.round(60 + (weeklyIntervalCount / intervals.length) * 25 + dayRatio * 15),
      supporting_data: `${weeklyIntervalCount} of ${intervals.length} intervals suggest ~weekly cadence; most common day: ${DAY_LABELS[dominantDay[0]]} (${Math.round(dayRatio * 100)}% of deliveries)`
    });
  }

  // --- BIWEEKLY (interval ~14 days, allow ±4 days) ---
  const biweeklyCount = intervals.filter(d => d >= 10 && d <= 18).length;
  // biweekly should NOT also fit weekly
  const strictWeeklyRatio = intervals.filter(d => d >= 4 && d <= 10).length / intervals.length;
  if (biweeklyCount / intervals.length >= 0.5 && strictWeeklyRatio < 0.5) {
    patterns.push({
      pattern_key: 'recurring_biweekly',
      pattern_label: 'Bi-Weekly (every 2 weeks)',
      confidence: Math.round(55 + (biweeklyCount / intervals.length) * 30),
      supporting_data: `${biweeklyCount} of ${intervals.length} intervals were ~14 days apart`
    });
  }

  // --- WEEKLY x4 (4 times per month, ~7-8 days apart, very consistent) ---
  // Distinct from weekly: 4 deliveries per calendar month on a consistent day
  const monthDeliveryCounts = {};
  sorted.forEach(d => {
    const key = d.substring(0, 7); // YYYY-MM
    monthDeliveryCounts[key] = (monthDeliveryCounts[key] || 0) + 1;
  });
  const months = Object.values(monthDeliveryCounts);
  const avgPerMonth = months.reduce((a, b) => a + b, 0) / months.length;
  const x4Months = months.filter(c => c >= 3 && c <= 5).length;
  if (x4Months / months.length >= 0.6 && avgPerMonth >= 3.2 && avgPerMonth <= 4.8) {
    // Determine dominant day
    const dayCounts = {};
    sorted.forEach(d => {
      const day = new Date(d).getDay();
      dayCounts[day] = (dayCounts[day] || 0) + 1;
    });
    const dominantDay = Object.entries(dayCounts).sort((a, b) => b[1] - a[1])[0];
    const dayName = DAY_NAMES[dominantDay[0]];
    patterns.push({
      pattern_key: 'recurring_weekly_x4',
      pattern_label: `Weekly x4 (${DAY_LABELS[dominantDay[0]]}, ~4x/month)`,
      confidence: Math.round(50 + (x4Months / months.length) * 30),
      supporting_data: `Average ${avgPerMonth.toFixed(1)} deliveries/month; ${x4Months} of ${months.length} months had 3-5 deliveries`,
      x4_day: dayName
    });
  }

  // --- MONTHLY (interval ~28-35 days) ---
  const monthlyCount = intervals.filter(d => d >= 22 && d <= 42).length;
  if (monthlyCount / intervals.length >= 0.5) {
    patterns.push({
      pattern_key: 'recurring_monthly',
      pattern_label: 'Monthly',
      confidence: Math.round(55 + (monthlyCount / intervals.length) * 30),
      supporting_data: `${monthlyCount} of ${intervals.length} intervals were ~28-35 days apart`
    });
  }

  // --- BIMONTHLY (interval ~55-70 days) ---
  const bimonthlyCount = intervals.filter(d => d >= 50 && d <= 75).length;
  if (bimonthlyCount / intervals.length >= 0.5) {
    patterns.push({
      pattern_key: 'recurring_bimonthly',
      pattern_label: 'Bi-Monthly (every 2 months)',
      confidence: Math.round(50 + (bimonthlyCount / intervals.length) * 30),
      supporting_data: `${bimonthlyCount} of ${intervals.length} intervals were ~60 days apart`
    });
  }

  // Sort by confidence descending
  patterns.sort((a, b) => b.confidence - a.confidence);

  // Cap confidence at 99
  return patterns.map(p => ({ ...p, confidence: Math.min(p.confidence, 99) }));
}

/**
 * Check if a patient already has any recurring pattern set
 */
function patientHasRecurringPattern(patient) {
  return !!(
    patient.recurring_daily ||
    patient.recurring_weekly_mon || patient.recurring_weekly_tue ||
    patient.recurring_weekly_wed || patient.recurring_weekly_thu ||
    patient.recurring_weekly_fri || patient.recurring_weekly_sat ||
    patient.recurring_weekly_sun ||
    patient.recurring_biweekly ||
    patient.recurring_weekly_x4 ||
    patient.recurring_monthly ||
    patient.recurring_bimonthly
  );
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (user?.role !== 'admin') {
      return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    // Optional: pass store_id to run for a specific store only (used by scheduler)
    const targetStoreId = body.store_id || null;
    const todayDow = new Date().getDay(); // 0=Sun ... 6=Sat
    const today = new Date().toISOString().split('T')[0];
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    const sixMonthsAgoStr = sixMonthsAgo.toISOString().split('T')[0];

    // Fetch all active stores
    const allStores = await base44.asServiceRole.entities.Store.filter({ status: 'active' });

    // Determine which stores to scan today
    let storesToScan = allStores.filter(store => {
      if (targetStoreId) return store.id === targetStoreId;
      // If store has a scan day configured, only scan on that day
      if (store.patient_scan_day !== undefined && store.patient_scan_day !== null) {
        return store.patient_scan_day === todayDow;
      }
      return false; // Skip stores without a configured scan day unless explicitly targeted
    });

    if (storesToScan.length === 0) {
      return Response.json({
        message: 'No stores scheduled for scanning today',
        today_dow: todayDow,
        stores_checked: allStores.length
      });
    }

    const results = {
      stores_scanned: [],
      patients_flagged_inactive: 0,
      patterns_ambiguous: 0,
      patterns_detected: 0,
      errors: []
    };

    for (const store of storesToScan) {
      try {
        // Fetch all active patients for this store
        const patients = await base44.asServiceRole.entities.Patient.filter({
          store_id: store.id,
          status: 'active'
        });

        let storeResult = { store_id: store.id, store_name: store.name, patients_processed: 0 };

        for (const patient of patients) {
          try {
            // Fetch all completed deliveries for this patient (last 12 months for pattern analysis)
            const twelveMonthsAgo = new Date();
            twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);
            const twelveMonthsAgoStr = twelveMonthsAgo.toISOString().split('T')[0];

            const deliveries = await base44.asServiceRole.entities.Delivery.filter({
              patient_id: patient.id,
              status: 'completed'
            });

            const recentDeliveries = deliveries.filter(d => d.delivery_date >= twelveMonthsAgoStr);
            const lastDelivery = deliveries.length > 0
              ? deliveries.sort((a, b) => b.delivery_date.localeCompare(a.delivery_date))[0]
              : null;

            const lastDeliveryDate = lastDelivery?.delivery_date || patient.last_delivery_date || null;

            // --- CHECK INACTIVITY ---
            if (!lastDeliveryDate || lastDeliveryDate < sixMonthsAgoStr) {
              await base44.asServiceRole.entities.Patient.update(patient.id, { status: 'inactive' });

              await base44.asServiceRole.entities.PatientAnalysisResult.create({
                patient_id: patient.id,
                patient_name: patient.full_name,
                store_id: store.id,
                store_name: store.name,
                analysis_date: today,
                result_type: 'inactivity_flagged',
                last_delivery_date: lastDeliveryDate,
                total_deliveries_analyzed: deliveries.length,
                suggested_patterns: [],
                status: 'applied'
              });

              results.patients_flagged_inactive++;
              storeResult.patients_processed++;
              continue;
            }

            // --- PATTERN ANALYSIS (only if patient has no existing pattern) ---
            if (!patientHasRecurringPattern(patient) && recentDeliveries.length >= 3) {
              const deliveryDates = recentDeliveries.map(d => d.delivery_date);
              const suggestedPatterns = analyzeDeliveryPattern(deliveryDates);

              if (suggestedPatterns.length === 0) {
                // No clear pattern found
                storeResult.patients_processed++;
                continue;
              }

              // Check if there's a clear winner (top pattern significantly more confident)
              const topPattern = suggestedPatterns[0];
              const isAmbiguous = suggestedPatterns.length > 1 &&
                (topPattern.confidence - suggestedPatterns[1].confidence) < 20;

              const resultType = isAmbiguous ? 'pattern_ambiguous' : 'pattern_detected';

              // Check if a result already exists for this patient today (avoid duplicates)
              const existingResults = await base44.asServiceRole.entities.PatientAnalysisResult.filter({
                patient_id: patient.id,
                analysis_date: today
              });
              if (existingResults.length > 0) {
                storeResult.patients_processed++;
                continue;
              }

              await base44.asServiceRole.entities.PatientAnalysisResult.create({
                patient_id: patient.id,
                patient_name: patient.full_name,
                store_id: store.id,
                store_name: store.name,
                analysis_date: today,
                result_type: resultType,
                last_delivery_date: lastDeliveryDate,
                total_deliveries_analyzed: recentDeliveries.length,
                suggested_patterns: suggestedPatterns,
                status: 'pending_review'
              });

              if (isAmbiguous) results.patterns_ambiguous++;
              else results.patterns_detected++;

              storeResult.patients_processed++;
            }
          } catch (patientErr) {
            results.errors.push(`Patient ${patient.id} (${patient.full_name}): ${patientErr.message}`);
          }
        }

        results.stores_scanned.push(storeResult);
      } catch (storeErr) {
        results.errors.push(`Store ${store.id} (${store.name}): ${storeErr.message}`);
      }
    }

    return Response.json({ success: true, ...results });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});