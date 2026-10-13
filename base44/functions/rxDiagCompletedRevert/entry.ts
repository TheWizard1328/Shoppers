import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const unwrapEntityRecord = (r) => {
  if (!r || typeof r !== 'object') return null;
  if (r.data && typeof r.data === 'object') return { ...r.data, id: r.data.id || r.id };
  return r;
};

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const res = await base44.asServiceRole.entities.Delivery.list('-updated_date', 500);
    const rows = (Array.isArray(res) ? res : (Array.isArray(res?.data) ? res.data : []))
      .map(unwrapEntityRecord).filter(Boolean);
    const reverted = rows.filter(d =>
      d.actual_delivery_time && !['completed', 'failed', 'cancelled'].includes(String(d.status || ''))
    ).map(d => ({ id: d.id, status: d.status, stop_order: d.stop_order, actual: d.actual_delivery_time, updated: d.updated_date }));

    const revertedIds = new Set(reverted.map(r => r.id));
    const logRes = await base44.asServiceRole.entities.RemoteLogEntry.list('-created_date', 3000);
    const logs = (Array.isArray(logRes) ? logRes : (Array.isArray(logRes?.data) ? logRes.data : []))
      .map(unwrapEntityRecord).filter(Boolean);
    const since = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
    const relevant = [];
    for (const l of logs) {
      if (String(l.created_date || '') < since) continue;
      const msg = String(l.message || '');
      for (const id of revertedIds) {
        if (msg.includes(id)) {
          relevant.push({ id: id.slice(-6), dev: (l.metadata && (l.metadata.device_name || l.metadata.device_identifier)) || l.device_identifier || null, at: String(l.created_date).slice(11, 19), m: msg.slice(0, 200) });
        }
      }
    }
    relevant.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    return Response.json({ reverted_count: reverted.length, reverted, logs: relevant.slice(-30) });
  } catch (e) {
    return Response.json({ error: e?.message || String(e) });
  }
});
