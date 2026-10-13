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
    const minutes = Math.min(Number(payload?.minutes) || 45, 120);

    const since = new Date(Date.now() - minutes * 60000).toISOString();

    const res = await base44.asServiceRole.entities.Delivery.list('-updated_date', 300);
    const rows = (Array.isArray(res) ? res : (Array.isArray(res?.data) ? res.data : []))
      .map(unwrapEntityRecord).filter(Boolean);
    const reverted = rows.filter(d =>
      d.actual_delivery_time && !['completed', 'failed', 'cancelled'].includes(String(d.status || ''))
    ).map(d => ({ tail: d.id.slice(-6), status: d.status, so: d.stop_order, actual: d.actual_delivery_time, up: d.updated_date, drv: d.driver_id?.slice(-6), pid: !!d.patient_id }));

    // Deliveries touched in the window — to see completions + post-completion rewrites
    const touched = rows.filter(d => String(d.updated_date || '') >= since)
      .map(d => ({ tail: d.id.slice(-6), status: d.status, so: d.stop_order, up: String(d.updated_date).slice(11, 19), actual: d.actual_delivery_time ? String(d.actual_delivery_time).slice(11, 19) : null, drv: d.driver_id?.slice(-6), nxt: !!d.isNextDelivery }))
      .slice(0, 40);

    const logRes = await base44.asServiceRole.entities.RemoteLogEntry.list('-created_date', 1200);
    const logs = (Array.isArray(logRes) ? logRes : (Array.isArray(logRes?.data) ? logRes.data : []))
      .map(unwrapEntityRecord).filter(Boolean);

    // Signature scan: what patterns fired in the window
    const patterns = [
      ['revert_stomp', /revert a terminal|IDB override|dropped \d+ update/],
      ['completion', /updateDeliveryLocal\] incoming[\s\S]{0,80}status.{0,3}completed/],
      ['boot_app_start', /app_start|app restart|appRestart/],
      ['restoring', /Restoring|cloud load|cloudLoad|12s wait|initial cloud/],
      ['sync_failed', /Background sync failed|durable mutation retained|volume limit|429|rate.?limit/i],
      ['route_commit', /route_commit_at|RouteCommit|marker broadcast/],
      ['queue_drain', /drain|replay|pending mutation|pendingMutation/i],
      ['start_flow', /Start fast path|start_button|handleStartDelivery|Start full/]
    ];
    const counts = {};
    const samples = {};
    for (const l of logs) {
      const at = String(l.created_date || '');
      if (at < since) continue;
      const msg = String(l.message || '');
      for (const [name, re] of patterns) {
        if (re.test(msg)) {
          counts[name] = (counts[name] || 0) + 1;
          if (!samples[name] || samples[name].length < 8) {
            (samples[name] = samples[name] || []).push({
              at: at.slice(11, 19), dev: (l.metadata && (l.metadata.device_name || l.metadata.device_identifier)) || l.device_identifier || null, m: msg.slice(0, 130)
            });
          }
        }
      }
    }

    return Response.json({ window_min: minutes, since: since.slice(11, 19), n_reverted: reverted.length, reverted, touched, counts, samples });
  } catch (e) {
    return Response.json({ error: e?.message || String(e) });
  }
});
