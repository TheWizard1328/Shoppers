/**
 * deviceActivityReport — attributes client activity to a physical device.
 *
 * The tile counter (GoogleAPILog) only knew the login until Nov 12 2026, so a
 * spike could not be pinned to a machine. RemoteLogEntry already carries a
 * stable device id for every console line, so this function counts the map /
 * turn-auto-zoom lines each device emitted — which is exactly the activity that
 * drives tile fetches — and returns them per device and per day. Read only.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const TZ_OFFSET_HOURS = -6; // MDT

const localDay = (iso: string) => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'unknown';
  return new Date(t + TZ_OFFSET_HOURS * 3600 * 1000).toISOString().slice(0, 10);
};

const PATTERNS: { name: string; regex: string }[] = [
  { name: 'turn_autozoom', regex: 'TurnAutoZoom' },
  { name: 'map_boot', regex: 'MapBoot|Map readiness|whenReady' },
  { name: 'map_fit', regex: 'MapUnhide|fitBounds|MapFit' },
];

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const days = Math.min(30, Math.max(1, Number(body?.days) || 10));
    const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();

    const out: any = { ok: true, window_days: days, since, patterns: PATTERNS.map((p) => p.name), groups: {} };

    for (const p of PATTERNS) {
      const rows: any[] = [];
      let skip = 0;
      const PAGE = 500;
      for (let i = 0; i < 60; i++) {
        let page: any[] = [];
        try {
          page = await base44.asServiceRole.entities.RemoteLogEntry.filter(
            { message: { $regex: p.regex }, timestamp: { $gte: since } },
            '-timestamp',
            PAGE,
            skip
          );
        } catch (err) {
          out.groups[p.name] = { error: String((err as Error)?.message || err) };
          page = [];
          break;
        }
        if (!page || page.length === 0) break;
        rows.push(...page);
        if (page.length < PAGE) break;
        skip += PAGE;
        await new Promise((r) => setTimeout(r, 120));
      }
      if (!Array.isArray(rows)) continue;

      const devices = new Map<string, any>();
      const perDay = new Map<string, number>();
      for (const r of rows) {
        const id = r?.device_identifier || '(no device)';
        const day = localDay(r?.timestamp || r?.created_date);
        perDay.set(day, (perDay.get(day) || 0) + 1);
        if (!devices.has(id)) {
          devices.set(id, { device_identifier: id, users: new Set<string>(), device_type: r?.device_type || '', count: 0, byDay: new Map<string, number>(), sample: r?.message?.slice(0, 90) || '' });
        }
        const d = devices.get(id)!;
        d.count += 1;
        if (r?.user_name) d.users.add(r.user_name);
        d.byDay.set(day, (d.byDay.get(day) || 0) + 1);
      }
      out.groups[p.name] = {
        rows: rows.length,
        per_day: [...perDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, n]) => ({ day, events: n })),
        devices: [...devices.values()]
          .map((d) => ({
            device_identifier: d.device_identifier,
            device_type: d.device_type,
            users: [...d.users],
            events: d.count,
            by_day: [...d.byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, n]) => ({ day, events: n })),
            sample: d.sample,
          }))
          .sort((a, b) => b.events - a.events),
      };
    }

    return Response.json(out);
  } catch (error) {
    return Response.json({ ok: false, error: String((error as Error)?.message || error) }, { status: 500 });
  }
});
