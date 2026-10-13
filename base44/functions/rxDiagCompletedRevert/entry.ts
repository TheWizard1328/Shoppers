import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const unwrapEntityRecord = (r) => {
  if (!r || typeof r !== 'object') return null;
  if (r.data && typeof r.data === 'object') return { ...r.data, id: r.data.id || r.id };
  return r;
};

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const today = new Date().toISOString().slice(0, 10);

    // 1. Find deliveries that LOOK completed (actual_delivery_time set) but whose
    //    status is active — the reverted records.
    const res = await base44.asServiceRole.entities.Delivery.list('-updated_date', 500);
    const rows = (Array.isArray(res) ? res : (Array.isArray(res?.data) ? res.data : []))
      .map(unwrapEntityRecord)
      .filter(Boolean);

    const reverted = rows.filter(d =>
      d.actual_delivery_time &&
      !['completed', 'failed', 'cancelled'].includes(String(d.status || ''))
    ).map(d => ({
      id: d.id,
      driver_id: d.driver_id,
      patient_id: d.patient_id,
      is_cycling_marker: !!d.is_cycling_marker,
      status: d.status,
      stop_order: d.stop_order,
      isNextDelivery: d.isNextDelivery,
      actual_delivery_time: d.actual_delivery_time,
      arrival_time: d.arrival_time,
      delivery_time_start: d.delivery_time_start,
      updated_date: d.updated_date,
      created_date: d.created_date,
      route_commit_at: d.route_commit_at || null,
      delivery_date: d.delivery_date
    })).slice(0, 25);

    // 2. Recent genuinely-completed stops today, for timeline comparison
    const completedToday = rows.filter(d =>
      d.status === 'completed' && String(d.actual_delivery_time || '').slice(0, 10) === today
    ).map(d => ({
      id: d.id, driver_id: d.driver_id, status: d.status,
      actual_delivery_time: d.actual_delivery_time, updated_date: d.updated_date,
      route_commit_at: d.route_commit_at || null
    })).slice(0, 15);

    // 3. Remote logs mentioning the reverted delivery ids — what wrote them, from which device
    const revertedIds = new Set(reverted.map(r => r.id));
    const logRes = await base44.asServiceRole.entities.RemoteLogEntry.list('-created_date', 3000);
    const logs = (Array.isArray(logRes) ? logRes : (Array.isArray(logRes?.data) ? logRes.data : []))
      .map(unwrapEntityRecord)
      .filter(Boolean);
    const since = new Date(Date.now() - 8 * 3600 * 1000).toISOString();
    const relevant = [];
    for (const l of logs) {
      if (String(l.created_date || '') < since) continue;
      const msg = String(l.message || '');
      for (const id of revertedIds) {
        if (msg.includes(id)) {
          relevant.push({
            delivery_id: id,
            device: (l.metadata && (l.metadata.device_name || l.metadata.device_identifier)) || l.device_identifier || null,
            level: l.level || null,
            at: l.created_date,
            message: msg.slice(0, 600)
          });
        }
      }
      if (relevant.length > 60) break;
    }
    relevant.sort((a, b) => String(a.at).localeCompare(String(b.at)));

    return Response.json({
      today,
      total_scanned: rows.length,
      reverted_count: reverted.length,
      reverted,
      completed_today: completedToday,
      logs_for_reverted: relevant.slice(-40)
    });
  } catch (e) {
    return Response.json({ error: e?.message || String(e) });
  }
});
