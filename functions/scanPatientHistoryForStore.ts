import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

// Pattern detection constants
const INACTIVITY_MONTHS = 6;
const MIN_DELIVERIES_FOR_PATTERN = 3;
const LOOKBACK_DAYS = 365; // 1 year of history

/**
 * Detect delivery patterns from a sorted list of delivery dates (strings, 'YYYY-MM-DD')
 * Returns array of pattern candidates with confidence scores.
 */
function detectPatterns(deliveryDates) {
  if (!deliveryDates || deliveryDates.length < MIN_DELIVERIES_FOR_PATTERN) return [];

  // Convert to Date objects, sort ascending
  const dates = deliveryDates
    .map(d => new Date(d + 'T00:00:00'))
    .sort((a, b) => a - b);

  const candidates = [];

  // --- DAILY ---
  // >80% of consecutive gaps are 1 day
  const gaps = [];
  for (let i = 1; i < dates.length; i++) {
    gaps.push(Math.round((dates[i] - dates[i-1]) / (1000 * 60 * 60 * 24)));
  }
  const dailyGaps = gaps.filter(g => g === 1).length;
  if (dailyGaps / gaps.length >= 0.8 && dailyGaps >= 3) {
    candidates.push({
      pattern_key: 'recurring_daily',
      pattern_label: 'Daily',
      confidence: Math.round(90 + (dailyGaps / gaps.length) * 10),
      supporting_data: `${dailyGaps}/${gaps.length} consecutive days`
    });
    return candidates; // Daily is unambiguous
  }

  // --- WEEKLY: identify most common delivery day of week ---
  const dayOfWeekCounts = [0,0,0,0,0,0,0]; // Sun=0..Sat=6
  dates.forEach(d => dayOfWeekCounts[d.getDay()]++);
  const maxDayCount = Math.max(...dayOfWeekCounts);
  const dominantDow = dayOfWeekCounts.indexOf(maxDayCount);
  const dowNames = ['sun','mon','tue','wed','thu','fri','sat'];
  const dowLabels = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

  // Calculate weekly/biweekly/x4 intervals between deliveries ON the dominant day
  const dominantDates = dates.filter(d => d.getDay() === dominantDow);
  if (dominantDates.length >= 2) {
    const dominantGaps = [];
    for (let i = 1; i < dominantDates.length; i++) {
      dominantGaps.push(Math.round((dominantDates[i] - dominantDates[i-1]) / (1000 * 60 * 60 * 24)));
    }

    const weeklyGaps = dominantGaps.filter(g => g >= 5 && g <= 9).length;
    const biweeklyGaps = dominantGaps.filter(g => g >= 10 && g <= 18).length;
    const x4Gaps = dominantGaps.filter(g => g >= 25 && g <= 35).length;

    const weeklyRatio = weeklyGaps / dominantGaps.length;
    const biweeklyRatio = biweeklyGaps / dominantGaps.length;
    const x4Ratio = x4Gaps / dominantGaps.length;

    // Weekly: at least 60% of gaps are ~7 days (allows missed weeks)
    if (weeklyRatio >= 0.6 && weeklyGaps >= 3) {
      const dayKey = `recurring_weekly_${dowNames[dominantDow]}`;
      candidates.push({
        pattern_key: dayKey,
        pattern_label: `Weekly (${dowLabels[dominantDow]})`,
        confidence: Math.round(70 + weeklyRatio * 25),
        supporting_data: `${weeklyGaps}/${dominantGaps.length} gaps ~7 days on ${dowLabels[dominantDow]}`
      });
    }

    // Biweekly: at least 55% of gaps are ~14 days
    if (biweeklyRatio >= 0.55 && biweeklyGaps >= 3) {
      candidates.push({
        pattern_key: 'recurring_biweekly',
        pattern_label: 'Bi-Weekly',
        confidence: Math.round(65 + biweeklyRatio * 25),
        supporting_data: `${biweeklyGaps}/${dominantGaps.length} gaps ~14 days on ${dowLabels[dominantDow]}`
      });
    }

    // Weekly x4 (once a month on a day): at least 55% of gaps are ~28-35 days
    if (x4Ratio >= 0.55 && x4Gaps >= 3) {
      candidates.push({
        pattern_key: 'recurring_weekly_x4',
        pattern_label: `Weekly x4 (${dowLabels[dominantDow]})`,
        confidence: Math.round(60 + x4Ratio * 25),
        supporting_data: `${x4Gaps}/${dominantGaps.length} gaps ~28-35 days on ${dowLabels[dominantDow]}`,
        x4_day: dowNames[dominantDow]
      });
    }
  }

  // --- MONTHLY: check if deliveries cluster around same day-of-month ---
  const dayOfMonthCounts = {};
  dates.forEach(d => {
    const dom = d.getDate();
    // Allow +/-3 day window
    for (let offset = -3; offset <= 3; offset++) {
      const key = dom + offset;
      if (key >= 1 && key <= 28) {
        dayOfMonthCounts[key] = (dayOfMonthCounts[key] || 0) + 1;
      }
    }
  });
  const maxDomCount = Math.max(...Object.values(dayOfMonthCounts));
  const monthlyRatio = maxDomCount / dates.length;
  
  // Also check average gap
  const overallAvgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const monthlyGaps = gaps.filter(g => g >= 25 && g <= 40).length;

  if (monthlyRatio >= 0.6 && overallAvgGap >= 20 && overallAvgGap <= 45 && monthlyGaps >= 3) {
    candidates.push({
      pattern_key: 'recurring_monthly',
      pattern_label: 'Monthly',
      confidence: Math.round(60 + monthlyRatio * 20),
      supporting_data: `Avg gap ${Math.round(overallAvgGap)} days, clustered around same day of month`
    });
  }

  // --- BIMONTHLY: avg gap 50-75 days ---
  const biMonthlyGaps = gaps.filter(g => g >= 50 && g <= 75).length;
  if (overallAvgGap >= 50 && overallAvgGap <= 75 && biMonthlyGaps >= 3) {
    candidates.push({
      pattern_key: 'recurring_bimonthly',
      pattern_label: 'Bi-Monthly (Every 2 Months)',
      confidence: Math.round(55 + Math.min(20, (dates.length - 2) * 3)),
      supporting_data: `Avg gap ${Math.round(overallAvgGap)} days`
    });
  }

  // Sort by confidence descending
  candidates.sort((a, b) => b.confidence - a.confidence);
  return candidates;
}

