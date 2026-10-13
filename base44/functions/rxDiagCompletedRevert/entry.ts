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
    const minutes = Math.min(Number(payload?.minutes) || 40, 180);
    const since = new Date(Date.now() - minutes * 60000).toISOString();

    const logRes = await base44.asServiceRole.entities.RemoteLogEntry.list('-created_date', 1500);
    const logs = (Array.isArray(logRes) ? logRes : (Array.isArray(logRes?.data) ? logRes.data : []))
      .map(unwrapEntityRecord).filter(Boolean);

    const pick = (re, n, len) => {
      const out = [];
      for (const l of logs) {
        if (out.length >= n) break;
        const at = String(l.created_date || '');
        if (at < since) continue;
        const msg = String(l.message || '');
        if (re.test(msg)) out.push({ at: at.slice(11, 19), dev: (l.metadata && (l.metadata.device_name || l.metadata.device_identifier)) || l.device_identifier || null, lvl: l.level || null, m: msg.slice(0, len) });
      }
      return out;
    };

    const syncFailed = pick(/Background sync failed|durable mutation retained|volume limit|429|rate.?limit/i, 10, 200);
    const boots = pick(/app_start|app restart|appRestart|PreBoundary/, 10, 150);
    const drains = pick(/drain|replay|pending mutation|pendingMutation/i, 8, 160);
    const completions = pick(/updateDeliveryLocal\] incoming[\s\S]{0,60}completed/, 8, 180);

    return Response.json({ since: since.slice(11, 19), sync_failed_n: syncFailed.length, sync_failed: syncFailed, boots_n: boots.length, boots, drains_n: drains.length, drains, completions_n: completions.length, completions });
  } catch (e) {
    return Response.json({ error: e?.message || String(e) });
  }
});
