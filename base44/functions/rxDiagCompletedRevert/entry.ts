import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const unwrapEntityRecord = (r) => {
  if (!r || typeof r !== 'object') return null;
  if (r.data && typeof r.data === 'object') return { ...r.data, id: r.data.id || r.id };
  return r;
};

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const payload = await req.json().catch(() => ({}));
    const hours = Math.min(Number(payload?.hours) || 2, 6);
    const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();

    const logRes = await base44.asServiceRole.entities.RemoteLogEntry.list('-created_date', 3000);
    const rows = (Array.isArray(logRes) ? logRes : (Array.isArray(logRes?.data) ? logRes.data : []))
      .map(unwrapEntityRecord).filter(Boolean);

    const isRate = (m) => m.includes('429') || m.toLowerCase().includes('rate limit') || m.toLowerCase().includes('volume limit');
    const dev = (r) => (r.metadata && (r.metadata.device_name || r.metadata.device_identifier)) || r.device_identifier || (r.user_name || '?');

    const byDevice = {};
    const kingswayHits = [];
    for (const r of rows) {
      const at = String(r.created_date || '');
      if (at < since) continue;
      const m = String(r.message || '');
      if (isRate(m)) {
        const d = dev(r);
        if (!byDevice[d]) byDevice[d] = { n: 0, first: at, last: at, top: {} };
        const e = byDevice[d];
        e.n++;
        if (at < e.first) e.first = at;
        if (at > e.last) e.last = at;
        const prefix = m.split('\n')[0].slice(0, 90);
        e.top[prefix] = (e.top[prefix] || 0) + 1;
      }
    }
    // compact: top 3 endpoints per device
    const out = {};
    for (const [d, e] of Object.entries(byDevice)) {
      out[d] = { n: e.n, first: e.first.slice(11, 19), last: e.last.slice(11, 19), top: Object.entries(e.top).sort((a, b) => b[1] - a[1]).slice(0, 3) };
    }

    // Kingsway mentions (user_name, store, or message) in the window — any level
    for (const r of rows) {
      const at = String(r.created_date || '');
      if (at < since) continue;
      const hay = `${r.user_name || ''} ${r.message || ''}`;
      if (/kingsway|\bkw\b/i.test(hay) && kingswayHits.length < 25) {
        kingswayHits.push({ at: at.slice(11, 19), dev: dev(r), user: r.user_name || null, lvl: r.level || null, m: String(r.message || '').slice(0, 160) });
      }
    }

    const compact = Object.fromEntries(Object.entries(out).map(([d, e]) => [d, e.n]));
    return Response.json({ since: since.slice(11, 19), n429_by_device: compact, kingsway_hits: kingswayHits.slice(-22) });
  } catch (e) {
    return Response.json({ error: e?.message || String(e) });
  }
});
