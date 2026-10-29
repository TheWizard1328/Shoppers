import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

// ── Driver daily stop totals (owner request Oct 28 2026) ──────────────────────
// The End-of-Day "Best Day" panel only ever saw the CURRENT day's stops, so
// today always won by default. This function returns the driver's per-date stop
// counts for a calendar year (patient deliveries only — same basis as the
// "Total Stops" card) so the panel can compare against real history.
//
// Cost control: the aggregation result is cached in the DriverDailyTotals
// entity (one record per driver+year). A cached record younger than 6h (current
// year) / 24h (past year) is returned without touching Delivery at all, so the
// dialog costs ONE entity read on open.

const PAGE = 500;

const isRateLimit = (e: any) =>
  e?.status === 429 || e?.response?.status === 429 ||
  String(e?.message || '').toLowerCase().includes('rate limit');

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const driverId = body?.driverId;
    const year = Number(body?.year) || new Date().getFullYear();
    const forceRefresh = body?.forceRefresh === true;
    if (!driverId) return Response.json({ error: 'driverId required' }, { status: 400 });

    const cacheFilter = { driver_id: driverId, year };
    if (!forceRefresh) {
      try {
        const rows = await base44.asServiceRole.entities.DriverDailyTotals.filter(cacheFilter);
        const cached = rows?.[0];
        if (cached?.computed_at && Array.isArray(cached.days)) {
          const ageMs = Date.now() - new Date(cached.computed_at).getTime();
          const maxAgeMs = year === new Date().getFullYear() ? 6 * 3600 * 1000 : 24 * 3600 * 1000;
          if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < maxAgeMs) {
            return Response.json({
              driverId, year,
              days: cached.days,
              bestDate: cached.best_date || null,
              bestStops: cached.best_stops || 0,
              daysWorked: cached.days_worked || 0,
              totalStops: cached.total_stops || 0,
              computedAt: cached.computed_at,
              fromCache: true,
            });
          }
        }
      } catch (_) { /* cache read failed — aggregate below */ }
    }

    // ── aggregate ────────────────────────────────────────────────────────────
    const from = `${year}-01-01`;
    const to = `${year}-12-31`;
    const counts = new Map<string, number>();
    let skip = 0;

    while (true) {
      let rows: any[] = [];
      try {
        rows = await base44.asServiceRole.entities.Delivery.filter(
          { driver_id: driverId, delivery_date: { $gte: from, $lte: to } },
          '-delivery_date',
          PAGE,
          skip,
        );
      } catch (err) {
        if (isRateLimit(err)) {
          return Response.json({ error: 'rate_limited', retryAfter: 30 }, { status: 429 });
        }
        throw err;
      }
      if (!rows || rows.length === 0) break;
      for (const d of rows) {
        if (!d?.delivery_date || !d?.patient_id) continue; // patient stops only, matches Total Stops
        counts.set(d.delivery_date, (counts.get(d.delivery_date) || 0) + 1);
      }
      if (rows.length < PAGE) break;
      skip += PAGE;
      if (skip > 40000) break; // hard stop
    }

    const days = Array.from(counts.entries())
      .map(([date, stops]) => ({ date, stops }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));

    let bestDate: string | null = null;
    let bestStops = 0;
    let totalStops = 0;
    for (const d of days) {
      totalStops += d.stops;
      if (d.stops > bestStops) { bestStops = d.stops; bestDate = d.date; }
    }

    const payload = {
      driver_id: driverId,
      driver_name: body?.driverName || '',
      year,
      days,
      best_date: bestDate,
      best_stops: bestStops,
      days_worked: days.length,
      total_stops: totalStops,
      computed_at: new Date().toISOString(),
    };

    try {
      const existing = await base44.asServiceRole.entities.DriverDailyTotals.filter(cacheFilter);
      if (existing?.[0]?.id) {
        await base44.asServiceRole.entities.DriverDailyTotals.update(existing[0].id, payload);
      } else {
        await base44.asServiceRole.entities.DriverDailyTotals.create(payload);
      }
    } catch (_) { /* cache write is best-effort — always return the fresh data */ }

    return Response.json({
      driverId, year, days,
      bestDate, bestStops,
      daysWorked: days.length,
      totalStops,
      computedAt: payload.computed_at,
      fromCache: false,
    });
  } catch (error) {
    console.error('[getDriverDailyTotals] failed:', error?.message || error);
    return Response.json({ error: 'internal_error', message: String(error?.message || error) }, { status: 500 });
  }
});
