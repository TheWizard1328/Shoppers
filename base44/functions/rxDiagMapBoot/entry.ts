import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// One-off diagnostic (owner report Oct 22 evening: map loads ~10s after the rest
// of the dashboard). Reconstructs the boot timeline from RemoteLogEntry: app_start
// beacons, HERE key store messages, map position logs. Read-only, owner/diag use.
const PATTERNS = [
  'app_start', 'HereApiKeyStore', 'mapPos', 'tile', 'Tile', 'DeliveryMap',
  'offline', 'boot', 'Boot', 'priority', 'Priority'
];

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const url = new URL(req.url);
    const hours = Math.min(6, Math.max(0.25, Number(url.searchParams.get('hours') || 2)));
    const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();

    const res = await base44.entities.RemoteLogEntry.list('-created_date', 5000);
    const rows = (Array.isArray(res) ? res : (Array.isArray(res?.data) ? res.data : []))
      .map((r) => (r && r.data && typeof r.data === 'object') ? { ...r.data, id: r.data.id || r.id } : r)
      .filter(Boolean)
      .filter((r) => String(r.created_date || '') >= since);

    const timeline = rows
      .filter((r) => {
        const m = String(r.message || '');
        return PATTERNS.some((p) => m.includes(p));
      })
      .slice(0, 120)
      .map((r) => ({
        t: r.created_date,
        dev: (r.metadata && r.metadata.device_name) || String(r.device_identifier || '?').slice(0, 12),
        m: String(r.message || '').split('\n')[0].slice(0, 180)
      }));

    return Response.json({ window_hours: hours, matches: timeline.length, timeline });
  } catch (e) {
    return Response.json({ error: e?.message || String(e) }, { status: 500 });
  }
});
