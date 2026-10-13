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
    ).map(d => ({ id: d.id, tail: d.id.slice(-6), status: d.status, so: d.stop_order, actual: d.actual_delivery_time, up: d.updated_date, pid: !!d.patient_id, nxt: !!d.isNextDelivery, rca: d.route_commit_at || null }));
    const revertedIds = new Set(reverted.map(r => r.id));

    const logRes = await base44.asServiceRole.entities.RemoteLogEntry.list('-created_date', 3000);
    const logs = (Array.isArray(logRes) ? logRes : (Array.isArray(logRes?.data) ? logRes.data : []))
      .map(unwrapEntityRecord).filter(Boolean);
    // Only logs in the 3 minutes around each revert's updated_date
    const windows = reverted.map(r => ({ id: r.id, tail: r.tail, lo: new Date(new Date(r.up).getTime() - 100000).toISOString(), hi: new Date(new Date(r.up).getTime() + 30000).toISOString() }));
    const out = {};
    for (const w of windows) {
      out[w.tail] = [];
      for (const l of logs) {
        const at = String(l.created_date || '');
        if (at < w.lo || at > w.hi) continue;
        const msg = String(l.message || '');
        if (!msg.includes(w.id)) continue;
        out[w.tail].push({ at: at.slice(11, 19), dev: (l.metadata && (l.metadata.device_name || l.metadata.device_identifier)) || null, m: msg.slice(0, 150) });
      }
      out[w.tail].sort((a, b) => String(a.at).localeCompare(String(b.at)));
      if (out[w.tail].length > 22) out[w.tail] = out[w.tail].slice(0, 10).concat(out[w.tail].slice(-12));
    }
    return Response.json({ n: reverted.length, reverted, logs: out });
  } catch (e) {
    return Response.json({ error: e?.message || String(e) });
  }
});
