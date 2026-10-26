import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const unwrap = (r) => {
  if (!r || typeof r !== 'object') return null;
  if (r.data && typeof r.data === 'object') return { ...r.data, id: r.data.id || r.id };
  return r;
};

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const since = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    const res = await base44.entities.RemoteLogEntry.list('-created_date', 3000);
    const rows = (Array.isArray(res) ? res : (Array.isArray(res?.data) ? res.data : []))
      .map(unwrap).filter(Boolean)
      .filter(r => String(r.created_date || '') >= since);

    const MARKERS = [
      'New-route optimization trigger', '[AddToRoute]', '[DoneLastStep]',
      '[RouteOptimization]', '[clientRouteEngine]', '[RouteCommitMarker]',
      'FUTURE route', 'polyline', 'ensureDefaultPickups', '[DeferredOptim]',
      'optimization'
    ];
    const hits = rows.filter(r => {
      const m = String(r.message || '');
      return MARKERS.some(k => m.includes(k));
    }).slice(0, 300).map(r => ({
      t: r.created_date, user: r.user_name || r.username || '', device: r.device_name || '',
      lvl: r.level || '', msg: String(r.message || '').slice(0, 300)
    }));

    return new Response(JSON.stringify({ since, totalScanned: rows.length, hits }, null, 1), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e?.message || e) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
});