function hasExistingPattern(patient) {
  return patient.recurring_daily ||
    patient.recurring_weekly_mon || patient.recurring_weekly_tue ||
    patient.recurring_weekly_wed || patient.recurring_weekly_thu ||
    patient.recurring_weekly_fri || patient.recurring_weekly_sat ||
    patient.recurring_weekly_sun ||
    patient.recurring_biweekly || patient.recurring_weekly_x4 ||
    patient.recurring_monthly || patient.recurring_bimonthly;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (user?.role !== 'admin') {
      return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
    }

    const payload = await req.json().catch(() => ({}));
    const { store_id } = payload; // Optional: run for a specific store only

    const today = new Date();
    const todayDow = today.getDay(); // 0=Sun..6=Sat
    const todayStr = today.toISOString().split('T')[0];

    // Load active stores
    let stores = await base44.asServiceRole.entities.Store.filter({ status: 'active' });
    
    // Filter to stores whose patient_scan_day matches today (or specific store)
    if (store_id) {
      stores = stores.filter(s => s.id === store_id);
    } else {
      stores = stores.filter(s => s.patient_scan_day === todayDow);
    }

    if (stores.length === 0) {
      return Response.json({ 
        message: `No active stores scheduled for scan on day ${todayDow} (${todayStr})`,
        stores_processed: 0
      });
    }

    console.log(`🔍 [PatientScan] Processing ${stores.length} stores for day ${todayDow}`);

    const sixMonthsAgo = new Date(today);
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - INACTIVITY_MONTHS);
    const sixMonthsAgoStr = sixMonthsAgo.toISOString().split('T')[0];

    const lookbackDate = new Date(today);
    lookbackDate.setDate(lookbackDate.getDate() - LOOKBACK_DAYS);
    const lookbackStr = lookbackDate.toISOString().split('T')[0];

    const summary = {
      stores_processed: stores.length,
      patients_scanned: 0,
      marked_inactive: 0,
      patterns_detected: 0,
      ambiguous_patterns: 0,
      analysis_results_created: 0,
      errors: []
    };

    for (const store of stores) {
      console.log(`🏪 [PatientScan] Processing store: ${store.name}`);

      // Get active patients for this store
      const patients = await base44.asServiceRole.entities.Patient.filter({
        store_id: store.id,
        status: 'active'
      });

      console.log(`  👥 Found ${patients.length} active patients`);

      for (const patient of patients) {
        summary.patients_scanned++;

        // Get completed deliveries for this patient in the lookback window
        const deliveries = await base44.asServiceRole.entities.Delivery.filter({
          patient_id: patient.id,
          status: 'completed',
          delivery_date: { $gte: lookbackStr, $lte: todayStr }
        });

        const deliveryDates = deliveries
          .map(d => d.delivery_date)
          .filter(Boolean)
          .sort();

        const lastDeliveryDate = deliveryDates.length > 0 
          ? deliveryDates[deliveryDates.length - 1] 
          : patient.last_delivery_date;

        // --- INACTIVITY CHECK ---
        if (!lastDeliveryDate || lastDeliveryDate < sixMonthsAgoStr) {
          console.log(`  ⚠️ Patient ${patient.full_name} inactive since ${lastDeliveryDate || 'never'}`);
          
          // Mark as inactive
          await base44.asServiceRole.entities.Patient.update(patient.id, { status: 'inactive' });
          summary.marked_inactive++;

          // Create analysis result for inactivity
          await base44.asServiceRole.entities.PatientAnalysisResult.create({
            patient_id: patient.id,
            patient_name: patient.full_name,
            store_id: store.id,
            store_name: store.name,
            analysis_date: todayStr,
            result_type: 'inactivity_flagged',
            last_delivery_date: lastDeliveryDate || null,
            total_deliveries_analyzed: deliveries.length,
            suggested_patterns: [],
            status: 'applied'
          });
          summary.analysis_results_created++;
          continue;
        }

        // --- 30-DAY RECENCY CHECK ---
        const thirtyDaysAgo = new Date(today);
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        const thirtyDaysAgoStr = thirtyDaysAgo.toISOString().split('T')[0];
        if (!lastDeliveryDate || lastDeliveryDate < thirtyDaysAgoStr) {
          console.log(`  ℹ️ Patient ${patient.full_name} has no delivery in last 30 days (${lastDeliveryDate || 'none'}), skipping pattern detection`);
          continue;
        }

        // --- PATTERN DETECTION (only if no existing pattern) ---
        if (hasExistingPattern(patient)) {
          console.log(`  ✅ Patient ${patient.full_name} already has a pattern set, skipping`);
          continue;
        }

        if (deliveryDates.length < MIN_DELIVERIES_FOR_PATTERN) {
          console.log(`  ℹ️ Patient ${patient.full_name} has only ${deliveryDates.length} deliveries, not enough for pattern`);
          continue;
        }

        const patterns = detectPatterns(deliveryDates);
        
        if (patterns.length === 0) {
          console.log(`  ❓ No pattern detected for ${patient.full_name}`);
          continue;
        }

        const topPattern = patterns[0];
        const isAmbiguous = patterns.length > 1 && (patterns[0].confidence - patterns[1].confidence) < 20;

        if (!isAmbiguous && topPattern.confidence >= 80) {
          // High confidence, single pattern - auto-apply
          console.log(`  ✅ Auto-applying pattern ${topPattern.pattern_key} (${topPattern.confidence}%) to ${patient.full_name}`);
          
          const updateData = { recurring: true };
          if (topPattern.pattern_key === 'recurring_weekly_x4') {
            updateData.recurring_weekly_x4 = true;
            updateData.recurring_weekly_x4_day = topPattern.x4_day;
          } else {
            updateData[topPattern.pattern_key] = true;
          }
          
          await base44.asServiceRole.entities.Patient.update(patient.id, updateData);

          await base44.asServiceRole.entities.PatientAnalysisResult.create({
            patient_id: patient.id,
            patient_name: patient.full_name,
            store_id: store.id,
            store_name: store.name,
            analysis_date: todayStr,
            result_type: 'pattern_detected',
            last_delivery_date: lastDeliveryDate,
            total_deliveries_analyzed: deliveryDates.length,
            suggested_patterns: patterns,
            status: 'applied',
            applied_pattern: topPattern.pattern_key
          });
          summary.patterns_detected++;
          summary.analysis_results_created++;

        } else {
          // Ambiguous or low confidence - queue for manual review
          console.log(`  ❓ Ambiguous patterns for ${patient.full_name}: ${patterns.map(p => p.pattern_key).join(', ')}`);
          
          await base44.asServiceRole.entities.PatientAnalysisResult.create({
            patient_id: patient.id,
            patient_name: patient.full_name,
            store_id: store.id,
            store_name: store.name,
            analysis_date: todayStr,
            result_type: 'pattern_ambiguous',
            last_delivery_date: lastDeliveryDate,
            total_deliveries_analyzed: deliveryDates.length,
            suggested_patterns: patterns,
            status: 'pending_review'
          });
          summary.ambiguous_patterns++;
          summary.analysis_results_created++;
        }
      }
    }

    console.log('✅ [PatientScan] Complete:', summary);
    return Response.json({ success: true, summary });

  } catch (error) {
    console.error('❌ [PatientScan] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});