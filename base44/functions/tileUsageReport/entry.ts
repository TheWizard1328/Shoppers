/**
 * tileUsageReport — read-only rollup of HERE map tile fetches.
 *
 * Every network tile fetch is logged by HereTileUsageTracker as a GoogleAPILog
 * row (api_type "Map Tiles (HERE)", metadata.call_count). This function walks
 * the last N days of those rows and returns:
 *   • perDay  — tiles fetched per local (America/Edmonton) day
 *   • perUser — tiles per user per day, with totals
 *   • perHour — the busiest hours, to spot a device stuck on a loop
 * It never writes anything.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const TZ_OFFSET_HOURS = -6; // MDT in November

const localDayKey = (iso) => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'unknown';
  const d = new Date(t + TZ_OFFSET_HOURS * 3600 * 1000);
  return d.toISOString().slice(0, 10);
};
const localHourKey = (iso) => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'unknown';
  const d = new Date(t + TZ_OFFSET_HOURS * 3600 * 1000);
  return `${d.toISOString().slice(0, 10)} ${String(d.getUTCHours()).padStart(2, '0')}`;
};

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const days = Math.min(30, Math.max(1, Number(body?.days) || 10));
    const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();

    const rows: any[] = [];
    let skip = 0;
    const PAGE = 500;
    for (let i = 0; i < 200; i++) {
      const page = await base44.asServiceRole.entities.GoogleAPILog.filter(
        { api_type: 'Map Tiles (HERE)' },
        '-created_date',
        PAGE,
        skip
      );
      if (!page || page.length === 0) break;
      let reachedOlder = false;
      for (const r of page) {
        const iso = r?.timestamp || r?.created_date;
        if (!iso) continue;
        if (Date.parse(iso) < Date.parse(since)) { reachedOlder = true; continue; }
        rows.push(r);
      }
      if (page.length < PAGE || reachedOlder) break;
      skip += PAGE;
      await new Promise((res) => setTimeout(res, 120));
    }

    const perDay = new Map<string, number>();
    const perUser = new Map<string, { user_name: string; user_id: string; total: number; byDay: Map<string, number> }>();
    const perDevice = new Map<string, { device_identifier: string; device_label: string; total: number; users: Set<string>; byDay: Map<string, number> }>();
    const zoomHistogram = new Map<string, number>();
    const perHour = new Map<string, number>();
    const recent = new Map<string, number>(); // day -> rows

    for (const r of rows) {
      const iso = r?.timestamp || r?.created_date;
      const count = Number(r?.metadata?.call_count) || 1;
      const day = localDayKey(iso);
      const hour = localHourKey(iso);
      perDay.set(day, (perDay.get(day) || 0) + count);
      perHour.set(hour, (perHour.get(hour) || 0) + count);
      recent.set(day, (recent.get(day) || 0) + 1);
      const devId = r?.metadata?.device_identifier || '(untagged)';
      if (!perDevice.has(devId)) {
        perDevice.set(devId, { device_identifier: devId, device_label: r?.metadata?.device_label || '', total: 0, users: new Set(), byDay: new Map() });
      }
      const dv = perDevice.get(devId);
      dv.total += count;
      if (r?.user_name) dv.users.add(r.user_name);
      dv.byDay.set(day, (dv.byDay.get(day) || 0) + count);
      const z = r?.metadata?.map_zoom;
      if (z != null) zoomHistogram.set(String(z), (zoomHistogram.get(String(z)) || 0) + count);

      const key = String(r?.user_id || r?.user_name || 'unknown');
      if (!perUser.has(key)) {
        perUser.set(key, { user_name: r?.user_name || '(no name)', user_id: r?.user_id || '', total: 0, byDay: new Map() });
      }
      const u = perUser.get(key)!;
      u.total += count;
      if (r?.user_name && u.user_name === '(no name)') u.user_name = r.user_name;
      u.byDay.set(day, (u.byDay.get(day) || 0) + count);
    }

    const dayList = [...perDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const users = [...perUser.entries()]
      .map(([id, u]) => ({
        user_id: id,
        user_name: u.user_name,
        total_tiles: u.total,
        by_day: [...u.byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([d, n]) => ({ day: d, tiles: n })),
        log_rows: recent.get([...u.byDay.keys()][0] || '') || 0,
      }))
      .sort((a, b) => b.total_tiles - a.total_tiles);

    const busiestHours = [...perHour.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([hour, tiles]) => ({ hour, tiles }));

    return Response.json({
      ok: true,
      window_days: days,
      since,
      log_rows_scanned: rows.length,
      total_tiles: [...perDay.values()].reduce((a, b) => a + b, 0),
      per_day: dayList.map(([day, tiles]) => ({ day, tiles })),
      users,
      busiest_hours_local: busiestHours,
      devices: [...perDevice.values()]
        .map((d) => ({
          device_identifier: d.device_identifier,
          device_label: d.device_label,
          users: [...d.users],
          total_tiles: d.total,
          by_day: [...d.byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, tiles]) => ({ day, tiles })),
        }))
        .sort((a, b) => b.total_tiles - a.total_tiles),
      zoom_histogram: [...zoomHistogram.entries()].sort((a, b) => b[1] - a[1]).map(([zoom, tiles]) => ({ zoom, tiles })),
    });
  } catch (error) {
    return Response.json({ ok: false, error: String((error as Error)?.message || error) }, { status: 500 });
  }
});
