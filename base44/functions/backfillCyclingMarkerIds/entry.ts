import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Forbidden' }, { status: 403 });

    const allMarkers = await base44.asServiceRole.entities.Delivery.filter({ is_cycling_marker: true });

    const generateBikId = (existingIds: Set<string>): string => {
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
      let id = '';
      do {
        const ts = Date.now().toString();
        const rand = Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
        id = `BIK-${ts}-${rand}`;
      } while (existingIds.has(id));
      return id;
    };

    const existingBikIds = new Set<string>(
      (allMarkers || []).map((d: any) => d.delivery_id).filter((id: any) => id && id.startsWith('BIK-'))
    );

    // Helper: derive ampm from a timestamp string (local hour < 14 = AM, >= 14 = PM)
    const ampmFromTimestamp = (ts: string | null | undefined): 'AM' | 'PM' | null => {
      if (!ts) return null;
      try {
        const d = new Date(ts);
        if (isNaN(d.getTime())) return null;
        // Use Edmonton local time (UTC-6 or UTC-7 depending on DST)
        const localHour = new Date(ts).toLocaleString('en-CA', {
          timeZone: 'America/Edmonton',
          hour: 'numeric',
          hour12: false,
        });
        return parseInt(localHour, 10) < 14 ? 'AM' : 'PM';
      } catch {
        return null;
      }
    };

    // Group markers into pairs by driver+date, sorted by stop_order
    const grouped = new Map<string, { starts: any[]; ends: any[] }>();
    for (const m of allMarkers || []) {
      const key = `${m.driver_id}|${m.delivery_date}`;
      if (!grouped.has(key)) grouped.set(key, { starts: [], ends: [] });
      const isStart = (m.delivery_notes || '').toLowerCase().includes('start');
      if (isStart) grouped.get(key)!.starts.push(m);
      else grouped.get(key)!.ends.push(m);
    }
    grouped.forEach(({ starts, ends }) => {
      starts.sort((a: any, b: any) => (Number(a.stop_order) || 0) - (Number(b.stop_order) || 0));
      ends.sort((a: any, b: any) => (Number(a.stop_order) || 0) - (Number(b.stop_order) || 0));
    });

    const updates: Promise<any>[] = [];
    let updatedCount = 0;
    let failedCount = 0;

    for (const [, { starts, ends }] of grouped) {
      starts.forEach((start: any, i: number) => {
        const end = ends[i] || null;

        // Determine ampm from the Start marker's actual_delivery_time (or created_date as fallback)
        const ampm = ampmFromTimestamp(start.actual_delivery_time) ||
                     ampmFromTimestamp(start.created_date) ||
                     'AM';

        // Build update for Start marker
        const startPatch: Record<string, any> = { ampm_deliveries: ampm };
        if (!start.delivery_id || !start.delivery_id.startsWith('BIK-')) {
          startPatch.delivery_id = generateBikId(existingBikIds);
          existingBikIds.add(startPatch.delivery_id);
        }

        updates.push(
          base44.asServiceRole.entities.Delivery.update(start.id, startPatch)
            .then(() => { updatedCount++; return { id: start.id, success: true, patch: startPatch }; })
            .catch((e: any) => { failedCount++; return { id: start.id, success: false, error: e?.message }; })
        );

        // Build update for End marker (same ampm as its paired Start)
        if (end) {
          const endPatch: Record<string, any> = { ampm_deliveries: ampm };
          if (!end.delivery_id || !end.delivery_id.startsWith('BIK-')) {
            endPatch.delivery_id = generateBikId(existingBikIds);
            existingBikIds.add(endPatch.delivery_id);
          }
          updates.push(
            base44.asServiceRole.entities.Delivery.update(end.id, endPatch)
              .then(() => { updatedCount++; return { id: end.id, success: true, patch: endPatch }; })
              .catch((e: any) => { failedCount++; return { id: end.id, success: false, error: e?.message }; })
          );
        }
      });
    }

    const results = await Promise.all(updates);

    return Response.json({
      total_markers: (allMarkers || []).length,
      updated: updatedCount,
      failed: failedCount,
      message: `Backfilled ${updatedCount} cycling markers (BIK IDs + ampm_deliveries).`,
      results,
    });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});