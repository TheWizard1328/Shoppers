import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const unwrap = (r) => {
  if (!r || typeof r !== 'object') return null;
  if (r.data && typeof r.data === 'object') return { ...r.data, id: r.data.id || r.id };
  return r;
};

// Only serving origins of THIS app count; URLs embedded in message bodies
// (file CDN 'base44.app', doc links like reactjs.org) are false positives.
const ORIGIN_RX = /^(rxdeliver\.wizardworxx\.com|wizardworxx\.com|www\.wizardworxx\.com|(preview(-sandbox)?--)?rx-deliver-2408a9d6\.base44\.app)$/i;
const hostOf = (r) => {
  const h = r?.metadata?.host || (r?.metadata && typeof r.metadata === 'object' ? r.metadata.host : null);
  if (h) return ORIGIN_RX.test(String(h)) ? String(h) : null;
  const m = String(r?.message || '').match(/https:\/\/([a-z0-9.-]+)\//i);
  return (m && ORIGIN_RX.test(m[1])) ? m[1] : null;
};
const deviceOf = (r) => {
  const d = r?.metadata?.device_name || (r?.metadata && typeof r.metadata === 'object' ? r.metadata.device_name : null);
  return d ? String(d) : null;
};

// PATH CLASSIFICATION for the wizardworxx migration:
//  NEW = rxdeliver.wizardworxx.com (also wizardworxx.com root will join later)
//  OLD = rx-deliver-2408a9d6.base44.app (original base44 domain)
//  PREVIEW = preview(--sandbox) hosts (owner-only by design)
const classify = (host) => {
  const h = String(host || '').toLowerCase();
  if (h.includes('preview')) return 'PREVIEW';
  if (h === 'rxdeliver.wizardworxx.com' || h === 'www.wizardworxx.com' || h === 'wizardworxx.com') return 'NEW';
  return 'OLD';
};

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    let bodyArgs = {};
    try { bodyArgs = (await req.json()) || {}; } catch (_) { /* GET or empty body */ }
    const url = new URL(req.url);
    const hours = Math.min(Number(bodyArgs.hours || url.searchParams.get('hours') || 48), 168);
    const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
    const res = await base44.entities.RemoteLogEntry.list('-created_date', 3000);
    const rows = (Array.isArray(res) ? res : (Array.isArray(res?.data) ? res.data : []))
      .map(unwrap).filter(Boolean)
      .filter(r => String(r.created_date || '') >= since);

    // Per user+device latest host (metadata.host needs the Oct 25 2026 build+)
    const byDevice = {};
    for (const r of rows) {
      const host = hostOf(r);
      if (!host) continue;
      const who = r.user_name || '?';
      const dev = deviceOf(r) || '(unknown device)';
      const key = `${who} | ${dev}`;
      const t = String(r.created_date || '');
      const cur = byDevice[key] || { user: who, device: dev, latestHost: host, latest: t, hosts: {} };
      if (t > cur.latest) { cur.latestHost = host; cur.latest = t; }
      cur.hosts[host] = (cur.hosts[host] || 0) + 1;
      byDevice[key] = cur;
    }

    const devices = Object.values(byDevice)
      .map(({ user, device, latestHost, latest, hosts }) => `${user} | ${device} | ${classify(latestHost)} | ${latestHost} | ${latest}`)
      .sort();

    return new Response(JSON.stringify({ since, scanned: rows.length, devices }, null, 1), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e?.message || e) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
});
