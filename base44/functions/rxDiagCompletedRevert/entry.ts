import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const probe = {};
    try {
      const since = new Date(Date.now() - 3600_000).toISOString();
      const r = await base44.asServiceRole.entities.Delivery.filter({ updated_date: { $gte: since } }, '-updated_date', 5);
      probe.gte = { ok: true, n: Array.isArray(r) ? r.length : -1, first: r?.[0]?.updated_date || null };
    } catch (e) { probe.gte = { ok: false, err: String(e?.message || e).slice(0, 180) }; }
    try {
      const r2 = await base44.asServiceRole.entities.Delivery.filter({ delivery_date: { $gte: '2026-10-14', $lte: '2026-10-20' } }, 'delivery_date', 5);
      probe.range = { ok: true, n: Array.isArray(r2) ? r2.length : -1, dates: (r2 || []).map(d => d.delivery_date).slice(0, 3) };
    } catch (e) { probe.range = { ok: false, err: String(e?.message || e).slice(0, 180) }; }
    return Response.json({ probe });
  } catch (e) {
    return Response.json({ error: e?.message || String(e) });
  }
});
