import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const unwrap = (r) => {
  if (!r || typeof r !== 'object') return null;
  if (r.data && typeof r.data === 'object') return { ...r.data, id: r.data.id || r.id };
  return r;
};

const NOISE = [
  '[RouteDeviation] ok',
  '[Breadcrumb Gap]',
  '[BuilderBridge]',
  '[DEVICE_HEALTH]',
  'connect_error',
];

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const since = new Date(Date.now() - 2 * 3600 * 1000).toISOString();

    const res = await base44.entities.RemoteLogEntry.list('-created_date', 5000);
    const rows = (Array.isArray(res) ? res : (Array.isArray(res?.data) ? res.data : []))
      .map(unwrap)
      .filter(Boolean)
      .filter((r) => String(r.created_date || '') >= since);

    // Who (user+device) is producing errors / rate limits?
    const byWho = {};
    const prefixByWho = {};
    const oldestSeen = rows.length ? rows[rows.length - 1].created_date : null;
    let n429 = 0, nErr = 0;

    for (const r of rows) {
      const m = String(r.message || '');
      if (NOISE.some((p) => m.startsWith(p))) continue;
      const isRate = m.includes('429') || m.toLowerCase().includes('rate limit');
      const isErr = r.level === 'error' || (r.level !== 'error' && m.startsWith('Error')) || m.includes('[Base44 SDK Error]');
      if (!isRate && !isErr) continue;
      if (isRate) n429 += 1;
      if (isErr) nErr += 1;
      const who = `${r.user_name || r.user_id || '?'} @ ${(r.metadata && r.metadata.device_name) || String(r.device_identifier || '?').slice(0, 8)}`;
      byWho[who] = byWho[who] || { rate: 0, err: 0 };
      if (isRate) byWho[who].rate += 1; else byWho[who].err += 1;
      const pfx = m.split('\n')[0].slice(0, 90);
      prefixByWho[who] = prefixByWho[who] || {};
      prefixByWho[who][pfx] = (prefixByWho[who][pfx] || 0) + 1;
    }

    const whoSorted = Object.entries(byWho)
      .sort((a, b) => (b[1].rate + b[1].err) - (a[1].rate + a[1].err))
      .slice(0, 12)
      .map(([who, c]) => {
        const top = Object.entries(prefixByWho[who]).sort((a, b) => b[1] - a[1]).slice(0, 3)
          .map(([p, n]) => ({ n, p }));
        return { who, rate: c.rate, err: c.err, top };
      });

    // Global top rate-limit/error prefixes for context
    const globalPfx = {};
    for (const who of Object.keys(prefixByWho)) {
      for (const [p, n] of Object.entries(prefixByWho[who])) globalPfx[p] = (globalPfx[p] || 0) + n;
    }
    const globalTop = Object.entries(globalPfx).sort((a, b) => b[1] - a[1]).slice(0, 12)
      .map(([p, n]) => ({ n, p }));

    return Response.json({
      since,
      scanned: rows.length,
      oldest_log_covered: oldestSeen,
      rate_hits: n429,
      err_hits: nErr,
      by_who: whoSorted,
      global_top_prefixes: globalTop,
    });
  } catch (e) {
    return Response.json({ error: e?.message || String(e) });
  }
});
