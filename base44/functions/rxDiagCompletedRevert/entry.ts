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
    const repair = payload?.repair === true;

    const res = await base44.asServiceRole.entities.Delivery.list('-updated_date', 500);
    const rows = (Array.isArray(res) ? res : (Array.isArray(res?.data) ? res.data : []))
      .map(unwrapEntityRecord).filter(Boolean);
    const reverted = rows.filter(d =>
      d.actual_delivery_time && !['completed', 'failed', 'cancelled'].includes(String(d.status || ''))
    );

    let repaired = [];
    if (repair) {
      for (const d of reverted) {
        try {
          await base44.asServiceRole.entities.Delivery.update(d.id, { status: 'completed', isNextDelivery: false });
          repaired.push(d.id);
        } catch (e) {
          repaired.push(`${d.id}:ERROR:${e?.message || e}`);
        }
      }
    }

    return Response.json({
      n: reverted.length,
      reverted: reverted.map(d => ({ id: d.id, tail: d.id.slice(-6), status: d.status, so: d.stop_order, actual: d.actual_delivery_time, up: d.updated_date, pid: !!d.patient_id })),
      repaired
    });
  } catch (e) {
    return Response.json({ error: e?.message || String(e) });
  }
});
