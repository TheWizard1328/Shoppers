import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const unwrapEntityRecord = (r) => {
  if (!r || typeof r !== 'object') return null;
  if (r.data && typeof r.data === 'object') return { ...r.data, id: r.data.id || r.id };
  return r;
};

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const since = new Date(Date.now() - 6 * 3600 * 1000).toISOString();

    const res = await base44.entities.RemoteLogEntry.list('-created_date', 3000);
    const rows = (Array.isArray(res) ? res : (Array.isArray(res?.data) ? res.data : []))
      .map(unwrapEntityRecord)
      .filter(Boolean)
      .filter(r => String(r.created_date || '') >= since);

    const byMinute = {};
    const byDevice = {};
    const byMessagePrefix = {};
    let total = rows.length;
    let n429 = 0;

    for (const r of rows) {
      const m = String(r.message || '');
      const isRate = m.includes('429') || m.toLowerCase().includes('rate limit');
      if (!isRate) continue;
      n429++;
      const dev = (r.metadata && r.metadata.device_name) || (r.device_identifier || '?').slice(0, 8);
      const minute = String(r.timestamp || r.created_date || '').slice(0, 16);
      byMinute[minute] = (byMinute[minute] || 0) + 1;
      byDevice[dev] = (byDevice[dev] || 0) + 1;
      const prefix = m.split('\n')[0].slice(0, 70);
      byMessagePrefix[prefix] = (byMessagePrefix[prefix] || 0) + 1;
    }

    return Response.json({
      since,
      total_logs: total,
      rate_limit_hits: n429,
      by_device: byDevice,
      by_minute_top: Object.fromEntries(Object.entries(byMinute).sort((a, b) => b[1] - a[1]).slice(0, 30)),
      by_message_prefix: Object.fromEntries(Object.entries(byMessagePrefix).sort((a, b) => b[1] - a[1]).slice(0, 15)),
    });
  } catch (e) {
    return Response.json({ error: e?.message || String(e) });
  }
});
