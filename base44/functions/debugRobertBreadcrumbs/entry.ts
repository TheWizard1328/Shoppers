/* global Deno */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const targetDate = body.delivery_date || '2026-07-22';

    // Find all breadcrumb records for the target date
    const crumbs = await base44.asServiceRole.entities.DeliveryBreadcrumbs.filter({
      delivery_date: targetDate
    });

    // Find AppUsers to resolve names
    const appUsers = await base44.asServiceRole.entities.AppUser.list();
    const userMap = {};
    for (const u of (appUsers || [])) {
      userMap[u.id] = u.full_name || u.name || u.email || u.id;
    }

    // Group by driver_id
    const byDriver = {};
    for (const r of (crumbs || [])) {
      const key = r.driver_id || 'unknown';
      if (!byDriver[key]) byDriver[key] = {
        driver_id: key,
        driver_name: userMap[key] || key,
        records: []
      };
      byDriver[key].records.push({
        id: r.id,
        stop_order: r.stop_order,
        point_count: r.point_count,
        polyline_len: r.encoded_polyline ? r.encoded_polyline.length : 0,
        ts_count: r.timestamps ? r.timestamps.split(',').length : 0,
        transport_mode: r.transport_mode,
      });
    }

    return Response.json({
      delivery_date: targetDate,
      total_records: (crumbs || []).length,
      drivers: Object.values(byDriver).map(d => ({
        driver_id: d.driver_id,
        driver_name: d.driver_name,
        record_count: d.records.length,
        records: d.records.sort((a, b) => Number(a.stop_order) - Number(b.stop_order)),
      })),
    });
  } catch (err) {
    return Response.json({ error: String(err?.message || err) }, { status: 500 });
  }
});
