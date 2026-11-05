// appIssueHourlyDigest — READ ONLY.
// Owner request (Nov 5 2026): every hour from 08:00 to 20:00 the owner wants a
// diagnosis of the last hour of app errors in WhatsApp. This function does the
// data gathering only: it reads RemoteLogEntry rows for the window, groups them
// into signatures, and returns JSON. It never writes, never updates, never
// sends anything — the scheduled workflow's agent step writes the diagnosis.
//
// POST {} -> { ok, window:{from,to,minutes}, totals:{...}, signatures:[...] }
// Optional body: { window_minutes: 60, max_signatures: 8 }

import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const unwrapEntityRecord = (r: any) => (r && typeof r === 'object' && r.data && !r.id ? r.data : r);

const RATE_LIMIT_RX = /rate limit|429|too many requests/i;
const FALLBACK_WARN_RX = /fallback|using cached|crow-flies|served from cache/i;

async function listAll(base44: any, entityName: string, sortField: string, limit = 4000) {
  const out: any[] = [];
  try {
    const res = await base44.asServiceRole.entities[entityName].list(sortField, limit);
    const rows = Array.isArray(res) ? res : (Array.isArray(res?.data) ? res.data : []);
    rows.forEach((r: any) => { const u = unwrapEntityRecord(r); if (u) out.push(u); });
  } catch (_) { /* read failure -> empty, never throw */ }
  return out;
}

const edmParts = (iso: any) => {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Edmonton', hour: '2-digit', minute: '2-digit', hour12: false,
      month: '2-digit', day: '2-digit',
    });
    const parts = fmt.formatToParts(new Date(iso));
    const get = (t: string) => parts.find((p) => p.type === t)?.value || '';
    return { hm: `${get('hour')}:${get('minute')}`, md: `${get('month')}/${get('day')}` };
  } catch (_) { return { hm: '', md: '' }; }
};

// Collapse volatile bits so the same failure groups together.
const signatureOf = (msg: string) => {
  let s = String(msg || '').replace(/\s+/g, ' ').trim();
  s = s.replace(/[0-9a-f]{24,}/gi, '<id>');
  s = s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>');
  s = s.replace(/DID-\d+-[a-z0-9]+/gi, '<did>');
  s = s.replace(/\b\d{4,}\b/g, '<n>');
  s = s.replace(/\b\d+\.\d+\b/g, '<f>');
  return s.slice(0, 180);
};

