import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';
import { format } from 'npm:date-fns@3.6.0';

Deno.serve(async (req) => {
  try {
    console.log('[predictDeliveries] Function invoked');
    
    const base44 = createClientFromRequest(req);
    console.log('[predictDeliveries] Client created');
    
    // Check authentication first
    try {
      const isAuthenticated = await base44.auth.isAuthenticated();
      console.log('[predictDeliveries] Auth check result:', isAuthenticated);
      if (!isAuthenticated) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
      }
    } catch (authError) {
      console.error('[predictDeliveries] Auth error:', authError);
      return Response.json({ error: 'Authentication failed', details: authError.message }, { status: 401 });
    }

    const body = await req.json();
    console.log('[predictDeliveries] Request body:', body);
    
    const { delivery_date, store_ids } = body;

    if (!delivery_date) {
      return Response.json({ error: 'delivery_date is required' }, { status: 400 });
    }

    console.log('[predictDeliveries] Starting predictions for:', delivery_date);

    // Fetch historical data for AI-powered prediction (last 12 months for pattern analysis)
    const pastDate = new Date();
    pastDate.setMonth(pastDate.getMonth() - 12);
    const pastDateStr = format(pastDate, 'yyyy-MM-dd');
    
    console.log(`[predictDeliveries] Fetching historical deliveries from ${pastDateStr} for AI analysis...`);

    // Fetch all patients and historical deliveries
    let patients, rawHistoricalForML, historicalForML = [];
    try {
      [patients, rawHistoricalForML] = await Promise.all([
        base44.asServiceRole.entities.Patient.list(),
        base44.asServiceRole.entities.Delivery.filter({
          delivery_date: { $gte: pastDateStr },
          status: 'completed'
        }, '-delivery_date', 5000)
      ]);

      // CRITICAL: Handle case where API returns string (JSON) instead of parsed array
      if (typeof rawHistoricalForML === 'string') {
        try {
          historicalForML = JSON.parse(rawHistoricalForML);
          console.log('[predictDeliveries] Parsed historicalForML from string');
        } catch (parseErr) {
          console.error('[predictDeliveries] Failed to parse historicalForML string:', parseErr);
          historicalForML = [];
        }
      } else {
        historicalForML = Array.isArray(rawHistoricalForML) ? rawHistoricalForML : [];
      }

      console.log('[predictDeliveries] Fetched patients:', patients?.length || 0);
      console.log('[predictDeliveries] Fetched historical deliveries:', historicalForML?.length || 0);
    } catch (patientError) {
      console.error('[predictDeliveries] Error fetching patients:', patientError);
      return Response.json({ error: 'Failed to fetch patients', details: patientError.message }, { status: 500 });
    }
    
    // Filter patients by store_ids if provided, and ALWAYS exclude inactive patients
    const relevantPatients = store_ids && store_ids.length > 0
      ? patients.filter(p => p && store_ids.includes(p.store_id) && p.status === 'active')
      : patients.filter(p => p && p.status === 'active');

    console.log('[predictDeliveries] Relevant active patients:', relevantPatients.length);
    console.log('[predictDeliveries] Excluded inactive patients:', patients.length - relevantPatients.length);

    const targetDate = new Date(delivery_date + 'T00:00:00');
    
    // Calculate date 180 days ago for pattern analysis
    const date180DaysAgo = new Date(targetDate);
    date180DaysAgo.setDate(date180DaysAgo.getDate() - 180);
    const date180DaysAgoStr = date180DaysAgo.toISOString().split('T')[0];

    console.log('[predictDeliveries] Fetching historical deliveries from', date180DaysAgoStr, 'to', delivery_date);

    // Fetch historical deliveries for the past 180 days (for pattern detection)
    // CRITICAL: Filter by store_ids to reduce dataset size and prevent count-only responses
    let historicalDeliveries = [];
    try {
      // If many stores, fetch historical data per-store to avoid hitting limits
      if (store_ids && store_ids.length > 0) {
        console.log('[predictDeliveries] Fetching historical deliveries for', store_ids.length, 'stores');
        
        // Fetch in parallel for all stores
        const storePromises = store_ids.map(async (storeId) => {
          const storeFilter = {
            delivery_date: { $gte: date180DaysAgoStr, $lte: delivery_date },
            store_id: storeId
          };
          
          let rawStoreHistorical = await base44.asServiceRole.entities.Delivery.filter(storeFilter);
          
          // Handle string response
          if (typeof rawStoreHistorical === 'string') {
            try {
              rawStoreHistorical = JSON.parse(rawStoreHistorical);
            } catch (parseErr) {
              rawStoreHistorical = [];
            }
          }
          
          return Array.isArray(rawStoreHistorical) ? rawStoreHistorical : [];
        });
        
        const storeResults = await Promise.all(storePromises);
        historicalDeliveries = storeResults.flat();
        console.log('[predictDeliveries] Total historical deliveries from all stores:', historicalDeliveries.length);
      } else {
        // No store filter - fetch all (rare case)
        const historicalFilter = {
          delivery_date: { $gte: date180DaysAgoStr, $lte: delivery_date }
        };
        
        let rawHistorical = await base44.asServiceRole.entities.Delivery.filter(historicalFilter);
        
        if (typeof rawHistorical === 'string') {
          try {
            rawHistorical = JSON.parse(rawHistorical);
          } catch (parseErr) {
            rawHistorical = [];
          }
        }
        
        historicalDeliveries = Array.isArray(rawHistorical) ? rawHistorical : [];
        console.log('[predictDeliveries] Historical deliveries (no store filter):', historicalDeliveries.length);
      }
    } catch (histError) {
      console.error('[predictDeliveries] Error fetching historical deliveries:', histError);
      return Response.json({ error: 'Failed to fetch historical deliveries', details: histError.message }, { status: 500 });
    }

    // Fetch existing deliveries for target date (ALL drivers, ALL statuses) to check for duplicates
    // CRITICAL: This ensures we don't project deliveries that are already assigned to ANY driver
    let existingDeliveries;
    try {
      let rawExisting = await base44.asServiceRole.entities.Delivery.filter({
        delivery_date: delivery_date
      });
      
      // CRITICAL: Handle case where API returns string (JSON) instead of parsed array
      if (typeof rawExisting === 'string') {
        try {
          rawExisting = JSON.parse(rawExisting);
          console.log('[predictDeliveries] Parsed existing deliveries from string');
        } catch (parseErr) {
          console.error('[predictDeliveries] Failed to parse existing deliveries string:', parseErr);
          rawExisting = [];
        }
      }
      
      existingDeliveries = Array.isArray(rawExisting) ? rawExisting : [];
      console.log('[predictDeliveries] Existing deliveries for target date (all drivers):', existingDeliveries.length);
      
      // Log breakdown by status for debugging
      const statusCounts = {};
      existingDeliveries.forEach(d => {
        if (d && d.status) {
          statusCounts[d.status] = (statusCounts[d.status] || 0) + 1;
        }
      });
      console.log('[predictDeliveries] Existing deliveries by status:', statusCounts);
      
    } catch (existError) {
      console.error('[predictDeliveries] Error fetching existing deliveries:', existError);
      return Response.json({ error: 'Failed to fetch existing deliveries', details: existError.message }, { status: 500 });
    }

    // CRITICAL: Exclude patients who already have deliveries for this date (regardless of driver or status)
    // This prevents duplicate predictions for patients already in any driver's route
    const existingPatientIds = new Set(
      existingDeliveries
        .filter(d => d && d.patient_id && d.status !== 'cancelled') // Only exclude non-cancelled deliveries
        .map(d => d.patient_id)
    );
    console.log('[predictDeliveries] Patient IDs already scheduled (excluding cancelled):', existingPatientIds.size);

    const predictions = [];
    const targetDayOfWeek = targetDate.getDay(); // 0=Sunday, 6=Saturday

    console.log('[predictDeliveries] Processing patients for predictions...');

    for (const patient of relevantPatients) {
      if (!patient) continue;

      // Skip if patient is inactive - CRITICAL: inactive patients should never appear in projections
      if (patient.status === 'inactive') {
        continue;
      }

      // Skip if already has a delivery scheduled for this date
      if (existingPatientIds.has(patient.id)) continue;

      let shouldInclude = false;
      let confidence = 0;
      let reason = '';

      // RULE 1: Check explicit recurring patterns
      if (patient.recurring) {
        // FILTER RULE 3 for explicit patterns: Check if patient has missed more than 3 consecutive deliveries
        let missedConsecutive = 0;
        let expectedInterval = 0;
        let toleranceDays = 0;
        
        if (patient.recurring_daily) {
          expectedInterval = 1;
          toleranceDays = 1;
        } else if (patient.recurring_weekly_x4) {
          expectedInterval = 2;
          toleranceDays = 3;
        } else if (patient.recurring_biweekly) {
          expectedInterval = 14;
          toleranceDays = 3;
        } else if (patient.recurring_monthly) {
          expectedInterval = 30;
          toleranceDays = 5;
        } else if (patient.recurring_bimonthly) {
          expectedInterval = 60;
          toleranceDays = 7;
        } else if (patient.recurring_weekly_mon || patient.recurring_weekly_tue || patient.recurring_weekly_wed || 
                   patient.recurring_weekly_thu || patient.recurring_weekly_fri || patient.recurring_weekly_sat || 
                   patient.recurring_weekly_sun) {
          expectedInterval = 7;
          toleranceDays = 2;
        }
        
        // Calculate missed consecutive deliveries for explicit patterns
        if (expectedInterval > 0 && patient.last_delivery_date) {
          const lastDeliveryDate = new Date(patient.last_delivery_date);
          const daysSinceLastDelivery = Math.round((targetDate - lastDeliveryDate) / (1000 * 60 * 60 * 24));
          missedConsecutive = Math.floor((daysSinceLastDelivery - toleranceDays) / expectedInterval);
        }
        
        // Skip if missed more than 3 consecutive deliveries
        if (missedConsecutive > 3) {
          continue;
        }
        
        if (patient.recurring_daily) {
          shouldInclude = true;
          confidence = 0.95;
          reason = 'Daily recurring pattern';
        } else if (patient.recurring_biweekly && (patient.recurring_weekly_mon || patient.recurring_weekly_tue || patient.recurring_weekly_wed || patient.recurring_weekly_thu || patient.recurring_weekly_fri || patient.recurring_weekly_sat || patient.recurring_weekly_sun)) {
          // Bi-weekly pattern: check if the day matches AND it's been ~14 days since last delivery
          if (patient.last_delivery_date) {
            const lastDeliveryDate = new Date(patient.last_delivery_date);
            const daysSinceLastDelivery = Math.round((targetDate - lastDeliveryDate) / (1000 * 60 * 60 * 24));
            
            const isDayMatch = (
              (patient.recurring_weekly_mon && targetDayOfWeek === 1) ||
              (patient.recurring_weekly_tue && targetDayOfWeek === 2) ||
              (patient.recurring_weekly_wed && targetDayOfWeek === 3) ||
              (patient.recurring_weekly_thu && targetDayOfWeek === 4) ||
              (patient.recurring_weekly_fri && targetDayOfWeek === 5) ||
              (patient.recurring_weekly_sat && targetDayOfWeek === 6) ||
              (patient.recurring_weekly_sun && targetDayOfWeek === 0)
            );
            
            if (isDayMatch && Math.abs(daysSinceLastDelivery - 14) <= 3) {
              shouldInclude = true;
              confidence = 0.95;
              const dayName = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][targetDayOfWeek];
              reason = `Bi-Weekly ${dayName} pattern`;
            }
          }
        } else if (patient.recurring_bimonthly) {
          // Bi-monthly pattern: check if it's been ~60 days since last delivery
          if (patient.last_delivery_date) {
            const lastDeliveryDate = new Date(patient.last_delivery_date);
            const daysSinceLastDelivery = Math.round((targetDate - lastDeliveryDate) / (1000 * 60 * 60 * 24));
            
            if (Math.abs(daysSinceLastDelivery - 60) <= 7) {
              shouldInclude = true;
              confidence = 0.95;
              reason = 'Bi-Monthly recurring pattern';
            }
          }
        } else if (patient.recurring_monthly) {
          // Monthly pattern: check if it's been ~30 days since last delivery
          if (patient.last_delivery_date) {
            const lastDeliveryDate = new Date(patient.last_delivery_date);
            const daysSinceLastDelivery = Math.round((targetDate - lastDeliveryDate) / (1000 * 60 * 60 * 24));
            
            // CRITICAL: Skip if patient has had a delivery within ±3 days of target date
            // Check recent deliveries for this patient around the target date
            const recentDeliveries = historicalDeliveries.filter(d => 
              d && d.patient_id === patient.id && d.status === 'completed'
            );
            const hasRecentDeliveryNearTarget = recentDeliveries.some(d => {
              const deliveryDate = new Date(d.delivery_date);
              const daysDiff = Math.abs(Math.round((targetDate - deliveryDate) / (1000 * 60 * 60 * 24)));
              return daysDiff <= 3 && daysDiff !== 0; // Within ±3 days but not the same day
            });
            
            if (hasRecentDeliveryNearTarget) {
              // Skip this patient - already had a delivery within the recurring window
              continue;
            }
            
            if (Math.abs(daysSinceLastDelivery - 30) <= 5) {
              shouldInclude = true;
              confidence = 0.95;
              reason = 'Monthly recurring pattern';
            }
          }
        } else if (patient.recurring_weekly_x4) {
          // Weekly x4 pattern: check back 4 weeks (and 8 weeks as backup) for matching deliveries
          if (patient.recurring_weekly_x4_day) {
            const dayMap = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
            const targetDay = dayMap[patient.recurring_weekly_x4_day];
            
            // Only project if target date matches the configured day of week
            if (targetDayOfWeek === targetDay) {
              // Get all completed deliveries for this patient
              const patientDeliveries = historicalDeliveries.filter(d =>
                d && d.patient_id === patient.id && d.status === 'completed'
              );
              
              // Check 4 weeks back (±2 days window)
              const fourWeeksAgo = new Date(targetDate);
              fourWeeksAgo.setDate(fourWeeksAgo.getDate() - 28);
              const fourWeeksAgoStart = new Date(fourWeeksAgo);
              fourWeeksAgoStart.setDate(fourWeeksAgoStart.getDate() - 2);
              const fourWeeksAgoEnd = new Date(fourWeeksAgo);
              fourWeeksAgoEnd.setDate(fourWeeksAgoEnd.getDate() + 2);
              
              const deliveryIn4WeekWindow = patientDeliveries.some(d => {
                const deliveryDate = new Date(d.delivery_date);
                return deliveryDate >= fourWeeksAgoStart && deliveryDate <= fourWeeksAgoEnd;
              });
              
              // Check 8 weeks back (±2 days window) as backup
              const eightWeeksAgo = new Date(targetDate);
              eightWeeksAgo.setDate(eightWeeksAgo.getDate() - 56);
              const eightWeeksAgoStart = new Date(eightWeeksAgo);
              eightWeeksAgoStart.setDate(eightWeeksAgoStart.getDate() - 2);
              const eightWeeksAgoEnd = new Date(eightWeeksAgo);
              eightWeeksAgoEnd.setDate(eightWeeksAgoEnd.getDate() + 2);
              
              const deliveryIn8WeekWindow = patientDeliveries.some(d => {
                const deliveryDate = new Date(d.delivery_date);
                return deliveryDate >= eightWeeksAgoStart && deliveryDate <= eightWeeksAgoEnd;
              });
              
              // Include if either 4-week or 8-week pattern matches
              if (deliveryIn4WeekWindow || deliveryIn8WeekWindow) {
                shouldInclude = true;
                confidence = deliveryIn4WeekWindow ? 0.95 : 0.9;
                const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
                const weekPattern = deliveryIn4WeekWindow ? '4-week' : '8-week';
                reason = `Weekly x4 ${dayNames[targetDay]} pattern (${weekPattern} cycle)`;
              }
            }
          }
        } else if (patient.recurring_weekly_mon && targetDayOfWeek === 1) {
          shouldInclude = true;
          confidence = 0.95;
          reason = 'Weekly Monday pattern';
        } else if (patient.recurring_weekly_tue && targetDayOfWeek === 2) {
          shouldInclude = true;
          confidence = 0.95;
          reason = 'Weekly Tuesday pattern';
        } else if (patient.recurring_weekly_wed && targetDayOfWeek === 3) {
          shouldInclude = true;
          confidence = 0.95;
          reason = 'Weekly Wednesday pattern';
        } else if (patient.recurring_weekly_thu && targetDayOfWeek === 4) {
          shouldInclude = true;
          confidence = 0.95;
          reason = 'Weekly Thursday pattern';
        } else if (patient.recurring_weekly_fri && targetDayOfWeek === 5) {
          shouldInclude = true;
          confidence = 0.95;
          reason = 'Weekly Friday pattern';
        } else if (patient.recurring_weekly_sat && targetDayOfWeek === 6) {
          shouldInclude = true;
          confidence = 0.95;
          reason = 'Weekly Saturday pattern';
        } else if (patient.recurring_weekly_sun && targetDayOfWeek === 0) {
          shouldInclude = true;
          confidence = 0.95;
          reason = 'Weekly Sunday pattern';
        }
      }

      // RULE 2: AI-Enhanced Historical Analysis - use 12-month data to detect patterns
      if (!shouldInclude && Array.isArray(historicalForML)) {
        const patientDeliveries = historicalForML.filter(d => d && d.patient_id === patient.id);

        // FILTER RULE 1: Require at least 3 deliveries for historical pattern detection
        if (patientDeliveries.length >= 3) {
          // Sort by date
          patientDeliveries.sort((a, b) => a.delivery_date.localeCompare(b.delivery_date));

          // Calculate intervals between deliveries
          const intervals = [];
          for (let i = 1; i < patientDeliveries.length; i++) {
            const date1 = new Date(patientDeliveries[i - 1].delivery_date);
            const date2 = new Date(patientDeliveries[i].delivery_date);
            const diffDays = Math.round((date2 - date1) / (1000 * 60 * 60 * 24));
            intervals.push(diffDays);
          }

          // Calculate average interval
          const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;

          // FILTER RULE 2: Only accept patterns matching known recurring types
          // Daily: ~1 day, Weekly: ~7 days, Bi-Weekly: ~14 days, Weekly x4: ~2 days, Monthly: ~30 days, Bi-Monthly: ~60 days
          let matchedPattern = null;
          let patternTolerance = 0;
          
          if (avgInterval <= 2) {
            matchedPattern = 'Daily';
            patternTolerance = 1;
          } else if (avgInterval >= 1.5 && avgInterval <= 3) {
            matchedPattern = 'Weekly x4';
            patternTolerance = 3;
          } else if (avgInterval >= 5 && avgInterval <= 9) {
            matchedPattern = 'Weekly';
            patternTolerance = 2;
          } else if (avgInterval >= 12 && avgInterval <= 18) {
            matchedPattern = 'Bi-Weekly';
            patternTolerance = 3;
          } else if (avgInterval >= 25 && avgInterval <= 38) {
            matchedPattern = 'Monthly';
            patternTolerance = 5;
          } else if (avgInterval >= 50 && avgInterval <= 75) {
            matchedPattern = 'Bi-Monthly';
            patternTolerance = 7;
          }

          // Skip if no matching pattern type
          if (!matchedPattern) {
            continue;
          }

          // Calculate days since last delivery
          const lastDeliveryDate = new Date(patientDeliveries[patientDeliveries.length - 1].delivery_date);
          const daysSinceLastDelivery = Math.round((targetDate - lastDeliveryDate) / (1000 * 60 * 60 * 24));

          // FILTER RULE 3: Check for missed consecutive deliveries (more than 3)
          // Calculate how many cycles have been missed
          const expectedCycleLength = avgInterval;
          const missedCycles = Math.floor((daysSinceLastDelivery - patternTolerance) / expectedCycleLength);
          
          if (missedCycles > 3) {
            // Patient has missed more than 3 consecutive deliveries
            continue;
          }

          // Check if pattern matches for prediction
          const tolerance = patternTolerance;
          if (Math.abs(daysSinceLastDelivery - avgInterval) <= tolerance || 
              (daysSinceLastDelivery > avgInterval && missedCycles <= 3 && (daysSinceLastDelivery % Math.round(avgInterval)) <= tolerance)) {
            shouldInclude = true;
            
            // Confidence based on consistency of intervals
            const variance = intervals.reduce((sum, interval) => sum + Math.pow(interval - avgInterval, 2), 0) / intervals.length;
            const stdDev = Math.sqrt(variance);
            confidence = Math.max(0.5, Math.min(0.85, 1 - (stdDev / avgInterval)));
            
            reason = `Historical ${matchedPattern} pattern: ~${Math.round(avgInterval)} day intervals (${patientDeliveries.length} deliveries)`;
          }
        }
      }

      if (shouldInclude) {
        predictions.push({
          patient_id: patient.id,
          patient_name: patient.full_name,
          patient_phone: patient.phone,
          store_id: patient.store_id,
          confidence: confidence,
          reason: reason,
          delivery_instructions: patient.notes || '',
          unit_number: patient.unit_number || '',
          time_window_start: patient.time_window_start || '',
          time_window_end: patient.time_window_end || '',
          mailbox_ok: patient.mailbox_ok || false,
          call_upon_arrival: patient.call_upon_arrival || false,
          ring_bell: patient.ring_bell || false,
          dont_ring_bell: patient.dont_ring_bell || false,
          back_door: patient.back_door || false
        });
      }
    }

    // Sort by confidence (highest first)
    predictions.sort((a, b) => b.confidence - a.confidence);

    console.log('[predictDeliveries] Generated predictions:', predictions.length);

    return Response.json({
      predictions: predictions,
      delivery_date: delivery_date,
      total_predictions: predictions.length
    });

  } catch (error) {
    console.error('[predictDeliveries] ERROR:', error);
    console.error('[predictDeliveries] Stack trace:', error.stack);
    return Response.json({ 
      error: error.message,
      details: error.stack 
    }, { status: 500 });
  }
});