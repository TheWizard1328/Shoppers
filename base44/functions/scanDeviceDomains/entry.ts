// Scan all devices and which domain each one is served from (owner request
// Oct 27 2026, wizardworxx.com migration audit). Reads the RemoteLogEntry
// stream (metadata.host, captured since Oct 25 2026) and aggregates the
// latest host per device, cross-referenced with the full UserDevice roster.
// READ-ONLY — no writes.

import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;

  const devices = await svc.entities.UserDevice.list('device_name', 500, 0).catch(() => []);
  const roster = new Map();
  for (const d of devices || []) {
    roster.set(String(d.device_identifier || d.id), {
      user: d.user_name || null,
      device_name: d.device_name || null,
      device_type: d.device_info?.device_type || null,
      status: d.status || null,
      last_active_at: d.last_active_at || null,
      hosts: {},
      latest_host: null,
      latest_log_at: null
    });
  }

  const CUTOFF = new Date('2026-10-24T00:00:00Z').getTime();
  let scanned = 0;
  let pages = 0;
  const MAX_PAGES = 40;
  let oldest = null;
  for (; pages < MAX_PAGES; pages++) {
    const rows = await svc.entities.RemoteLogEntry.list('-created_date', 500, pages * 500).catch(() => []);
    if (!rows || !rows.length) break;
    scanned += rows.length;
    for (const r of rows) {
      const ts = r?.timestamp ? new Date(r.timestamp).getTime() : (r?.created_date ? new Date(r.created_date).getTime() : 0);
      if (ts < CUTOFF) { oldest = ts; continue; }
      const key = String(r?.device_identifier || '');
      if (!key) continue;
      const host = r?.metadata?.host || null;
      if (!host) continue;
      let entry = roster.get(key);
      if (!entry) {
        entry = { user: r.user_name || null, device_name: r?.metadata?.device_name || null, device_type: null, status: null, last_active_at: null, hosts: {}, latest_host: null, latest_log_at: null };
        roster.set(key, entry);
      }
      entry.hosts[host] = (entry.hosts[host] || 0) + 1;
      if (!entry.latest_log_at || ts > entry.latest_log_at) { entry.latest_log_at = ts; entry.latest_host = host; }
      if (r?.user_name) entry.user = r.user_name;
      if (r?.metadata?.device_name) entry.device_name = r.metadata.device_name;
    }
    if ((rows.length < 500) || (oldest !== null && oldest < CUTOFF)) break;
  }

  const out = [];
  for (const [key, e] of roster) {
    out.push({
      device_identifier: key,
      user: e.user,
      device_name: e.device_name,
      device_type: e.device_type,
      status: e.status,
      last_active_at: e.last_active_at,
      latest_host: e.latest_host,
      latest_log_at: e.latest_log_at,
      hosts: e.hosts
    });
  }
  const OLD = ['wizardworxx.com', 'www.wizardworxx.com'];
  const rank = (x) => {
    if (!x.latest_host) return 3;
    if (OLD.includes(x.latest_host)) return 0;
    if (x.latest_host.includes('preview')) return 1;
    if (x.latest_host === 'rxdeliver.wizardworxx.com') return 2;
    return 4;
  };
  out.sort((a, b) => rank(a) - rank(b) || String(b.latest_log_at || '').localeCompare(String(a.latest_log_at || '')));

  const summary = { old_domain: 0, preview: 0, new_domain: 0, no_host_data: 0, other: 0 };
  for (const x of out) { const r = rank(x); if (r === 0) summary.old_domain++; else if (r === 1) summary.preview++; else if (r === 2) summary.new_domain++; else if (r === 3) summary.no_host_data++; else summary.other++; }

  return new Response(JSON.stringify({ scanned_entries: scanned, pages: pages + 1, summary, devices: out }), { headers: { 'Content-Type': 'application/json' } });
});
