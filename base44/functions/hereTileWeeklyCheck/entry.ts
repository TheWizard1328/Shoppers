// End-of-week HERE map-tile usage check (read-only, no auth required).
// Pages GoogleAPILog (api_type = "Map Tiles (HERE)") newest-first, sums
// metadata.call_count per America/Edmonton (UTC-6) day for Mon Sep 7 .. Fri Sep 11, 2026.
// Sep 11 is partial (through the run time). Returns per-day tiles, per-user, totals,
// Tue-Thu / Tue-Fri averages vs the ~2,900/day August baseline.
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.43';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const svc = base44.asServiceRole;

    const START = new Date('2026-09-07T06:00:00.000Z'); // Sep 7 00:00 MDT
    const END   = new Date('2026-09-12T06:00:00.000Z');  // Sep 12 00:00 MDT (end of Sep 11)
    const now   = new Date();

    const byDay: Record<string, number> = {};
    const byUser: Record<string, number> = {};
    const bigBatches: Array<{ ts: string; user: string; cc: number }> = [];

    let total = 0, recCount = 0, skip = 0;
    const PAGE = 500;
    const MAX_PAGES = 40; // 20k record cap
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
        const edm = new Date(ts.getTime() - 6 * 3600 * 1000);
        const day = edm.toISOString().slice(0, 10);
        byDay[day] = (byDay[day] || 0) + cc;
        const u = r.user_name || '(service)';
        byUser[u] = (byUser[u] || 0) + cc;
        if (cc >= 15 && bigBatches.length < 25) {
          bigBatches.push({ ts: r.timestamp, user: u, cc });
        }
      }
      skip += records.length;
      if (records.length < PAGE) break;
      if (pageHasOlder) stop = true;
    }

    const days = Object.keys(byDay).sort().map((d) => ({ date: d, tiles: byDay[d] }));
    const tueThu = days.filter((d) => d.date >= '2026-09-08' && d.date <= '2026-09-10');
    const tueFri = days.filter((d) => d.date >= '2026-09-08' && d.date <= '2026-09-11');
    const sumTueThu = tueThu.reduce((a, d) => a + d.tiles, 0);
    const sumTueFri = tueFri.reduce((a, d) => a + d.tiles, 0);

    return Response.json({
      generated_at: now.toISOString(),
      note: 'Days bucketed by America/Edmonton (UTC-6). Sep 11 is PARTIAL (through run time ~9 PM MDT).',
      byDay: days,
      byUser: Object.entries(byUser).sort((a, b) => b[1] - a[1]).map(([u, t]) => ({ user: u, tiles: t })),
      weekTotal: total,
      recordCount: recCount,
      monSep7: byDay['2026-09-07'] || 0,
      tueThu_total: sumTueThu,
      tueThu_avg: tueThu.length ? Math.round(sumTueThu / tueThu.length) : 0,
      tueFri_total: sumTueFri,
      tueFri_avg: tueFri.length ? Math.round(sumTueFri / tueFri.length) : 0,
      baseline: 2900,
      augMonthly: 82489,
      bigBatches,
      pages_scanned: pages
    });
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
});
