import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';
import { format, subDays, parseISO } from 'npm:date-fns@3.6.0';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user || user.role !== 'App Owner') {
      return Response.json({ error: 'Forbidden: App Owner access required' }, { status: 403 });
    }

    // Get all deliveries from database to determine date range
    const allDeliveries = await base44.asServiceRole.entities.Delivery.list('-delivery_date', 10000);
    
    if (!allDeliveries || allDeliveries.length === 0) {
      return Response.json({ 
        success: true, 
        message: 'No deliveries found in database',
        datesMissing: [],
        datesAdded: 0
      });
    }

    // Get all dates that have deliveries in the database
    const datesInDB = new Set(
      allDeliveries
        .map(d => d.delivery_date)
        .filter(Boolean)
    );

    // Get min and max date from deliveries
    const dates = Array.from(datesInDB).sort();
    const minDate = parseISO(dates[0]);
    const maxDate = parseISO(dates[dates.length - 1]);

    console.log(`📅 [Sync] DB date range: ${dates[0]} to ${dates[dates.length - 1]}`);
    console.log(`📊 [Sync] DB has ${datesInDB.size} unique dates with deliveries`);

    // Generate all dates between min and max
    const allPossibleDates = [];
    let currentDate = minDate;
    while (currentDate <= maxDate) {
      allPossibleDates.push(format(currentDate, 'yyyy-MM-dd'));
      currentDate = new Date(currentDate);
      currentDate.setDate(currentDate.getDate() + 1);
    }

    console.log(`📅 [Sync] Date range spans ${allPossibleDates.length} total days`);

    // Connect to IndexedDB via custom code (can't import from frontend utils)
    // We'll return the missing dates and let the frontend handle the sync
    const datesMissing = allPossibleDates.filter(date => !datesInDB.has(date));
    
    console.log(`📊 [Sync] Found ${datesMissing.length} dates with no deliveries (gaps in data)`);

    return Response.json({
      success: true,
      totalDatesInRange: allPossibleDates.length,
      datesWithData: datesInDB.size,
      datesMissing: datesMissing,
      minDate: dates[0],
      maxDate: dates[dates.length - 1],
      message: `Found ${datesMissing.length} dates with gaps in historical data`
    });

  } catch (error) {
    console.error('❌ [Sync] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});