// End-of-week HERE map-tile usage check (read-only, no auth required).
// Pages GoogleAPILog (api_type = "Map Tiles (HERE)") newest-first, sums
// metadata.call_count per America/Edmonton day. Default window: Sat Oct 24 .. Fri Oct 30, 2026
// (Oct 30 is partial through the run time). Optional JSON body {startISO,endISO} overrides the
// window (must be UTC instants of local midnight). Returns per-day tiles, per-user, totals,
// Sat-Thu full-day average vs the ~2,900/day August baseline and 950-1050 post-cache norm.
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const svc = base44.asServiceRole;

    // Weekly default window: Sat Oct 24 00:00 MDT -> Sat Oct 31 00:00 MDT (end of Fri Oct 30).
    // MDT = UTC-6 until Nov 1 2026 (DST ends); MST weeks (Nov onward) use UTC-7.
    let body: any = {};
    try { body = await req.json(); } catch (_e) { /* GET / empty body */ }
    const START = new Date(body.startISO || '2026-10-24T06:00:00.000Z');
    const END   = new Date(body.endISO   || '2026-10-31T06:00:00.000Z');
    const EDM_OFF_H = 6; // hours to subtract from UTC for America/Edmonton (MDT)
    const now   = new Date();

    const byDay: Record<string, number> = {};
    const byUser: Record<string, number> = {};
    const bigBatches: Array<{ ts: string; user: string; cc: number }> = [];
    const byHour: Record<string, number> = {};

    let total = 0, recCount = 0, skip = 0;
    const PAGE = 500;
    const MAX_PAGES = 80; // 40k record cap
    let pages = 0;
    let stop = false;

    while (!stop && pages < MAX_PAGES) {
      const records = await svc.entities.GoogleAPILog.list('-timestamp', PAGE, skip);
      if (!records || records.length === 0) break;
      pages++;
      let pageHasOlder = false;
      for (const r of records as any[]) {
        const api = r.api_type || (r.metadata && r.metadata.api_type);
        if (api !== 'Map Tiles (HERE)') continue;
        const ts = new Date(r.timestamp);
        if (ts < START) { pageHasOlder = true; continue; }
        if (ts >= END) continue; // beyond window
        const cc = (r.metadata && typeof r.metadata.call_count === 'number') ? r.metadata.call_count : 0;
        total += cc; recCount++;
        const edm = new Date(ts.getTime() - EDM_OFF_H * 3600 * 1000);
        const day = edm.toISOString().slice(0, 10);
        byDay[day] = (byDay[day] || 0) + cc;
        const hh = edm.toISOString().slice(0, 13);
        byHour[hh] = (byHour[hh] || 0) + cc;
        const u = r.user_name || '(service)';
        byUser[u] = (byUser[u] || 0) + cc;
        if (cc >= 15 && bigBatches.length < 40) {
          bigBatches.push({ ts: r.timestamp, user: u, cc });
        }
      }
      skip += records.length;
      if (records.length < PAGE) break;
      if (pageHasOlder) stop = true;
    }

    const days = Object.keys(byDay).sort().map((d) => ({ date: d, tiles: byDay[d] }));
    // Sat Oct 24 .. Thu Oct 29 = full days; Fri Oct 30 is partial.
    const fullDays = days.filter((d) => d.date >= '2026-10-24' && d.date <= '2026-10-29');
    const sumFull = fullDays.reduce((a, d) => a + d.tiles, 0);
    const fullAvg = fullDays.length ? Math.round(sumFull / fullDays.length) : 0;
    const weekTotal = days.reduce((a, d) => a + d.tiles, 0);
    const fri = byDay['2026-10-30'] || 0;
    const topHours = Object.entries(byHour).sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([h, t]) => ({ hour: h.replace('T', ' ') + ' UTC', tiles: t }));

    return Response.json({
      generated_at: now.toISOString(),
      note: 'Days bucketed by America/Edmonton (UTC-6 MDT). Fri Oct 30 is PARTIAL (through run time ~9 PM MDT).',
      byDay: days,
      byUser: Object.entries(byUser).sort((a, b) => b[1] - a[1]).map(([u, t]) => ({ user: u, tiles: t })),
      weekTotal,
      fullDayRange: '2026-10-24..2026-10-29',
      fullDaysCount: fullDays.length,
      fullDaysTotal: sumFull,
      fullDaysAvg: fullAvg,
      satThu_avg_vs_augBaseline_pct: fullAvg ? Math.round(fullAvg / 2900 * 100) : 0,
      satThu_avg_vs_postCacheNorm_pct: fullAvg ? Math.round(fullAvg / 1000 * 100) : 0,
      friOct30_partial: fri,
      baseline_aug_precache: 2900,
      postcache_norm: '950-1050',
      topHours,
      bigBatches,
      pages_scanned: pages
    });
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
});