Deno.serve(async (req) => {
  let body: any = {};
  try { body = await req.json(); } catch (_) { /* empty body is fine */ }
  const windowMinutes = Math.min(240, Math.max(5, Number(body?.window_minutes) || 60));
  const maxSignatures = Math.min(20, Math.max(3, Number(body?.max_signatures) || 8));

  let base44: any = null;
  try { base44 = createClientFromRequest(req); } catch (_) { /* no auth context */ }
  // Workflow-only function: must be an authenticated ADMIN (the scheduled
  // workflow calls as its creator, an app admin). Reads use asServiceRole.
  try {
    const user = await base44.auth.me();
    if (!user) return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
    const roles = Array.isArray(user?.app_roles) ? user.app_roles : [];
    if (user?.role !== 'admin' && !roles.includes('admin')) {
      return Response.json({ ok: false, error: 'forbidden' }, { status: 403 });
    }
  } catch (_) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const nowMs = Date.now();
  const cutoff = nowMs - windowMinutes * 60 * 1000;

  let rows: any[] = [];
  try {
    rows = await listAll(base44, 'RemoteLogEntry', '-created_date', 4000);
  } catch (err: any) {
    return Response.json({ ok: false, error: `log read failed: ${err?.message || err}` }, { status: 200 });
  }

  const inWindow = rows.filter((r) => {
    const ts = r?.created_date ? new Date(r.created_date).getTime() : 0;
    return ts && ts >= cutoff && ts <= nowMs + 60_000;
  });

  let errors = 0; let rateLimits = 0; let appStarts = 0; let other = 0;
  const groups = new Map<string, any>();
  const deviceNames = new Map<string, string>();
  try {
    const devices = await listAll(base44, 'UserDevice', '-updated_date', 500);
    devices.forEach((d: any) => {
      if (d?.device_identifier && d?.device_name && !deviceNames.has(String(d.device_identifier))) {
        deviceNames.set(String(d.device_identifier), String(d.device_name));
      }
    });
  } catch (_) { /* names optional */ }

  for (const row of inWindow) {
    const msg = String(row?.message || '');
    const isAppStart = row?.event_type === 'app_start' || /\[DEVICE_HEALTH\] app_start/.test(msg);
    if (FALLBACK_WARN_RX.test(msg)) { other++; continue; }
    const isRateLimit = !isAppStart && RATE_LIMIT_RX.test(msg);
    const isError = row?.level === 'error' && !isRateLimit && !isAppStart;
    if (isAppStart) { appStarts++; }
    else if (isRateLimit) { rateLimits++; }
    else if (isError) { errors++; }
    else { other++; continue; }

    const sig = signatureOf(msg);
    const ts = new Date(row.created_date).getTime();
    const key = sig || '<empty>';
    if (!groups.has(key)) {
      groups.set(key, {
        signature: key, count: 0, error_count: 0, rate_limit_count: 0, start_count: 0,
        sample: msg.slice(0, 300), devices: {}, users: {}, first_seen: row.created_date, last_seen: row.created_date,
        first_ms: ts, last_ms: ts,
      });
    }
    const g = groups.get(key);
    g.count++;
    if (isAppStart) g.start_count++;
    else if (isRateLimit) g.rate_limit_count++;
    else g.error_count++;
    if (ts < g.first_ms) { g.first_ms = ts; g.first_seen = row.created_date; }
    if (ts > g.last_ms) { g.last_ms = ts; g.last_seen = row.created_date; }
    const dev = String(row.device_identifier || 'unknown');
    const devLabel = deviceNames.get(dev) || dev;
    g.devices[devLabel] = (g.devices[devLabel] || 0) + 1;
    const user = String(row.user_name || row.user_id || 'unknown');
    g.users[user] = (g.users[user] || 0) + 1;
  }

  const signatures = Array.from(groups.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, maxSignatures)
    .map((g) => {
      const fmtDevices = Object.entries(g.devices as Record<string, number>)
        .sort((a, b) => b[1] - a[1]).slice(0, 4)
        .map(([name, hits]) => `${name} (${hits})`);
      const fmtUsers = Object.entries(g.users as Record<string, number>)
        .sort((a, b) => b[1] - a[1]).slice(0, 4)
        .map(([name, hits]) => `${name} (${hits})`);
      return {
        signature: g.signature,
        count: g.count,
        errors: g.error_count,
        rate_limits: g.rate_limit_count,
        app_starts: g.start_count,
        sample: g.sample,
        devices: fmtDevices,
        users: fmtUsers,
        first_seen: `${edmParts(g.first_seen).hm}`,
        last_seen: `${edmParts(g.last_seen).hm}`,
      };
    });

  const fromIso = new Date(cutoff).toISOString();
  const toIso = new Date(nowMs).toISOString();
  return Response.json({
    ok: true,
    window: {
      minutes: windowMinutes,
      from: `${edmParts(fromIso).md} ${edmParts(fromIso).hm}`,
      to: `${edmParts(toIso).md} ${edmParts(toIso).hm}`,
      from_time: edmParts(fromIso).hm,
      to_time: edmParts(toIso).hm,
    },
    totals: {
      log_rows: inWindow.length,
      errors, rate_limits: rateLimits, app_starts: appStarts, ignored: other,
      distinct_signatures: groups.size,
    },
    signatures,
  });
});
