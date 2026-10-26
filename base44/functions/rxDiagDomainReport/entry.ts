import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const unwrap = (r) => {
  if (!r || typeof r !== 'object') return null;
  if (r.data && typeof r.data === 'object') return { ...r.data, id: r.data.id || r.id };
  return r;
};

// Extract a serving host from a log record: prefer explicit metadata.host
// (added Oct 25 2026), fall back to any https://<host>/ URL embedded in the
// message text (error stack traces carry the exact serving origin).
const hostOf = (r) => {
  const h = r?.metadata?.host || (r?.metadata && typeof r.metadata === 'object' ? r.metadata.host : null);
  if (h) return String(h);
  const m = String(r?.message || '').match(/https:\/\/([a-z0-9.-]+)\//i);
  return m ? m[1] : null;
};

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const since = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    const res = await base44.entities.RemoteLogEntry.list('-created_date', 3000);
    const rows = (Array.isArray(res) ? res : (Array.isArray(res?.data) ? res.data : []))
      .map(unwrap).filter(Boolean)
      .filter(r => String(r.created_date || '') >= since);

    const byUser = {};
    for (const r of rows) {
      const who = r.user_name || '?';
      const host = hostOf(r);
      if (!host) continue;
      const t = String(r.created_date || '');
      const cur = byUser[who];
      if (!cur || t > cur.latest) {
        byUser[who] = { host, latest: t, hits: (cur?.hits || 0) + 1 };
      } else {
        cur.hits += 1;
        if (!cur.allHosts) cur.allHosts = {};
        cur.allHosts[host] = (cur.allHosts[host] || 0) + 1;
      }
      const u = byUser[who];
      if (!u.allHosts) u.allHosts = {};
      u.allHosts[host] = (u.allHosts[host] || 0) + 1;
    }
    // compact view
    const report = Object.fromEntries(Object.entries(byUser)
      .map(([who, v]) => [who, { latestHost: v.host, latest: v.latest, hosts: v.allHosts }]));

    return new Response(JSON.stringify({ since, scanned: rows.length, withHost: Object.keys(byUser).length, report }, null, 1), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e?.message || e) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
});
